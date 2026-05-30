import { useEffect, useMemo, useRef, useState } from 'react'

export interface Command {
  id: string
  label: string
  /** Secondary line, e.g. the owning project or a hint. */
  sub?: string
  /** Optional grouping label shown when no query is typed. */
  group?: string
  keywords?: string
  run: () => void
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
}

/** Ctrl/Cmd-K overlay: fuzzy-ish substring search over actions + jumps. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return commands
    return commands.filter((c) =>
      `${c.label} ${c.sub ?? ''} ${c.keywords ?? ''}`.toLowerCase().includes(q)
    )
  }, [commands, q])

  useEffect(() => {
    setActive(0)
  }, [q])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (cmd: Command | undefined): void => {
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[active])
    }
  }

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="搜索命令、跳转会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmdk-empty">无匹配项</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              data-idx={i}
              className={`cmdk-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span className="cmdk-item-label">{c.label}</span>
              {c.sub && <span className="cmdk-item-sub">{c.sub}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
