// Network helpers — find the local LAN IP so we can show "open this URL on
// your tablet" without the user hunting for ipconfig.

import { networkInterfaces } from 'node:os'

/** All non-internal IPv4 addresses on this host, ordered to put the most
 *  likely "primary LAN" address first (private 192/10/172.16 ranges). */
export function listLanAddresses(): string[] {
  const result: string[] = []
  const ifs = networkInterfaces()
  for (const name of Object.keys(ifs)) {
    const list = ifs[name]
    if (!list) continue
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        result.push(info.address)
      }
    }
  }
  // Sort: 192.168.x first, then 10.x, then 172.16-31.x, then everything else.
  return result.sort((a, b) => rankAddr(a) - rankAddr(b))
}

function rankAddr(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 9
}

/** Best-guess primary LAN IP. Falls back to localhost. */
export function primaryLanAddress(): string {
  return listLanAddresses()[0] ?? '127.0.0.1'
}
