// HTTP + WebSocket server for the LAN companion (Android tablet App).
//
// Architecture:
//   • Express handles REST endpoints — every IPC handler in `ipc.ts` gets a
//      mirror here. The repos / engine are imported directly so we don't
//      duplicate business logic.
//   • A single ws.Server is upgraded onto the same HTTP server so the tablet
//      only needs to keep one socket open. We push the same engine events
//      (conversation:updated, message:appended, message:patched, fs:changed)
//      that the renderer already listens to via IPC.
//   • Auth: every protected route requires `Authorization: Bearer <token>`.
//      Pairing happens via /api/pair with the desktop-shown PIN.
//
// Lifecycle is owned by the main process: `startHttpServer` is called from
// `index.ts` once after `initStorage`, and `stopHttpServer` from
// `before-quit`.

import { createServer, type Server } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  AgentKind,
  AgentProfile,
  Conversation,
  ConversationView,
  DirEntry,
  IpcResult,
  Message,
  Project,
  Side
} from '@shared/types'
import {
  conversationRepo,
  getDb,
  messageRepo,
  profileRepo,
  projectRepo
} from '../storage/db'
import { conversationEngine } from '../conversation/engine'
import { buildInheritedSummary } from '../conversation/summarizer'
import {
  ensureWatch,
  listDir,
  listProjectFiles,
  openPath,
  readFilePreview,
  stopWatch
} from '../fs/inspector'
import {
  attemptPair,
  getPin,
  getTokenLabel,
  issueToken,
  listTokens,
  revokeAll,
  revokeToken,
  rotatePin,
  verifyToken
} from './auth'
import { listLanAddresses, primaryLanAddress } from './net'
import { presence, type ActivityKind } from './presence'

const DEFAULT_PORT = 7878

// Attachment guards for the LAN message endpoint. Base64 inflates ~33%, so a
// ~6MB base64 string is ~4.5MB of image bytes — in line with the inspector's
// 4MB inline-image cap. Bounding count + per-item size stops a paired device
// from pushing an arbitrarily large payload into memory per request.
const MAX_ATTACHMENTS = 6
const MAX_ATTACHMENT_B64_LEN = 6 * 1024 * 1024

interface ServerHandle {
  http: Server
  wss: WebSocketServer
  port: number
}

let handle: ServerHandle | null = null
/** Open WS clients (already-authenticated). Used to fan out engine events. */
const liveSockets = new Set<WebSocket>()

// --- Helper builders -------------------------------------------------------

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function err(message: string): IpcResult<never> {
  return { ok: false, error: message }
}

function isAgentKind(v: unknown): v is AgentKind {
  return v === 'claude' || v === 'codex' || v === 'hermes'
}
function isSide(v: unknown): v is Side {
  return v === 'architect' || v === 'executor'
}

function buildConversationView(conversationId: string): ConversationView | null {
  return conversationEngine.snapshot(conversationId)
}

/** Push a frame to every connected WS client. Exported so the desktop IPC
 *  side can also drive presence + future cross-channel events through the
 *  same fan-out path the LAN routes use. Safe to call before the server is
 *  started (no-op while liveSockets is empty). */
export function broadcastWs(event: string, payload: unknown): void {
  const frame = JSON.stringify({ type: event, payload })
  for (const ws of liveSockets) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(frame)
      } catch {
        // ignore — onclose will clean up
      }
    }
  }
}

// --- Auth middleware -------------------------------------------------------

function extractToken(req: Request): string | null {
  // Header: Authorization: Bearer <token>
  const auth = req.header('authorization') ?? req.header('Authorization')
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  // Query string fallback (mostly for WS upgrade in browsers that can't set
  // headers): ?token=...
  const q = req.query.token
  if (typeof q === 'string') return q
  return null
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const t = extractToken(req)
  if (!t || !verifyToken(t)) {
    res.status(401).json(err('unauthorized'))
    return
  }
  // Stash the device label so route handlers can record presence without
  // re-parsing the token. Tablet's `label` was set at pair time.
  ;(req as Request & { tabletLabel?: string }).tabletLabel =
    getTokenLabel(t) ?? 'tablet'
  next()
}

/** Record presence + broadcast it to ALL clients (including the originator
 *  — UI uses kind to disambiguate "I just did this" from "they did this"). */
function recordPresence(
  req: Request,
  conversationId: string,
  kind: ActivityKind
): void {
  const label = (req as Request & { tabletLabel?: string }).tabletLabel ?? 'tablet'
  const rec = presence.record(conversationId, { kind: 'tablet', label }, kind)
  broadcastWs('presence:activity', rec)
}

// --- Server bootstrap ------------------------------------------------------

export function startHttpServer(port = DEFAULT_PORT): ServerHandle {
  if (handle) return handle

  const app = express()
  app.use(express.json({ limit: '20mb' }))
  // No CORS middleware: the only intended clients are the native RN tablet
  // app (which doesn't enforce CORS) and the desktop renderer (which talks
  // over IPC, not HTTP). Leaving CORS wide-open would let any malicious web
  // page on the LAN read authenticated API responses cross-origin.

  // ----- Public routes (no auth) ----------------------------------------

  app.get('/api/info', (_req, res) => {
    res.json(
      ok({
        name: 'CloXde',
        version: process.env.npm_package_version ?? '0.6.0',
        addresses: listLanAddresses(),
        primary: primaryLanAddress(),
        port
      })
    )
  })

  // Pair: POST { pin, label } → { token }
  app.post('/api/pair', (req, res) => {
    const pin = String(req.body?.pin ?? '')
    const label = String(req.body?.label ?? 'tablet')
    const attempt = attemptPair(pin)
    if (!attempt.ok) {
      if (attempt.retryAfterMs) {
        res.setHeader('Retry-After', Math.ceil(attempt.retryAfterMs / 1000))
        res
          .status(429)
          .json(err('配对尝试过于频繁，请稍后再试'))
        return
      }
      res.status(403).json(err('invalid pin'))
      return
    }
    const token = issueToken(label)
    res.json(ok({ token, label }))
  })

  // Cheap health check the tablet uses before showing the pair screen.
  app.get('/api/ping', (_req, res) => res.json(ok('pong')))

  // ----- Protected routes ------------------------------------------------

  const r = express.Router()
  r.use(requireAuth)

  // App
  r.get('/app/version', (_req, res) => res.json(ok(process.env.npm_package_version ?? '0.6.0')))

  // Auth admin (paired-device list / revoke)
  r.get('/auth/devices', (_req, res) => res.json(ok(listTokens())))
  r.post('/auth/revoke', (req, res) => {
    const token = String(req.body?.token ?? '')
    revokeToken(token)
    res.json(ok(true))
  })
  r.post('/auth/revoke-all', (_req, res) => {
    revokeAll()
    res.json(ok(true))
  })
  r.post('/auth/rotate-pin', (_req, res) => res.json(ok(rotatePin())))

  // Projects ---------------------------------------------------------------
  r.get('/projects', (_req, res) => res.json(ok<Project[]>(projectRepo.list())))
  r.get('/projects/archived', (_req, res) =>
    res.json(ok<Project[]>(projectRepo.listArchived()))
  )

  r.post('/projects', (req, res) => {
    const rootDir = String(req.body?.rootDir ?? '')
    if (!rootDir) {
      res.json(err('invalid rootDir'))
      return
    }
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
      res.json(err(`不是一个文件夹：${rootDir}`))
      return
    }
    const project = projectRepo.upsertByRoot({
      name: basename(rootDir) || rootDir,
      rootDir
    })
    profileRepo.ensureDefaults(project.id)
    res.json(ok(project))
  })

  r.post('/projects/:id/open', (req, res) => {
    projectRepo.touch(req.params.id)
    profileRepo.ensureDefaults(req.params.id)
    res.json(ok(true))
  })

  r.post('/projects/:id/archive', (req, res) => {
    const id = req.params.id
    const proj = projectRepo.get(id)
    if (!proj) {
      res.json(err(`项目不存在：${id}`))
      return
    }
    if (proj.archivedAt) {
      res.json(ok(true))
      return
    }
    if (conversationRepo.hasThinkingInProject(id)) {
      res.json(err('该项目下还有正在运行的会话，先暂停或等它结束再归档。'))
      return
    }
    const ts = Date.now()
    conversationRepo.archiveAllByProject(id, ts)
    projectRepo.archive(id)
    getDb().prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(ts, id)
    stopWatch(id)
    res.json(ok(true))
  })

  r.post('/projects/:id/unarchive', (req, res) => {
    const id = req.params.id
    const proj = projectRepo.get(id)
    if (!proj) {
      res.json(err(`项目不存在：${id}`))
      return
    }
    if (!proj.archivedAt) {
      res.json(ok(true))
      return
    }
    conversationRepo.unarchiveAllByProjectAt(id, proj.archivedAt)
    projectRepo.unarchive(id)
    res.json(ok(true))
  })

  r.delete('/projects/:id', (req, res) => {
    projectRepo.delete(req.params.id)
    stopWatch(req.params.id)
    res.json(ok(true))
  })

  // Agent profiles ---------------------------------------------------------
  r.get('/projects/:id/profiles', (req, res) => {
    profileRepo.ensureDefaults(req.params.id)
    res.json(ok<AgentProfile[]>(profileRepo.listByProject(req.params.id)))
  })

  r.put('/profiles', (req, res) => {
    const i = req.body as {
      projectId?: string
      kind?: AgentKind
      name?: string
      command?: string | null
      args?: string[]
      env?: Record<string, string>
    }
    if (!i || typeof i.projectId !== 'string' || !isAgentKind(i.kind)) {
      res.json(err('invalid profile payload'))
      return
    }
    res.json(
      ok(
        profileRepo.upsert({
          projectId: i.projectId,
          kind: i.kind,
          name: i.name,
          command: i.command,
          args: i.args,
          env: i.env
        })
      )
    )
  })

  // Conversations ----------------------------------------------------------
  r.get('/projects/:id/conversations', (req, res) =>
    res.json(ok<Conversation[]>(conversationRepo.listByProject(req.params.id)))
  )

  r.get('/projects/:id/conversations/archived', (req, res) =>
    res.json(ok<Conversation[]>(conversationRepo.listArchivedByProject(req.params.id)))
  )

  r.post('/conversations', (req, res) => {
    const i = req.body as {
      projectId?: string
      title?: string
      withPm?: boolean
      pmKind?: AgentKind
      architectKind?: AgentKind
      executorKind?: AgentKind
      parentIds?: string[]
      summaryOverride?: string
    }
    if (!i || typeof i.projectId !== 'string') {
      res.json(err('invalid input'))
      return
    }
    const project = projectRepo.get(i.projectId)
    if (!project) {
      res.json(err(`项目不存在：${i.projectId}`))
      return
    }
    profileRepo.ensureDefaults(project.id)
    const architectKind = isAgentKind(i.architectKind)
      ? i.architectKind
      : project.defaultArchitect
    const executorKind = isAgentKind(i.executorKind)
      ? i.executorKind
      : project.defaultExecutor
    const architect = profileRepo.findByKind(project.id, architectKind)
    const executor = profileRepo.findByKind(project.id, executorKind)
    if (!architect || !executor) {
      res.json(err('agent profile 缺失'))
      return
    }
    const withPm = i.withPm !== false
    let pmProfileId: string | undefined
    if (withPm) {
      const defaultPmKind: AgentKind = 'claude'
      const pmKind = isAgentKind(i.pmKind) ? i.pmKind : defaultPmKind
      const pm = profileRepo.findByKind(project.id, pmKind)
      if (!pm) {
        res.json(err('PM profile 缺失'))
        return
      }
      pmProfileId = pm.id
    }

    const requestedParents = Array.isArray(i.parentIds) ? i.parentIds : []
    const validParentIds = requestedParents.filter((pid) => {
      if (typeof pid !== 'string') return false
      const parent = conversationRepo.get(pid)
      return !!parent && parent.projectId === project.id
    })

    let inheritedSummary: string | undefined
    if (validParentIds.length > 0) {
      if (typeof i.summaryOverride === 'string' && i.summaryOverride.trim()) {
        inheritedSummary = i.summaryOverride.trim()
      } else {
        inheritedSummary = buildInheritedSummary(validParentIds) || undefined
      }
    }

    const conv = conversationRepo.create({
      projectId: project.id,
      title: i.title,
      pmProfileId,
      architectProfileId: architect.id,
      executorProfileId: executor.id,
      primarySide: 'architect',
      autopilot: true,
      parentIds: validParentIds,
      inheritedSummary
    })

    if (inheritedSummary) {
      messageRepo.create({
        conversationId: conv.id,
        side: 'system',
        role: 'system',
        blocks: [{ type: 'text', text: inheritedSummary }],
        ts: conv.createdAt - 1
      })
    }

    const view = buildConversationView(conv.id)
    if (!view) {
      res.json(err('failed to build conversation view'))
      return
    }
    res.json(ok(view))
  })

  r.post('/conversations/preview-summary', (req, res) => {
    const parentIds = req.body?.parentIds
    if (!Array.isArray(parentIds)) {
      res.json(err('invalid parentIds'))
      return
    }
    const ids = parentIds.filter((p): p is string => typeof p === 'string')
    res.json(ok(buildInheritedSummary(ids)))
  })

  r.get('/conversations/:id', (req, res) => {
    // Optional pagination so long conversations don't blow up the wire on
    // every fetch. `limit` clamps to the most recent N messages; `before`
    // (ms timestamp) filters out anything at-or-after that timestamp, so
    // the client can ask for "another 30 messages older than my earliest".
    // Both default off → backwards-compatible (callers get the full set).
    const view = buildConversationView(req.params.id)
    if (!view) return res.json(ok<ConversationView | null>(null))
    const limit = Number(req.query.limit)
    const before = Number(req.query.before)
    let msgs = view.messages
    if (Number.isFinite(before)) msgs = msgs.filter((m) => m.ts < before)
    if (Number.isFinite(limit) && limit > 0) msgs = msgs.slice(-limit)
    res.json(ok<ConversationView | null>({ ...view, messages: msgs }))
  })

  r.delete('/conversations/:id', (req, res) => {
    const id = req.params.id
    conversationRepo.delete(id)
    void conversationEngine
      .dispose(id)
      .catch((e) => console.error('[delete] dispose failed for', id, e))
    recordPresence(req, id, 'delete')
    res.json(ok(true))
  })

  r.post('/conversations/:id/archive', (req, res) => {
    const id = req.params.id
    conversationRepo.archive(id)
    void conversationEngine
      .dispose(id)
      .catch((e) => console.error('[archive] dispose failed for', id, e))
    recordPresence(req, id, 'archive')
    res.json(ok(true))
  })

  r.post('/conversations/:id/unarchive', (req, res) => {
    conversationRepo.unarchive(req.params.id)
    recordPresence(req, req.params.id, 'unarchive')
    res.json(ok(true))
  })

  r.post('/conversations/:id/messages', async (req, res) => {
    const text = String(req.body?.text ?? '')
    const target = req.body?.target
    const attachments = req.body?.attachments
    const cleanAttachments: { data: string; mimeType: string }[] = []
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (
          a &&
          typeof a === 'object' &&
          typeof (a as { data?: unknown }).data === 'string' &&
          typeof (a as { mimeType?: unknown }).mimeType === 'string'
        ) {
          const data = (a as { data: string }).data
          if (data.length > MAX_ATTACHMENT_B64_LEN) {
            res.json(err('附件过大'))
            return
          }
          cleanAttachments.push({
            data,
            mimeType: (a as { mimeType: string }).mimeType
          })
          if (cleanAttachments.length > MAX_ATTACHMENTS) {
            res.json(err(`附件数量超过上限（${MAX_ATTACHMENTS}）`))
            return
          }
        }
      }
    }
    if (!text.trim() && cleanAttachments.length === 0) {
      res.json(err('empty message'))
      return
    }
    const side = isSide(target) ? target : undefined
    try {
      await conversationEngine.sendUserMessage(req.params.id, text, side, cleanAttachments)
      recordPresence(req, req.params.id, 'send-message')
      res.json(ok(true))
    } catch (e) {
      res.json(err((e as Error).message))
    }
  })

  r.post('/conversations/:id/cancel', async (req, res) => {
    await conversationEngine.cancel(req.params.id)
    recordPresence(req, req.params.id, 'cancel')
    res.json(ok(true))
  })

  r.post('/conversations/:id/autopilot', async (req, res) => {
    const value = req.body?.value
    if (typeof value !== 'boolean') {
      res.json(err('invalid value'))
      return
    }
    await conversationEngine.setAutopilot(req.params.id, value)
    recordPresence(req, req.params.id, 'autopilot')
    res.json(ok(true))
  })

  r.post('/conversations/:id/primary-side', async (req, res) => {
    const side = req.body?.side
    if (!isSide(side)) {
      res.json(err('invalid side'))
      return
    }
    await conversationEngine.setPrimarySide(req.params.id, side)
    recordPresence(req, req.params.id, 'primary-side')
    res.json(ok(true))
  })

  // Filesystem inspector ---------------------------------------------------
  r.get('/projects/:id/fs', async (req, res) => {
    const project = projectRepo.get(req.params.id)
    if (!project) {
      res.json(err('project not found'))
      return
    }
    const relPath = String(req.query.path ?? '')
    ensureWatch(project.id, project.rootDir, () => {
      broadcastWs('fs:changed', { projectId: project.id })
    })
    const result = await listDir(project, relPath)
    res.json(result)
  })

  r.get('/projects/:id/fs/files', async (req, res) => {
    const project = projectRepo.get(req.params.id)
    if (!project) {
      res.json(err('project not found'))
      return
    }
    const result = await listProjectFiles(project)
    res.json(result)
  })

  r.post('/projects/:id/fs/open', async (req, res) => {
    const project = projectRepo.get(req.params.id)
    if (!project) {
      res.json(err('project not found'))
      return
    }
    const relPath = String(req.body?.path ?? '')
    const result = await openPath(project, relPath)
    res.json(result)
  })

  // In-app file preview — tablets call this instead of fs/open so files are
  // viewed on the device the user is holding, not yanked onto the desktop.
  r.get('/projects/:id/fs/read', async (req, res) => {
    const project = projectRepo.get(req.params.id)
    if (!project) {
      res.json(err('project not found'))
      return
    }
    const relPath = String(req.query.path ?? '')
    const result = await readFilePreview(project, relPath)
    res.json(result)
  })

  // Presence snapshot — used by clients on (re)connect to populate the
  // banner without waiting for the next activity broadcast.
  r.get('/presence', (_req, res) => {
    res.json(ok(presence.snapshot()))
  })

  app.use('/api', r)

  // ----- Engine event → WS bridge ---------------------------------------

  conversationEngine.on('conversation-updated', (view: ConversationView) => {
    // Strip the messages array from the broadcast — clients receive
    // message-level deltas via message:appended / message:patched events,
    // so re-shipping the full message set on every status / busySide tick
    // is wasted bandwidth. For a long conversation the snapshot is multi-MB
    // and parsing it ~10× per second on the tablet hangs the JS thread to
    // the point where the chat surface won't render. We keep all other
    // fields (status, busySide, autopilot, activeTask, etc.) — those are
    // exactly what conversation:updated is for.
    const { messages: _omit, ...lite } = view
    broadcastWs('conversation:updated', { ...lite, messages: [] })
  })
  conversationEngine.on(
    'message-appended',
    (payload: { conversationId: string; message: Message }) => {
      broadcastWs('message:appended', payload)
    }
  )
  conversationEngine.on(
    'message-patched',
    (payload: { conversationId: string; messageId: string; patch: Partial<Message> }) => {
      broadcastWs('message:patched', payload)
    }
  )

  // ----- HTTP + WS plumbing ---------------------------------------------

  const http = createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  http.on('upgrade', (req, socket, head) => {
    // We only handle one path so route filtering is trivial.
    const url = req.url ?? ''
    if (!url.startsWith('/ws')) {
      socket.destroy()
      return
    }
    // Token can come from ?token= or from a custom header. Browsers can't
    // set headers on the upgrade so query-string is the realistic channel.
    const token =
      new URL(url, 'http://localhost').searchParams.get('token') ??
      req.headers['x-auth-token']
    if (typeof token !== 'string' || !verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      liveSockets.add(ws)
      // Heartbeat — kill dead sockets so we don't leak refs.
      let alive = true
      ws.on('pong', () => {
        alive = true
      })
      const ping = setInterval(() => {
        if (!alive) {
          try {
            ws.terminate()
          } catch {
            /* ignore */
          }
          return
        }
        alive = false
        try {
          ws.ping()
        } catch {
          /* ignore */
        }
      }, 30_000)
      // Single teardown path for both close and error so the heartbeat timer
      // is always cleared — an errored-but-not-closed socket used to leak the
      // 30s interval (and the socket ref) indefinitely.
      const cleanup = (): void => {
        clearInterval(ping)
        liveSockets.delete(ws)
      }
      ws.on('close', cleanup)
      ws.on('error', cleanup)
      // Send a hello with the current PIN-less identity so the tablet knows
      // it's actually paired.
      ws.send(JSON.stringify({ type: 'hello', payload: { ts: Date.now() } }))
    })
  })

  http.listen(port, '0.0.0.0', () => {
    const addrs = listLanAddresses()
    console.log(
      `[server] listening on 0.0.0.0:${port}; LAN URLs: ${addrs.map((a) => `http://${a}:${port}`).join(', ')}`
    )
    console.log(`[server] pairing PIN: ${getPin()}`)
  })

  handle = { http, wss, port }
  return handle
}

export function stopHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!handle) {
      resolve()
      return
    }
    const h = handle
    handle = null
    for (const ws of liveSockets) {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    liveSockets.clear()
    h.wss.close(() => {
      h.http.close(() => resolve())
    })
  })
}

/** Diagnostic — used by the renderer "show LAN access" panel. */
export function getServerStatus(): {
  running: boolean
  port: number
  addresses: string[]
  primary: string
  pin: string
} {
  return {
    running: handle !== null,
    port: handle?.port ?? DEFAULT_PORT,
    addresses: listLanAddresses(),
    primary: primaryLanAddress(),
    pin: getPin()
  }
}
