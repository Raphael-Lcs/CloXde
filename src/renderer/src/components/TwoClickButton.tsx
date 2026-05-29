import { useEffect, useRef, useState } from 'react'

interface TwoClickButtonProps {
  /** Normal-state contents (icon / short label). */
  defaultLabel: React.ReactNode
  /** Contents shown after the first click, waiting for confirmation. */
  confirmLabel: React.ReactNode
  /** Fired on the second click (in pending state). */
  onConfirm: () => void
  defaultTitle?: string
  confirmTitle?: string
  className?: string
  /** Auto-reset back to default state after this many ms. */
  resetMs?: number
  /** When true, also reset whenever the mouse leaves the button. */
  resetOnMouseLeave?: boolean
}

/**
 * Codex Desktop-style "press again to confirm" button.
 *
 *   • First click  → enters pending state (visual changes to confirm label)
 *   • Second click → fires onConfirm, returns to default state
 *   • Mouse leave  → cancels back to default state (optional)
 *   • Auto-timeout → cancels after `resetMs` ms (default 3000)
 *
 * Use for non-destructive but consequential actions (archive, kill, etc.)
 * where a full modal would be overkill but a single click is too easy to
 * fat-finger.
 */
export function TwoClickButton({
  defaultLabel,
  confirmLabel,
  onConfirm,
  defaultTitle,
  confirmTitle,
  className = '',
  resetMs = 3000,
  resetOnMouseLeave = true
}: TwoClickButtonProps): JSX.Element {
  const [pending, setPending] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = (): void => {
    setPending(false)
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <button
      className={`two-click ${className} ${pending ? 'pending' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        if (pending) {
          cancel()
          onConfirm()
        } else {
          setPending(true)
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(cancel, resetMs)
        }
      }}
      onMouseLeave={() => {
        if (resetOnMouseLeave) cancel()
      }}
      title={pending ? confirmTitle ?? '再点一次确认' : defaultTitle}
    >
      {pending ? confirmLabel : defaultLabel}
    </button>
  )
}
