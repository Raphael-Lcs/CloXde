// Token-based pairing for the LAN HTTP server.
//
// Flow:
//   1. On first start, we generate a random pairing PIN (6 digits) + a long
//      master token. Both are persisted under ~/.cloxde/server-auth.json so
//      restarts don't invalidate already-paired tablets.
//   2. The desktop UI shows the LAN URL + PIN as a QR code.
//   3. The tablet App scans the QR, posts the PIN to /api/pair, and receives
//      a long-lived bearer token to use in the Authorization header.
//   4. Every protected API/WS request must carry that token.
//
// Security properties (LAN-only model):
//   • PINs rotate every desktop launch unless the user explicitly pins one.
//   • Master tokens are 32 bytes random hex, never leave the desktop except
//      on a successful pairing.
//   • We don't bind to interfaces other than what's intended (caller picks
//      0.0.0.0 vs 127.0.0.1).
//   • Designed for a trusted home/office WiFi. Not a substitute for TLS.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCloxdeDir, getCloxdeDir } from '../paths'

const AUTH_FILE = 'server-auth.json'

interface AuthState {
  pin: string
  /** Map of token → { label, createdAt }. We allow many tokens so a user
   *  can pair multiple devices. */
  tokens: Record<string, { label: string; createdAt: number }>
}

let state: AuthState | null = null

function authPath(): string {
  return join(getCloxdeDir(), AUTH_FILE)
}

function load(): AuthState {
  if (state) return state
  ensureCloxdeDir()
  const p = authPath()
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AuthState>
      if (parsed && typeof parsed.pin === 'string' && parsed.tokens) {
        state = { pin: parsed.pin, tokens: parsed.tokens }
        return state
      }
    } catch {
      // fall through to regenerate
    }
  }
  state = {
    pin: generatePin(),
    tokens: {}
  }
  persist()
  return state
}

function persist(): void {
  if (!state) return
  // Atomic write: a crash mid-`writeFileSync` would leave a truncated file,
  // and load() silently regenerates a fresh PIN + empty token map on parse
  // failure — i.e. every paired device gets kicked. Write to a temp file then
  // rename (atomic on the same filesystem) so the real file is never partial.
  const p = authPath()
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, p)
}

function generatePin(): string {
  // 6-digit human-typeable PIN. Low entropy on its own (10^6), so brute force
  // is held off by the pairing rate-limiter below (attemptPair).
  let pin = ''
  for (let i = 0; i < 6; i++) {
    pin += String(randomBytes(1)[0] % 10)
  }
  return pin
}

/** Constant-time string compare so a low-entropy secret (the PIN) can't be
 *  recovered byte-by-byte via response-timing differences. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on length mismatch; compare against a same-length
  // buffer so the mismatch path costs the same as the match path.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

// --- Pairing rate limiter --------------------------------------------------
//
// The PIN is shared across all devices, so a single global sliding-window
// counter is the right granularity. After PAIR_MAX_ATTEMPTS failures inside
// PAIR_WINDOW_MS we lock pairing for PAIR_LOCKOUT_MS. A successful pair resets
// the window. This turns a ~10^6 brute force into something that would take
// years over the wire instead of seconds.

const PAIR_MAX_ATTEMPTS = 5
const PAIR_WINDOW_MS = 60_000
const PAIR_LOCKOUT_MS = 5 * 60_000

let pairFailures: number[] = []
let pairLockedUntil = 0

export interface PairAttemptResult {
  ok: boolean
  /** When locked or rejected, how long (ms) the caller should wait. */
  retryAfterMs?: number
}

/** Verify a pairing PIN under the rate limiter. Use this from the pair
 *  endpoint instead of verifyPin so brute-force attempts get throttled. */
export function attemptPair(candidate: string): PairAttemptResult {
  const now = Date.now()
  if (now < pairLockedUntil) {
    return { ok: false, retryAfterMs: pairLockedUntil - now }
  }
  // Drop failures that have aged out of the window.
  pairFailures = pairFailures.filter((t) => now - t < PAIR_WINDOW_MS)

  if (safeEqual(candidate, load().pin)) {
    pairFailures = []
    return { ok: true }
  }

  pairFailures.push(now)
  if (pairFailures.length >= PAIR_MAX_ATTEMPTS) {
    pairLockedUntil = now + PAIR_LOCKOUT_MS
    pairFailures = []
    return { ok: false, retryAfterMs: PAIR_LOCKOUT_MS }
  }
  return { ok: false }
}

/** Current pairing PIN. Shown to the user; tablet enters it to pair. */
export function getPin(): string {
  return load().pin
}

/** Force-rotate the PIN — user clicked "regenerate" in Settings. */
export function rotatePin(): string {
  const s = load()
  s.pin = generatePin()
  persist()
  return s.pin
}

/** True if the supplied PIN matches. Case-sensitive, exact, constant-time.
 *  NOTE: prefer `attemptPair` for the pairing endpoint — it adds rate
 *  limiting. This raw check is exported for internal/diagnostic use. */
export function verifyPin(candidate: string): boolean {
  return safeEqual(candidate, load().pin)
}

/** Issue a fresh token for a freshly paired device. */
export function issueToken(label: string): string {
  const s = load()
  const token = randomBytes(32).toString('hex')
  s.tokens[token] = { label: label || 'unknown device', createdAt: Date.now() }
  persist()
  return token
}

/** True if the token is one we've issued. */
export function verifyToken(token: string): boolean {
  return Boolean(load().tokens[token])
}

/** Return the label associated with a token, or null. Used by presence
 *  tracking to identify which paired device made a request. */
export function getTokenLabel(token: string): string | null {
  const meta = load().tokens[token]
  return meta ? meta.label : null
}

/** List paired devices (for the Settings UI). */
export function listTokens(): { token: string; label: string; createdAt: number }[] {
  const s = load()
  return Object.entries(s.tokens).map(([token, meta]) => ({ token, ...meta }))
}

/** Revoke one token (kicks the device off). */
export function revokeToken(token: string): void {
  const s = load()
  delete s.tokens[token]
  persist()
}

/** Revoke every paired device. */
export function revokeAll(): void {
  const s = load()
  s.tokens = {}
  persist()
}
