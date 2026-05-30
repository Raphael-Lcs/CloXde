// React-friendly subscription to WS events. Decouples screens from the
// imperative `ws.on(...)` callback API.

import { useEffect } from 'react'
import { ws, type WsEvent } from '../api/client'

export function useWsEvents(handler: (e: WsEvent) => void): void {
  useEffect(() => {
    const off = ws.on(handler)
    return off
    // We want the latest closure on every render so callers don't need
    // useCallback dance — the callback is cheap to swap in/out.
  }, [handler])
}
