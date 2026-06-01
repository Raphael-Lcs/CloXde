import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { AgentKind, AgentProfile, Project } from '@shared/types'
import { isAssistantSoundEnabled, setAssistantSoundEnabled } from '../lib/sound'
import { TwoClickButton } from './TwoClickButton'

interface SettingsDialogProps {
  /** Active project, if any. When null we hide the project-scoped sections
   *  and fall back to global ones (just 关于 right now). */
  project: Project | null
  open: boolean
  onClose: () => void
  /** Archived projects (passed through so the "归档项目" section can list
   *  them without doing its own IPC fetch). */
  archivedProjects: Project[]
  onUnarchiveProject: (id: string) => void
  onDeleteProject: (id: string) => void
}

type SectionId = 'agent' | 'general' | 'archived-projects' | 'lan' | 'wechat' | 'about'

interface SectionMeta {
  id: SectionId
  label: string
  /** When true, the section is shown only when a project is selected. */
  requiresProject?: boolean
}

const SECTIONS: SectionMeta[] = [
  { id: 'agent', label: 'Agent 设置', requiresProject: true },
  { id: 'general', label: '通用' },
  { id: 'lan', label: '平板互联' },
  { id: 'wechat', label: '微信' },
  { id: 'archived-projects', label: '归档项目' },
  { id: 'about', label: '关于' }
]

/**
 * Centralised settings panel. Sections:
 *   • Agent 设置 (project-scoped)         — agent profiles
 *   • 归档项目 (global)                    — manage soft-archived projects
 *   • 关于 (global)                       — version, build info
 *
 * When no project is active (e.g. user archived the last one), the panel
 * still opens — Agent 设置 falls back to a hint to pick/create a project.
 */
export function SettingsDialog({
  project,
  open,
  onClose,
  archivedProjects,
  onUnarchiveProject,
  onDeleteProject
}: SettingsDialogProps): JSX.Element | null {
  // Always show every section in the nav. Sections that need a project but
  // don't have one render a fallback message in their content panel; we
  // never *hide* the entry, otherwise users panic ("where did my Agent
  // settings go?"). Disabled-looking styling is enough.
  const [active, setActive] = useState<SectionId>('agent')

  useEffect(() => {
    // Every fresh open returns the user to Agent 设置 — the section they
    // come to Settings for 99% of the time.
    if (open) setActive('agent')
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>设置</span>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((s) => {
              const disabled = s.requiresProject && !project
              return (
                <button
                  key={s.id}
                  className={`settings-nav-item ${active === s.id ? 'active' : ''} ${
                    disabled ? 'disabled' : ''
                  }`}
                  onClick={() => setActive(s.id)}
                  title={disabled ? '请先选择或新建一个项目' : undefined}
                >
                  {s.label}
                  {s.id === 'archived-projects' && archivedProjects.length > 0 && (
                    <span className="settings-nav-badge">{archivedProjects.length}</span>
                  )}
                </button>
              )
            })}
          </nav>
          <div className="settings-content">
            {active === 'agent' && project && <AgentSection project={project} />}
            {active === 'agent' && !project && (
              <div className="settings-pane">
                <p style={{ color: 'var(--fg-dim)' }}>
                  Agent 设置是按项目存的，请先在左侧选择或新建一个项目。
                </p>
              </div>
            )}
            {active === 'archived-projects' && (
              <ArchivedProjectsSection
                archived={archivedProjects}
                onUnarchive={onUnarchiveProject}
                onDelete={onDeleteProject}
              />
            )}
            {active === 'general' && <GeneralSection />}
            {active === 'lan' && <LanSection />}
            {active === 'wechat' && <WechatSection />}
            {active === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- General section -------------------------------------------------------

function GeneralSection(): JSX.Element {
  const [assistantSound, setAssistantSound] = useState(() => isAssistantSoundEnabled())

  const toggleAssistantSound = (next: boolean): void => {
    setAssistantSoundEnabled(next)
    setAssistantSound(next)
  }

  return (
    <div className="settings-pane">
      <label className="field">
        <span>助理消息提示音</span>
        <label>
          <input
            type="checkbox"
            checked={assistantSound}
            onChange={(e) => toggleAssistantSound(e.target.checked)}
          />
          {' '}开启
        </label>
        <div className="settings-hint">
          助理回复你时播放短促提示音；团队回复不受影响
        </div>
      </label>
    </div>
  )
}

// --- Agent section ---------------------------------------------------------

interface DraftRow {
  key: string
  value: string
}

function envToRows(env: Record<string, string>): DraftRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}
function rowsToEnv(rows: DraftRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (!k) continue
    out[k] = r.value
  }
  return out
}

function AgentSection({ project }: { project: Project }): JSX.Element {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [active, setActive] = useState<AgentKind>('claude')
  const [draftEnv, setDraftEnv] = useState<DraftRow[]>([])
  const [draftCommand, setDraftCommand] = useState('')
  const [draftArgs, setDraftArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void window.api.profiles
      .listByProject(project.id)
      .then((res) => {
        if (cancelled) return
        if (res.ok) setProfiles(res.data)
      })
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [project.id])

  useEffect(() => {
    const p = profiles.find((x) => x.kind === active)
    if (!p) return
    setDraftEnv(envToRows(p.env))
    setDraftCommand(p.command ?? '')
    setDraftArgs(p.args.join(' '))
    setDirty(false)
  }, [profiles, active])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.profiles.upsert({
        projectId: project.id,
        kind: active,
        command: draftCommand.trim() ? draftCommand.trim() : null,
        args: draftArgs.trim() ? draftArgs.trim().split(/\s+/) : [],
        env: rowsToEnv(draftEnv)
      })
      if (!res.ok) {
        window.alert(`保存失败：${res.error}`)
        return
      }
      const fresh = await window.api.profiles.listByProject(project.id)
      if (fresh.ok) setProfiles(fresh.data)
      setDirty(false)
    } finally {
      setBusy(false)
    }
  }

  const setRow = (idx: number, patch: Partial<DraftRow>): void => {
    setDraftEnv((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  return (
    <div className="settings-pane">
      <div className="settings-subheader">
        <span className="agent-tabs">
          {(['claude', 'codex', 'hermes'] as AgentKind[]).map((k) => (
            <button
              key={k}
              className={`toggle-btn kind-${k} ${active === k ? 'active' : ''}`}
              onClick={() => setActive(k)}
            >
              {k === 'hermes' ? 'Hermes' : k}
            </button>
          ))}
        </span>
        <span className="settings-subheader-hint">项目：{project.name}</span>
      </div>

      <label className="field">
        <span>
          启动命令（留空使用内置 ACP adapter
          {active === 'hermes' ? '；Hermes 默认走本机 venv 内的 hermes.exe' : ''}）
        </span>
        <input
          value={draftCommand}
          onChange={(e) => {
            setDraftCommand(e.target.value)
            setDirty(true)
          }}
          placeholder={
            active === 'hermes'
              ? '例如：C:\\Users\\L\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe'
              : '例如：/path/to/custom-acp'
          }
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span>额外参数（空格分隔）</span>
        <input
          value={draftArgs}
          onChange={(e) => {
            setDraftArgs(e.target.value)
            setDirty(true)
          }}
          placeholder={
            active === 'hermes' ? '（默认追加 acp --accept-hooks）' : '--flag value'
          }
          spellCheck={false}
        />
      </label>

      <div className="field">
        <span>环境变量（用于 ccswitch / 自定义 API endpoint 等）</span>
        <div className="env-table">
          {draftEnv.map((r, i) => (
            <div className="env-row" key={i}>
              <input
                placeholder="KEY"
                value={r.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                spellCheck={false}
              />
              <input
                placeholder="VALUE"
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                spellCheck={false}
              />
              <button
                onClick={() => {
                  setDraftEnv((rows) => rows.filter((_, j) => j !== i))
                  setDirty(true)
                }}
              >
                删除
              </button>
            </div>
          ))}
          <button
            className="env-add"
            onClick={() => {
              setDraftEnv((rows) => [...rows, { key: '', value: '' }])
              setDirty(true)
            }}
          >
            + 添加变量
          </button>
        </div>
        <div className="settings-hint">
          典型变量：<code>ANTHROPIC_BASE_URL</code>, <code>ANTHROPIC_API_KEY</code>,{' '}
          <code>OPENAI_API_KEY</code> 等。
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="primary"
          onClick={() => void save()}
          disabled={busy || !dirty}
        >
          {busy ? '保存中…' : dirty ? '保存改动' : '已保存'}
        </button>
      </div>
    </div>
  )
}

// --- Archived projects section --------------------------------------------

function ArchivedProjectsSection({
  archived,
  onUnarchive,
  onDelete
}: {
  archived: Project[]
  onUnarchive: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  return (
    <div className="settings-pane archived-pane">
      {archived.length === 0 ? (
        <div className="archived-empty">没有已归档的项目</div>
      ) : (
        <div className="archived-list">
          {archived.map((p) => (
            <div className="archived-item" key={p.id}>
              <div className="archived-meta">
                <div className="archived-title">{p.name}</div>
                <div className="archived-when">
                  <span className="archived-path">{p.rootDir}</span>
                </div>
                <div className="archived-when">
                  归档于 {formatDate(p.archivedAt)} · 创建于 {formatDate(p.createdAt)}
                </div>
              </div>
              <button
                className="archived-action"
                onClick={() => onUnarchive(p.id)}
                title="恢复项目（含级联归档的会话）"
              >
                ↺ 恢复
              </button>
              <TwoClickButton
                className="archived-action danger"
                defaultLabel="× 删除"
                confirmLabel="确认删除?"
                defaultTitle="永久删除项目及全部会话（不可恢复）"
                confirmTitle="再点一次彻底删除"
                onConfirm={() => onDelete(p.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatDate(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// --- LAN companion section -------------------------------------------------

/** Tailscale CGNAT range (100.64.0.0/10). Mirrors net.ts on the main side so
 *  the UI can flag which address works for remote (off-LAN) access. */
function isTailscaleAddr(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

interface PairedDevice {
  token: string
  label: string
  createdAt: number
}

interface ServerStatus {
  running: boolean
  port: number
  addresses: string[]
  primary: string
  pin: string
  error: string | null
}

function LanSection(): JSX.Element {
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [error, setError] = useState<string>('')

  const reload = async (): Promise<void> => {
    const sr = await window.api.server.getStatus()
    if (sr.ok) setStatus(sr.data)
    else setError(sr.error)
    const dr = await window.api.server.listDevices()
    if (dr.ok) setDevices(dr.data)
  }

  useEffect(() => {
    void reload()
  }, [])

  if (!status) {
    return (
      <div className="settings-pane">
        <p style={{ color: 'var(--fg-dim)' }}>{error || '加载中…'}</p>
      </div>
    )
  }

  const primaryUrl = `http://${status.primary}:${status.port}`

  async function handleRotate(): Promise<void> {
    await window.api.server.rotatePin()
    await reload()
  }

  async function handleRevoke(token: string): Promise<void> {
    await window.api.server.revokeDevice(token)
    await reload()
  }

  async function handleRevokeAll(): Promise<void> {
    await window.api.server.revokeAll()
    await reload()
  }

  return (
    <div className="settings-pane">
      <h3 style={{ marginTop: 0 }}>平板互联</h3>
      {!status.running ? (
        <p style={{ color: 'var(--danger, #e5534b)', lineHeight: 1.6 }}>
          互联服务未启动{status.error ? `：${status.error}` : ''}
          。请检查端口是否被占用（可用 CLOXDE_LAN_PORT 环境变量换端口），重启应用后再试。
        </p>
      ) : null}
      <p style={{ color: 'var(--fg-dim)', lineHeight: 1.6 }}>
        手机或平板装上 CloXde Mobile App 后，在「连接桌面端」页面填入下列地址和 PIN
        即可配对。配对完成后会用 token 持续访问，无需每次输入 PIN。
      </p>

      <div className="lan-info">
        <div className="lan-row">
          <span className="lan-label">服务地址</span>
          <code className="lan-value">{primaryUrl}</code>
        </div>
        {status.addresses.length > 1 ? (
          <div className="lan-row">
            <span className="lan-label">其他可用 IP</span>
            <code className="lan-value">
              {status.addresses
                .filter((a) => a !== status.primary)
                .map((a) =>
                  isTailscaleAddr(a)
                    ? `${a}:${status.port}（Tailscale · 远程）`
                    : `${a}:${status.port}`
                )
                .join('  ·  ')}
            </code>
          </div>
        ) : null}
        <div className="lan-row">
          <span className="lan-label">配对 PIN</span>
          <code className="lan-value lan-pin">{status.pin}</code>
          <button onClick={handleRotate} className="settings-link-btn">
            生成新 PIN
          </button>
        </div>
      </div>

      <h4 style={{ marginTop: 24 }}>已配对设备</h4>
      {devices.length === 0 ? (
        <p style={{ color: 'var(--fg-dim)' }}>暂无配对设备。</p>
      ) : (
        <ul className="lan-device-list">
          {devices.map((d) => (
            <li key={d.token} className="lan-device-row">
              <span>{d.label}</span>
              <span className="lan-device-ts">
                {new Date(d.createdAt).toLocaleString()}
              </span>
              <TwoClickButton
                defaultLabel="解除配对"
                confirmLabel="确认解除"
                onConfirm={() => void handleRevoke(d.token)}
              />
            </li>
          ))}
          {devices.length > 1 ? (
            <li>
              <TwoClickButton
                defaultLabel="解除所有"
                confirmLabel="确认解除所有"
                onConfirm={() => void handleRevokeAll()}
              />
            </li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

// --- WeChat channel section -----------------------------------------------

interface WechatStatus {
  loggedIn: boolean
  accountId: string | null
}

function WechatSection(): JSX.Element {
  const [wechatStatus, setWechatStatus] = useState<WechatStatus>({
    loggedIn: false,
    accountId: null
  })
  const [wechatQrcode, setWechatQrcode] = useState<string | null>(null)
  const [wechatLoading, setWechatLoading] = useState(false)
  const [wechatError, setWechatError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearLoginTimers = (): void => {
    if (pollRef.current) clearInterval(pollRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    pollRef.current = null
    timeoutRef.current = null
  }

  const reloadStatus = async (): Promise<void> => {
    const result = await window.api.wechat.getStatus()
    if (result.ok) setWechatStatus(result.data)
    else setWechatError(result.error)
  }

  useEffect(() => {
    void reloadStatus()
    return () => clearLoginTimers()
  }, [])

  const handleWechatLogin = async (): Promise<void> => {
    clearLoginTimers()
    setWechatLoading(true)
    setWechatQrcode(null)
    setWechatError('')

    try {
      const result = await window.api.wechat.startLogin()
      if (!result.ok) {
        setWechatError(result.error)
        setWechatLoading(false)
        return
      }

      const qrcodeDataUrl = await QRCode.toDataURL(result.data.qrcodeUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#FFFFFF' }
      })
      setWechatQrcode(qrcodeDataUrl)

      pollRef.current = setInterval(() => {
        void window.api.wechat.getStatus().then((statusResult) => {
          if (statusResult.ok && statusResult.data.loggedIn) {
            setWechatStatus(statusResult.data)
            setWechatQrcode(null)
            setWechatLoading(false)
            clearLoginTimers()
          } else if (!statusResult.ok) {
            setWechatError(statusResult.error)
          }
        })
      }, 2000)

      timeoutRef.current = setTimeout(() => {
        clearLoginTimers()
        setWechatLoading(false)
        setWechatQrcode(null)
        setWechatError('登录超时，请重新扫码')
      }, 180000)
    } catch (e) {
      setWechatError((e as Error).message)
      setWechatLoading(false)
      clearLoginTimers()
    }
  }

  const handleWechatLogout = async (): Promise<void> => {
    const result = await window.api.wechat.logout()
    if (result.ok) {
      clearLoginTimers()
      setWechatStatus({ loggedIn: false, accountId: null })
      setWechatQrcode(null)
      setWechatLoading(false)
      setWechatError('')
    } else {
      setWechatError(result.error)
    }
  }

  return (
    <div className="settings-pane">
      <h3 style={{ marginTop: 0 }}>微信登录</h3>

      {wechatStatus.loggedIn ? (
        <div className="wechat-logged-in">
          <div>
            <div className="wechat-status-title">已登录</div>
            <code className="wechat-account">{wechatStatus.accountId}</code>
          </div>
          <button onClick={() => void handleWechatLogout()}>登出</button>
        </div>
      ) : (
        <div className="wechat-login">
          {wechatQrcode ? (
            <div className="qrcode-container">
              <img src={wechatQrcode} alt="微信登录二维码" />
              <p>请使用微信扫码登录</p>
            </div>
          ) : (
            <button
              onClick={() => void handleWechatLogin()}
              disabled={wechatLoading}
              className="primary"
            >
              {wechatLoading ? '加载中...' : '开始登录'}
            </button>
          )}
        </div>
      )}

      {wechatError ? <p className="wechat-error">{wechatError}</p> : null}

      <div className="wechat-info">
        <p className="info-text">
          登录后，可以在微信私聊中与 CloXde 助理交互。
        </p>
      </div>
    </div>
  )
}

// --- About section ---------------------------------------------------------

function AboutSection(): JSX.Element {
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.app.getVersion().then((r) => {
      if (r.ok) setVersion(r.data)
    })
  }, [])

  return (
    <div className="settings-pane">
      <h2 style={{ marginTop: 0 }}>CloXde</h2>
      <p style={{ color: 'var(--fg-dim)' }}>
        本地桌面控制台，用于编排 Claude Code 与 Codex CLI 通过 ACP 协议进行 A2A 协作。
      </p>
      <p style={{ color: 'var(--fg-dim)', fontSize: 12 }}>版本 v{version}</p>
    </div>
  )
}
