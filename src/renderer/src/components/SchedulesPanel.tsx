import { useCallback, useEffect, useState } from 'react'
import type { Schedule, ScheduleTrigger } from '@shared/types'

interface SchedulesPanelProps {
  conversationId: string
}

/**
 * Right-side "定时" drawer — timed automation for one conversation. A schedule
 * fires on a timer (interval or 5-field cron) and injects its prompt into this
 * conversation exactly as if the user had typed it (goes to PM). Create / pause
 * / delete from here; the actual firing happens in the main-process ticker.
 */
export function SchedulesPanel({ conversationId }: SchedulesPanelProps): JSX.Element {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await window.api.schedules.listByConversation(conversationId)
      if (!res.ok) {
        setError(res.error)
        setSchedules([])
        return
      }
      setError(null)
      setSchedules(res.data)
    } catch (e) {
      setError(
        `调用失败：${(e as Error).message}（若刚改过代码，请完整重启应用让主进程重新注册）`
      )
      setSchedules([])
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  useEffect(() => {
    setCreating(false)
    void refresh()
  }, [conversationId, refresh])

  const handleToggle = useCallback(
    async (s: Schedule): Promise<void> => {
      await window.api.schedules.update(s.id, { enabled: !s.enabled })
      void refresh()
    },
    [refresh]
  )

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      await window.api.schedules.delete(id)
      void refresh()
    },
    [refresh]
  )

  return (
    <aside className="changes-panel schedules-panel">
      <div className="changes-header">
        <div className="changes-title">
          <span>定时</span>
          <button
            className="changes-refresh"
            onClick={() => setCreating((v) => !v)}
            title={creating ? '收起' : '新建定时任务'}
          >
            {creating ? '×' : '+'}
          </button>
        </div>
        <div className="changes-sub">
          {schedules.length > 0
            ? `${schedules.length} 个定时任务`
            : '到点自动给本会话发一条提示词（交给 PM）'}
        </div>
      </div>
      <div className="changes-list">
        {creating && (
          <ScheduleForm
            conversationId={conversationId}
            onDone={() => {
              setCreating(false)
              void refresh()
            }}
            onCancel={() => setCreating(false)}
          />
        )}
        {loading && schedules.length === 0 && !creating && (
          <div className="changes-hint">加载中…</div>
        )}
        {error && <div className="changes-error">读取失败：{error}</div>}
        {!loading && !error && schedules.length === 0 && !creating && (
          <div className="changes-hint">
            还没有定时任务。点右上角「+」新建一个，比如每天早上让团队跑一次回归。
          </div>
        )}
        {schedules.map((s) => (
          <ScheduleRow
            key={s.id}
            schedule={s}
            onToggle={() => void handleToggle(s)}
            onDelete={() => void handleDelete(s.id)}
          />
        ))}
      </div>
    </aside>
  )
}

function describeTrigger(t: ScheduleTrigger): string {
  if (t.kind === 'interval') {
    const mins = Math.round(t.everyMs / 60_000)
    if (mins % 1440 === 0) return `每 ${mins / 1440} 天`
    if (mins % 60 === 0) return `每 ${mins / 60} 小时`
    return `每 ${mins} 分钟`
  }
  return `cron：${t.expr}`
}

function formatTs(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ScheduleRow({
  schedule,
  onToggle,
  onDelete
}: {
  schedule: Schedule
  onToggle: () => void
  onDelete: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className={`change-row schedule-row ${schedule.enabled ? '' : 'disabled'}`}>
      <div className="schedule-head">
        <span className={`schedule-dot ${schedule.enabled ? 'on' : 'off'}`} />
        <span className="schedule-name" title={schedule.name}>
          {schedule.name}
        </span>
        <button
          className="schedule-btn"
          onClick={onToggle}
          title={schedule.enabled ? '暂停' : '启用'}
        >
          {schedule.enabled ? '暂停' : '启用'}
        </button>
        {confirming ? (
          <button
            className="schedule-btn danger"
            onClick={onDelete}
            onMouseLeave={() => setConfirming(false)}
            title="再次点击确认删除"
          >
            确认删
          </button>
        ) : (
          <button
            className="schedule-btn"
            onClick={() => setConfirming(true)}
            title="删除"
          >
            删除
          </button>
        )}
      </div>
      <div className="schedule-meta">
        <span className="schedule-trigger">{describeTrigger(schedule.trigger)}</span>
        <span className="schedule-next">
          {schedule.enabled ? `下次 ${formatTs(schedule.nextFireAt)}` : '已暂停'}
        </span>
      </div>
      <div className="schedule-prompt" title={schedule.prompt}>
        {schedule.prompt}
      </div>
    </div>
  )
}

function ScheduleForm({
  conversationId,
  onDone,
  onCancel
}: {
  conversationId: string
  onDone: () => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'interval' | 'cron'>('interval')
  const [everyValue, setEveryValue] = useState(1)
  const [everyUnit, setEveryUnit] = useState<'minute' | 'hour' | 'day'>('hour')
  const [cron, setCron] = useState('0 9 * * *')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = useCallback(async (): Promise<void> => {
    if (!prompt.trim()) {
      setFormError('提示词不能为空')
      return
    }
    let trigger: ScheduleTrigger
    if (mode === 'interval') {
      const unitMs = everyUnit === 'minute' ? 60_000 : everyUnit === 'hour' ? 3_600_000 : 86_400_000
      const everyMs = Math.floor(everyValue * unitMs)
      if (everyMs < 60_000) {
        setFormError('间隔至少 1 分钟')
        return
      }
      trigger = { kind: 'interval', everyMs }
    } else {
      if (!cron.trim()) {
        setFormError('cron 表达式不能为空')
        return
      }
      trigger = { kind: 'cron', expr: cron.trim() }
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await window.api.schedules.create({
        conversationId,
        name: name.trim() || undefined,
        trigger,
        prompt: prompt.trim()
      })
      if (!res.ok) {
        setFormError(res.error)
        return
      }
      onDone()
    } catch (e) {
      setFormError(`调用失败：${(e as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }, [conversationId, name, prompt, mode, everyValue, everyUnit, cron, onDone])

  return (
    <div className="schedule-form">
      <input
        className="schedule-input"
        placeholder="名称（可选，如「每日回归」）"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="schedule-mode">
        <button
          className={`schedule-tab ${mode === 'interval' ? 'active' : ''}`}
          onClick={() => setMode('interval')}
        >
          间隔
        </button>
        <button
          className={`schedule-tab ${mode === 'cron' ? 'active' : ''}`}
          onClick={() => setMode('cron')}
        >
          cron
        </button>
      </div>
      {mode === 'interval' ? (
        <div className="schedule-interval">
          <span>每</span>
          <input
            className="schedule-input num"
            type="number"
            min={1}
            value={everyValue}
            onChange={(e) => setEveryValue(Math.max(1, Number(e.target.value) || 1))}
          />
          <select
            className="schedule-input"
            value={everyUnit}
            onChange={(e) => setEveryUnit(e.target.value as 'minute' | 'hour' | 'day')}
          >
            <option value="minute">分钟</option>
            <option value="hour">小时</option>
            <option value="day">天</option>
          </select>
        </div>
      ) : (
        <div className="schedule-cron">
          <input
            className="schedule-input"
            placeholder="分 时 日 月 周（如 0 9 * * 1-5）"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
          />
          <div className="schedule-cron-hint">本地时间 · 5 字段 · 例：0 9 * * 1-5 工作日 9 点</div>
        </div>
      )}
      <textarea
        className="schedule-input prompt"
        placeholder="到点要发给 PM 的提示词，比如「跑一遍测试并报告失败项」"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
      />
      {formError && <div className="changes-error">{formError}</div>}
      <div className="schedule-form-actions">
        <button className="schedule-btn" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button
          className="schedule-btn primary"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? '创建中…' : '创建'}
        </button>
      </div>
    </div>
  )
}
