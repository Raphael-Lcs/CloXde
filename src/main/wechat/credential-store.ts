import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensureCloxdeDir, getCloxdeDir } from '../paths'

const CREDENTIAL_FILE = 'wechat-token.json'

export interface WeChatCredential {
  token: string
  accountId: string
}

function credentialPath(): string {
  return join(getCloxdeDir(), CREDENTIAL_FILE)
}

export function saveCredential(token: string, accountId: string): void {
  ensureCloxdeDir()
  const path = credentialPath()
  const tmp = `${path}.tmp`
  const credential: WeChatCredential = { token, accountId }
  writeFileSync(tmp, JSON.stringify(credential, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function loadCredential(): WeChatCredential | null {
  ensureCloxdeDir()
  const path = credentialPath()
  if (!existsSync(path)) return null

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WeChatCredential>
    if (typeof parsed.token === 'string' && typeof parsed.accountId === 'string') {
      return { token: parsed.token, accountId: parsed.accountId }
    }
  } catch {
    return null
  }
  return null
}

export function clearCredential(): void {
  ensureCloxdeDir()
  rmSync(credentialPath(), { force: true })
}
