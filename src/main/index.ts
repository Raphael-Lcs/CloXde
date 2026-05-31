import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initStorage, closeStorage } from './storage/db'
import { registerIpcHandlers } from './ipc'
import { conversationEngine } from './conversation/engine'
import { startScheduler, stopScheduler } from './conversation/scheduler'
import { stopAllWatches } from './fs/inspector'
import { startHttpServer, stopHttpServer } from './server/http-server'

const APP_PROTOCOL = 'cloxde'

// Tray-resident lifecycle: closing the main window hides it instead of
// quitting, so the LAN server keeps running for the pad. Quit only happens
// when the user picks "退出" from the tray menu, which flips this flag.
let isQuitting = false
let tray: Tray | null = null
// Argv flag set by the auto-launch login-item entry — when present we keep
// the window hidden on boot so the user isn't slapped with a window every
// login. They can pop it from the tray.
const startedHidden = process.argv.includes('--hidden')

/**
 * Parse a `cloxde://...` URL into a deep-link directive the renderer can
 * act on. Routes:
 *   • cloxde://project/{pid}                            → open project
 *   • cloxde://project/{pid}/conversation/{cid}         → open project + conv
 *   • cloxde://project/{pid}/conversation/{cid}/fork    → new conv inheriting cid
 *
 * Returns null when the URL doesn't match any known shape — the caller
 * should ignore it (we never raw-forward unknown URLs).
 */
type DeepLink =
  | { action: 'open-project'; projectId: string }
  | { action: 'open-conversation'; projectId: string; conversationId: string }
  | { action: 'fork-conversation'; projectId: string; parentId: string }

function parseDeepLink(rawUrl: string): DeepLink | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_PROTOCOL}:`) return null
  // url.hostname is empty for `cloxde://x` but populated for `cloxde://x/y`.
  // We model the whole path uniformly by stitching them back together.
  const segs = [url.hostname, ...url.pathname.split('/').filter(Boolean)]
    .filter(Boolean)
    .map(decodeURIComponent)
  // ['project', pid] | ['project', pid, 'conversation', cid] | + 'fork'
  if (segs[0] === 'project' && segs[1]) {
    const projectId = segs[1]
    if (segs[2] === 'conversation' && segs[3]) {
      if (segs[4] === 'fork') {
        return { action: 'fork-conversation', projectId, parentId: segs[3] }
      }
      return { action: 'open-conversation', projectId, conversationId: segs[3] }
    }
    return { action: 'open-project', projectId }
  }
  return null
}

/** Push a parsed deep-link to the renderer via the existing message bus.
 *  No-op if no window is open yet — callers should buffer pre-window links. */
let pendingDeepLink: DeepLink | null = null
function dispatchDeepLink(link: DeepLink): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) {
    pendingDeepLink = link
    return
  }
  win.webContents.send('deeplink', link)
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

function resolveIconPath(): string | undefined {
  // In dev, __dirname is .../out/main, so resources/ is two levels up.
  // In a packaged build, resources are placed next to the executable.
  const candidates = [
    join(__dirname, '..', '..', 'resources', 'icon-256.png'),
    join(process.resourcesPath ?? '', 'icon-256.png')
  ]
  return candidates.find((p) => p && existsSync(p))
}

function showOrCreateWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
    return
  }
  createWindow()
}

function setupTray(): void {
  if (tray) return
  const iconPath = resolveIconPath()
  // Tray APIs accept a path string but on Windows the high-res 256px PNG
  // can render fuzzy in the notification area. Resize via nativeImage so
  // the icon stays crisp. macOS templates are out of scope here — we ship
  // the same brandmark.
  const image = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('CloXde')
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showOrCreateWindow()
    },
    { type: 'separator' },
    {
      label: '退出 CloXde',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showOrCreateWindow())
  tray.on('double-click', () => showOrCreateWindow())
}

function configureAutoLaunch(): void {
  // Match Codex/Claude desktop: launch on Windows login, hidden, so the LAN
  // server is up for the pad before the user touches anything. Skipped in
  // dev because we don't want every `pnpm dev` run to register the app.
  if (process.platform !== 'win32' || !app.isPackaged) return
  const exe = process.execPath
  app.setLoginItemSettings({
    openAtLogin: true,
    path: exe,
    args: ['--hidden']
  })
}

function createWindow(): BrowserWindow {
  const iconPath = resolveIconPath()
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'CloXde',
    backgroundColor: '#19191c',
    ...(iconPath ? { icon: iconPath } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? { color: '#19191c', symbolColor: '#ececef', height: 38 }
        : undefined,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => {
    if (!startedHidden) win.show()
  })

  // Close → hide-to-tray. Quit only when the tray menu set isQuitting.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.cloxde.app')
  }

  // Register the cloxde:// custom protocol. On Windows this requires a
  // single-instance lock + reading argv on `second-instance` (the OS
  // launches a new process when a link is opened); on macOS it's
  // delivered via `open-url`.
  if (!app.isDefaultProtocolClient(APP_PROTOCOL)) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL)
  }

  initStorage()
  registerIpcHandlers()

  // Timed automation: the scheduler injects canned prompts into existing
  // conversations on a cadence (same path as a user message → PM).
  startScheduler((conversationId, text) =>
    conversationEngine.sendUserMessage(conversationId, text)
  )

  // Start the LAN HTTP+WS companion server so the Android tablet App can
  // talk to this desktop instance. The port is configurable via env so power
  // users can avoid collisions; default 7878.
  const port = Number(process.env.CLOXDE_LAN_PORT) || 7878
  try {
    startHttpServer(port)
  } catch (e) {
    console.error('[server] failed to start:', e)
  }

  setupTray()
  configureAutoLaunch()

  const win = createWindow()

  // If a deep link arrived before the window existed, fire it now that
  // the renderer is loading. We still need to wait for did-finish-load
  // to ensure the renderer subscription is wired up.
  win.webContents.once('did-finish-load', () => {
    if (pendingDeepLink) {
      dispatchDeepLink(pendingDeepLink)
      pendingDeepLink = null
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showOrCreateWindow()
  })
})

// Single-instance: when the user clicks a cloxde:// link, Windows launches
// a fresh CloXde.exe with the URL in argv. We catch that here, route it to
// the already-running instance, and quit the second one.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const urlArg = argv.find((a) => a.startsWith(`${APP_PROTOCOL}://`))
    if (urlArg) {
      const link = parseDeepLink(urlArg)
      if (link) dispatchDeepLink(link)
    }
    showOrCreateWindow()
  })
}

// macOS: deep links come through this event, not via argv.
app.on('open-url', (event, rawUrl) => {
  event.preventDefault()
  const link = parseDeepLink(rawUrl)
  if (link) dispatchDeepLink(link)
})

app.on('window-all-closed', () => {
  // Intentionally do not quit. The tray keeps the app + LAN server alive
  // so the pad can stay connected even after the user closes the window.
  // The user quits explicitly via the tray menu (which sets isQuitting).
})

app.on('before-quit', () => {
  // Mark quitting so the window's close listener stops swallowing the event
  // and lets the window actually close. Covers Cmd+Q on macOS, programmatic
  // app.quit() calls, and OS shutdown.
  isQuitting = true
  void conversationEngine.disposeAll()
  stopScheduler()
  stopAllWatches()
  void stopHttpServer()
  closeStorage()
})
