import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface FeishuCredential {
  appId: string
  appSecret: string
}

function getCredentialPath(): string {
  const userData = app.getPath('userData')
  return join(userData, 'feishu-credential.json')
}

export function saveCredential(appId: string, appSecret: string): void {
  const credential: FeishuCredential = { appId, appSecret }
  writeFileSync(getCredentialPath(), JSON.stringify(credential, null, 2), 'utf8')
  console.log('[feishu] credential saved')
}

export function loadCredential(): FeishuCredential | null {
  const path = getCredentialPath()
  if (!existsSync(path)) return null

  try {
    const text = readFileSync(path, 'utf8')
    const credential = JSON.parse(text) as FeishuCredential
    if (credential.appId && credential.appSecret) {
      return credential
    }
    return null
  } catch (error) {
    console.warn('[feishu] failed to load credential:', error)
    return null
  }
}

export function clearCredential(): void {
  const path = getCredentialPath()
  if (existsSync(path)) {
    unlinkSync(path)
    console.log('[feishu] credential cleared')
  }
}
