// Connection store — owns the (baseUrl, token) pair and persists it across
// app launches via AsyncStorage. Other screens import `useConnection` to
// react to pair / unpair, and `client` to make calls.

import { create } from 'zustand'
import { AppState, type AppStateStatus } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { setConnection, ws as wsClient } from '../api/client'
import type { ServerConnection } from '../types'

const STORAGE_KEY = '@cloxde/connection'

// Foreground watchdog: when the OS suspends the app the WS socket can die
// silently (half-open) without ever firing onclose, so on resume the tablet
// would show "connected" while receiving nothing. Force a fresh reconnect on
// every background→active transition. Wired once, lazily, on first hydrate.
let appStateWired = false
function wireAppStateReconnect(): void {
  if (appStateWired) return
  appStateWired = true
  let prev: AppStateStatus = AppState.currentState
  AppState.addEventListener('change', (next) => {
    if (prev.match(/inactive|background/) && next === 'active') {
      wsClient.reconnectNow()
    }
    prev = next
  })
}

interface ConnectionState {
  conn: ServerConnection | null
  /** True until we've finished the initial AsyncStorage hydrate. */
  hydrated: boolean
  /** Live WS state — toggled by the WS client. */
  wsConnected: boolean
  hydrate: () => Promise<void>
  setConn: (c: ServerConnection) => Promise<void>
  clear: () => Promise<void>
  setWsConnected: (v: boolean) => void
}

export const useConnection = create<ConnectionState>((set) => ({
  conn: null,
  hydrated: false,
  wsConnected: false,

  hydrate: async () => {
    wireAppStateReconnect()
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ServerConnection
        if (parsed && typeof parsed.baseUrl === 'string' && typeof parsed.token === 'string') {
          setConnection(parsed)
          set({ conn: parsed })
          // Wire WS state into the store before connecting so the very first
          // open/close event lands.
          wsClient.setConnectedHandler((v) => set({ wsConnected: v }))
          wsClient.connect()
        }
      }
    } catch {
      // ignore — start fresh
    } finally {
      set({ hydrated: true })
    }
  },

  setConn: async (c) => {
    setConnection(c)
    set({ conn: c })
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(c))
    wsClient.disconnect()
    wsClient.setConnectedHandler((v) => set({ wsConnected: v }))
    wsClient.connect()
  },

  clear: async () => {
    wsClient.disconnect()
    setConnection(null)
    set({ conn: null, wsConnected: false })
    await AsyncStorage.removeItem(STORAGE_KEY)
  },

  setWsConnected: (v) => set({ wsConnected: v })
}))
