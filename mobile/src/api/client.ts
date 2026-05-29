// REST + WebSocket client for the CloXde desktop companion server.
//
// Single-instance pattern: the user pairs one desktop, we keep the connection
// info in a Zustand store, and every screen imports `client` to make calls.
// On reconnect (token still valid) we reuse the stored baseUrl + token.

import type {
  AgentKind,
  AgentProfile,
  Conversation,
  ConversationView,
  DirEntry,
  FilePreview,
  IpcResult,
  Message,
  PresenceActivity,
  Project,
  ServerConnection,
  Side
} from '../types'

// ---- Connection state (mutable singleton) --------------------------------

let conn: ServerConnection | null = null

export function setConnection(c: ServerConnection | null): void {
  conn = c
}
export function getConnection(): ServerConnection | null {
  return conn
}
function require(): ServerConnection {
  if (!conn) throw new Error('Not connected to a CloXde desktop yet — pair first.')
  return conn
}

// ---- Helpers --------------------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  /** When true, don't require an existing connection — used for /api/pair. */
  bareBaseUrl?: string,
  bareToken?: string
): Promise<IpcResult<T>> {
  const c = bareBaseUrl ? { baseUrl: bareBaseUrl, token: bareToken ?? '' } : require()
  const url = `${c.baseUrl}${path}`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (c.token) headers.Authorization = `Bearer ${c.token}`
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined
    })
  } catch (e) {
    return { ok: false, error: `网络错误：${(e as Error).message}` }
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = (await res.json()) as IpcResult<T>
      if (j && !j.ok) return j
      detail = JSON.stringify(j)
    } catch {
      try {
        detail = await res.text()
      } catch {
        detail = ''
      }
    }
    return { ok: false, error: `HTTP ${res.status} ${res.statusText} ${detail}`.trim() }
  }
  try {
    return (await res.json()) as IpcResult<T>
  } catch (e) {
    return { ok: false, error: `解析响应失败：${(e as Error).message}` }
  }
}

// ---- Public API surface --------------------------------------------------

/** Probe a candidate host to confirm it's a CloXde server. */
export async function ping(baseUrl: string): Promise<IpcResult<{ name: string; version: string }>> {
  return request<{ name: string; version: string }>('GET', '/api/info', undefined, baseUrl, '')
}

/** Pair with the server using the PIN shown on the desktop. */
export async function pair(
  baseUrl: string,
  pin: string,
  label: string
): Promise<IpcResult<{ token: string; label: string }>> {
  return request<{ token: string; label: string }>('POST', '/api/pair', { pin, label }, baseUrl, '')
}

// Projects ------------------------------------------------------------------
export const projects = {
  list: () => request<Project[]>('GET', '/api/projects'),
  listArchived: () => request<Project[]>('GET', '/api/projects/archived'),
  create: (rootDir: string) => request<Project>('POST', '/api/projects', { rootDir }),
  open: (id: string) => request<true>('POST', `/api/projects/${id}/open`),
  archive: (id: string) => request<true>('POST', `/api/projects/${id}/archive`),
  unarchive: (id: string) => request<true>('POST', `/api/projects/${id}/unarchive`),
  delete: (id: string) => request<true>('DELETE', `/api/projects/${id}`)
}

// Profiles ------------------------------------------------------------------
export const profiles = {
  listByProject: (projectId: string) =>
    request<AgentProfile[]>('GET', `/api/projects/${projectId}/profiles`),
  upsert: (input: {
    projectId: string
    kind: AgentKind
    name?: string
    command?: string | null
    args?: string[]
    env?: Record<string, string>
  }) => request<AgentProfile>('PUT', '/api/profiles', input)
}

// Conversations -------------------------------------------------------------
export const conversations = {
  listByProject: (projectId: string) =>
    request<Conversation[]>('GET', `/api/projects/${projectId}/conversations`),
  listArchivedByProject: (projectId: string) =>
    request<Conversation[]>('GET', `/api/projects/${projectId}/conversations/archived`),
  create: (input: {
    projectId: string
    title?: string
    withPm?: boolean
    pmKind?: AgentKind
    architectKind?: AgentKind
    executorKind?: AgentKind
    parentIds?: string[]
    summaryOverride?: string
  }) => request<ConversationView>('POST', '/api/conversations', input),
  previewInheritedSummary: (parentIds: string[]) =>
    request<string>('POST', '/api/conversations/preview-summary', { parentIds }),
  get: (
    id: string,
    opts?: { limit?: number; before?: number }
  ) => {
    // RN's URLSearchParams polyfill doesn't implement set() (throws), so
    // hand-roll the query string. Only two known optional params so this
    // stays trivially readable.
    const parts: string[] = []
    if (opts?.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(opts.limit))}`)
    if (opts?.before !== undefined) parts.push(`before=${encodeURIComponent(String(opts.before))}`)
    const qs = parts.length ? `?${parts.join('&')}` : ''
    return request<ConversationView | null>('GET', `/api/conversations/${id}${qs}`)
  },
  delete: (id: string) => request<true>('DELETE', `/api/conversations/${id}`),
  archive: (id: string) => request<true>('POST', `/api/conversations/${id}/archive`),
  unarchive: (id: string) => request<true>('POST', `/api/conversations/${id}/unarchive`),
  sendUserMessage: (
    id: string,
    text: string,
    target?: Side,
    attachments?: { data: string; mimeType: string }[]
  ) =>
    request<true>('POST', `/api/conversations/${id}/messages`, {
      text,
      target,
      attachments
    }),
  cancel: (id: string) => request<true>('POST', `/api/conversations/${id}/cancel`),
  setAutopilot: (id: string, value: boolean) =>
    request<true>('POST', `/api/conversations/${id}/autopilot`, { value }),
  setPrimarySide: (id: string, side: Side) =>
    request<true>('POST', `/api/conversations/${id}/primary-side`, { side })
}

// Filesystem inspector ------------------------------------------------------
export const fs = {
  listDir: (projectId: string, path: string) =>
    request<DirEntry[]>('GET', `/api/projects/${projectId}/fs?path=${encodeURIComponent(path)}`),
  /** In-app preview — text contents inline, image as base64. Replaces
   *  openPath for the tablet, which would otherwise yank a window onto
   *  whatever desktop the server is running on. */
  readPreview: (projectId: string, path: string) =>
    request<FilePreview>(
      'GET',
      `/api/projects/${projectId}/fs/read?path=${encodeURIComponent(path)}`
    ),
  openPath: (projectId: string, path: string) =>
    request<true>('POST', `/api/projects/${projectId}/fs/open`, { path }),
  /** Flat list of project files (POSIX relative paths) for @-mention
   *  autocomplete. Capped server-side. */
  listFiles: (projectId: string) =>
    request<string[]>('GET', `/api/projects/${projectId}/fs/files`)
}

// Presence (cross-client awareness) -----------------------------------------
export const presenceApi = {
  /** Latest activity per conversation. Used on (re)connect to seed the
   *  banner without waiting for the next broadcast. */
  snapshot: () => request<PresenceActivity[]>('GET', '/api/presence')
}

// App ----------------------------------------------------------------------
export const appApi = {
  getVersion: () => request<string>('GET', '/api/app/version')
}

// Auth admin ---------------------------------------------------------------
export const authAdmin = {
  listDevices: () =>
    request<{ token: string; label: string; createdAt: number }[]>('GET', '/api/auth/devices'),
  revoke: (token: string) => request<true>('POST', '/api/auth/revoke', { token }),
  revokeAll: () => request<true>('POST', '/api/auth/revoke-all'),
  rotatePin: () => request<string>('POST', '/api/auth/rotate-pin')
}

// ---- WebSocket ------------------------------------------------------------

export type WsEvent =
  | { type: 'hello'; payload: { ts: number } }
  | { type: 'conversation:updated'; payload: ConversationView }
  | { type: 'message:appended'; payload: { conversationId: string; message: Message } }
  | {
      type: 'message:patched'
      payload: { conversationId: string; messageId: string; patch: Partial<Message> }
    }
  | { type: 'fs:changed'; payload: { projectId: string } }
  | { type: 'presence:activity'; payload: PresenceActivity }

type Listener = (e: WsEvent) => void

class WsClient {
  private ws: WebSocket | null = null
  private listeners: Set<Listener> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false
  private connectedHandler: ((v: boolean) => void) | null = null

  /** Wire a global "connected?" callback, used by the connection store. */
  setConnectedHandler(cb: ((v: boolean) => void) | null): void {
    this.connectedHandler = cb
  }

  connect(): void {
    const c = getConnection()
    if (!c) return
    this.intentionallyClosed = false
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return
    const wsUrl = c.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(c.token)}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.onopen = () => {
      this.connectedHandler?.(true)
    }
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as WsEvent
        for (const l of this.listeners) l(data)
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = () => {
      this.ws = null
      this.connectedHandler?.(false)
      if (this.intentionallyClosed) return
      // Backoff reconnect: 2s — keeps the tablet alive when the desktop
      // briefly drops (laptop lid close / wifi flap).
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => this.connect(), 2_000)
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.connectedHandler?.(false)
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}

export const ws = new WsClient()
