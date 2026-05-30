// Network helpers — find the local LAN IP so we can show "open this URL on
// your tablet" without the user hunting for ipconfig.

import { networkInterfaces } from 'node:os'

/** Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range. We surface
 *  these so a tablet can reach the desktop from outside the LAN over the mesh
 *  VPN (encrypted P2P) without any port forwarding. */
export function isTailscaleAddr(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip)
  if (!m) return false
  const second = Number(m[1])
  return second >= 64 && second <= 127
}

/** Virtual adapters a paired tablet can never actually reach (WSL/Hyper-V,
 *  Docker bridges, VM host-only nets). Listing their IPs as "available" just
 *  misleads the user, so we drop them. */
function isVirtualInterface(name: string): boolean {
  return /vethernet|^veth|^docker|^br-|virtualbox|vmware|loopback/i.test(name)
}

/** All non-internal IPv4 addresses on this host, ordered to put the most
 *  likely "primary LAN" address first (private 192/10/172.16 ranges), then the
 *  Tailscale mesh address, then anything else. Virtual-adapter IPs are
 *  filtered out entirely. */
export function listLanAddresses(): string[] {
  const result: string[] = []
  const ifs = networkInterfaces()
  for (const name of Object.keys(ifs)) {
    if (isVirtualInterface(name)) continue
    const list = ifs[name]
    if (!list) continue
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        result.push(info.address)
      }
    }
  }
  return result.sort((a, b) => rankAddr(a) - rankAddr(b))
}

function rankAddr(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  // Tailscale ranks after real LAN nets: at home you want the LAN IP as
  // primary, but the mesh address should still be listed for remote use.
  if (isTailscaleAddr(ip)) return 3
  return 9
}

/** Best-guess primary LAN IP. Falls back to localhost. */
export function primaryLanAddress(): string {
  return listLanAddresses()[0] ?? '127.0.0.1'
}
