// Project file-tree inspector + filesystem watcher.
//
// Responsibilities:
//   • Sandboxed `listDir` / `openPath` against a project's rootDir
//   • Recursive fs.watch per active project, throttled, broadcasting
//     `fs:changed` events the renderer reacts to
//
// We intentionally do NOT pull in chokidar: built-in fs.watch with
// `recursive: true` works on Windows (Vista+) and macOS, and the use case
// here (UI refresh hint) tolerates the missed-event quirks. For Linux you
// only get top-level events — fine for v1.

import { shell, type WebContents } from 'electron'
import { promises as fsp, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DirEntry, FilePreview, IpcResult, Project } from '@shared/types'

// Paths we never traverse / display — too large, too noisy, or irrelevant.
const HIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  '.cloxde',
  'dist',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__'
])

/** Realpath of the deepest existing ancestor of `abs`, with the missing tail
 *  re-appended. Lets us containment-check a path that doesn't exist yet (e.g.
 *  a file about to be written) while still resolving symlinks on the parts
 *  that DO exist — so a symlinked parent dir pointing outside the root is
 *  caught instead of being trusted on its lexical name. */
function realPathAllowingMissing(abs: string): string {
  let head = resolve(abs)
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(head)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(abs) // nothing along the path exists
      tail.push(basename(head))
      head = parent
    }
  }
}

/** True iff `target` resolves (after following symlinks) to `root` or a path
 *  beneath it. Use for every filesystem access driven by a remote/agent
 *  request so a symlink inside the project can't be used to escape it. */
export function ensureUnder(root: string, target: string): boolean {
  if (!isAbsolute(target)) return false
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    realRoot = resolve(root)
  }
  const realTarget = realPathAllowingMissing(target)
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep)
}

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function err(message: string): IpcResult<never> {
  return { ok: false, error: message }
}

export async function listDir(
  project: Project,
  relPath: string
): Promise<IpcResult<DirEntry[]>> {
  const abs = join(project.rootDir, relPath || '')
  if (!ensureUnder(project.rootDir, abs)) return err('out of bounds')
  try {
    const st = statSync(abs)
    if (!st.isDirectory()) return err('not a directory')
  } catch (e) {
    return err((e as Error).message)
  }

  let dirents
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true })
  } catch (e) {
    return err((e as Error).message)
  }

  const entries: DirEntry[] = []
  for (const d of dirents) {
    // Skip hidden / large directories. Keep dotfiles visible (sometimes
    // people care, e.g. .env, .gitignore) but skip dot-folders for noise.
    if (d.isDirectory() && (HIDDEN_DIRS.has(d.name) || d.name.startsWith('.'))) {
      continue
    }
    const childAbs = join(abs, d.name)
    let stat
    try {
      stat = await fsp.stat(childAbs)
    } catch {
      continue
    }
    entries.push({
      name: d.name,
      path: relative(project.rootDir, childAbs).replace(/\\/g, '/'),
      kind: d.isDirectory() ? 'directory' : 'file',
      size: stat.isFile() ? stat.size : undefined,
      mtime: stat.mtimeMs
    })
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return ok(entries)
}

export async function openPath(
  project: Project,
  relPath: string
): Promise<IpcResult<true>> {
  const abs = join(project.rootDir, relPath)
  if (!ensureUnder(project.rootDir, abs)) return err('out of bounds')
  const errMsg = await shell.openPath(abs)
  return errMsg ? err(errMsg) : ok(true)
}

// --- Recursive file list (for @file mentions) ------------------------------
//
// Flattened list of every (non-hidden) file path under the project root,
// relative + POSIX-separated. Backs the composer's @file autocomplete on
// both desktop and tablet. Bounded by FILE_LIST_MAX so a giant repo can't
// produce a multi-megabyte payload — once we hit the cap we stop walking.

const FILE_LIST_MAX = 4000

export async function listProjectFiles(project: Project): Promise<IpcResult<string[]>> {
  const root = project.rootDir
  const out: string[] = []
  // Iterative BFS so a deep tree can't blow the stack; respects the same
  // HIDDEN_DIRS / dot-folder skips as listDir.
  const queue: string[] = ['']
  while (queue.length > 0 && out.length < FILE_LIST_MAX) {
    const rel = queue.shift() as string
    const abs = join(root, rel)
    if (!ensureUnder(root, abs)) continue
    let dirents
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (d.isDirectory()) {
        if (HIDDEN_DIRS.has(d.name) || d.name.startsWith('.')) continue
        queue.push(join(rel, d.name))
      } else if (d.isFile()) {
        if (out.length >= FILE_LIST_MAX) break
        out.push(join(rel, d.name).replace(/\\/g, '/'))
      }
    }
  }
  out.sort((a, b) => a.localeCompare(b))
  return ok(out)
}

// --- File preview (in-app reader) -----------------------------------------
//
// Tablets call this instead of openPath so users can view files inside the
// app rather than firing a window on whatever desktop the server runs on
// (which would yank a colleague's screen). Capped at PREVIEW_MAX_BYTES so
// we don't ship a 200 MB log file over the wire.

const PREVIEW_MAX_BYTES = 256 * 1024 // 256 KB head; plenty for source.
const IMAGE_MAX_BYTES = 4 * 1024 * 1024 // 4 MB hard cap on inline image.

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'env',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'd.ts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'xml', 'svg', 'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql', 'proto', 'patch', 'diff',
  'gitignore', 'gitattributes', 'editorconfig', 'prettierrc',
  'eslintrc', 'dockerfile', 'lock'
])
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** True when the buffer almost certainly contains UTF-8 text. We use a
 *  cheap heuristic: no NUL bytes in the first 8 KB. Plenty for source code,
 *  config, logs. UTF-16 / weird encodings will be flagged binary; that's OK. */
function looksLikeText(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return false
  }
  return true
}

export async function readFilePreview(
  project: Project,
  relPath: string
): Promise<IpcResult<FilePreview>> {
  const abs = join(project.rootDir, relPath)
  if (!ensureUnder(project.rootDir, abs)) return err('out of bounds')
  let stat
  try {
    stat = await fsp.stat(abs)
  } catch (e) {
    return err((e as Error).message)
  }
  if (!stat.isFile()) return err('not a file')

  const ext = extOf(abs)

  // Image branch — limited size, sent as base64 data url.
  if (IMAGE_MIME[ext]) {
    if (stat.size > IMAGE_MAX_BYTES) {
      return ok<FilePreview>({
        path: relPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: 'binary'
      })
    }
    try {
      const buf = await fsp.readFile(abs)
      return ok<FilePreview>({
        path: relPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: 'image',
        image: { data: buf.toString('base64'), mimeType: IMAGE_MIME[ext] }
      })
    } catch (e) {
      return err((e as Error).message)
    }
  }

  // Text branch — read at most PREVIEW_MAX_BYTES from the head.
  const wantText =
    TEXT_EXTS.has(ext) ||
    // Many config files are dotfiles without an extension (.gitignore etc.)
    /^[._]?[a-z0-9_-]+$/i.test(abs.split(/[/\\]/).pop() ?? '')

  if (!wantText) {
    return ok<FilePreview>({
      path: relPath,
      size: stat.size,
      mtime: stat.mtimeMs,
      kind: 'binary'
    })
  }

  try {
    const fh = await fsp.open(abs, 'r')
    try {
      const cap = Math.min(stat.size, PREVIEW_MAX_BYTES)
      const buf = Buffer.alloc(cap)
      const { bytesRead } = await fh.read(buf, 0, cap, 0)
      const slice = buf.subarray(0, bytesRead)
      if (!looksLikeText(slice)) {
        return ok<FilePreview>({
          path: relPath,
          size: stat.size,
          mtime: stat.mtimeMs,
          kind: 'binary'
        })
      }
      const truncated = stat.size > PREVIEW_MAX_BYTES
      return ok<FilePreview>({
        path: relPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: 'text',
        text: slice.toString('utf8'),
        truncated,
        truncatedAt: truncated ? PREVIEW_MAX_BYTES : undefined
      })
    } finally {
      await fh.close()
    }
  } catch (e) {
    return err((e as Error).message)
  }
}

// --- Watcher ---------------------------------------------------------------

const watchers = new Map<string, FSWatcher>()
const timers = new Map<string, NodeJS.Timeout>()

export function ensureWatch(
  projectId: string,
  rootDir: string,
  onChange: () => void
): void {
  if (watchers.has(projectId)) return
  let w: FSWatcher
  try {
    w = watch(rootDir, { recursive: true })
  } catch (e) {
    // Linux doesn't always support recursive — fall back to a non-recursive
    // watch on the root. Users on Linux can refresh manually for now.
    try {
      w = watch(rootDir)
    } catch (e2) {
      console.error('[fs-watch] could not watch project', projectId, e2)
      return
    }
  }
  w.on('change', (_event, filename) => {
    if (filename) {
      const name = filename.toString()
      // Cheap filter — skip events from noisy paths.
      if ([...HIDDEN_DIRS].some((d) => name.includes(d + sep) || name === d)) return
    }
    const existing = timers.get(projectId)
    if (existing) clearTimeout(existing)
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId)
        onChange()
      }, 250)
    )
  })
  w.on('error', (err) => {
    console.error('[fs-watch] error', projectId, err)
  })
  watchers.set(projectId, w)
}

export function stopAllWatches(): void {
  for (const [id, w] of watchers) {
    try {
      w.close()
    } catch {
      /* ignore */
    }
    const t = timers.get(id)
    if (t) clearTimeout(t)
  }
  watchers.clear()
  timers.clear()
}

/** Release the recursive watcher (and any pending debounce timer) for one
 *  project. Call on archive/delete so we don't leak a live fs.watch on a
 *  project the user can no longer see. No-op if nothing is watching it. */
export function stopWatch(projectId: string): void {
  const w = watchers.get(projectId)
  if (w) {
    try {
      w.close()
    } catch {
      /* ignore */
    }
    watchers.delete(projectId)
  }
  const t = timers.get(projectId)
  if (t) {
    clearTimeout(t)
    timers.delete(projectId)
  }
}

export function broadcastFsChange(wcs: WebContents[], projectId: string): void {
  for (const wc of wcs) {
    if (wc.isDestroyed()) continue
    wc.send('fs:changed', { projectId })
  }
}
