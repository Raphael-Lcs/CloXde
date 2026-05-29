// Render the CloXde brandmark into a multi-resolution Windows .ico, with
// no external dependencies — pure Node + node:zlib for DEFLATE.
//
// Design matches src/renderer/src/components/Logo.tsx:
//   • rounded dark square (rx=7 in a 32-unit viewBox), 1px subtle border
//   • blue circle  (#7aa2ff, α=0.78) at (12.5, 16) r=7.5  → architect / Claude
//   • green circle (#8be7c5, α=0.78) at (19.5, 16) r=7.5  → executor  / Codex
//
// Output:
//   resources/icon.ico    — multi-size .ico for Windows shortcuts / EXE
//   resources/icon-256.png — flat PNG fallback (Electron BrowserWindow.icon)
//
// Run:  node scripts/build-icon.cjs

const fs   = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ---------------------------------------------------------------------------
// CRC32 (PNG chunks need it; node has no built-in)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return (~crc) >>> 0
}

// ---------------------------------------------------------------------------
// Pixel renderer
// ---------------------------------------------------------------------------

const BG_R = 0x19, BG_G = 0x19, BG_B = 0x1c
const BD_R = 0x34, BD_G = 0x34, BD_B = 0x3c
const BL_R = 0x7a, BL_G = 0xa2, BL_B = 0xff
const GR_R = 0x8b, GR_G = 0xe7, GR_B = 0xc5
const CIRCLE_ALPHA = 0.78

/** Distance-to-edge for an axis-aligned rounded rectangle [0,0]–[w,h]
 *  with corner radius r. Negative inside, positive outside. */
function sdRoundedRect(x, y, w, h, r) {
  const cx = x < r ? r : x > w - r ? w - r : x
  const cy = y < r ? r : y > h - r ? h - r : y
  const dx = x - cx
  const dy = y - cy
  const d = Math.hypot(dx, dy)
  if (x >= r && x <= w - r && y >= 0 && y <= h) return Math.max(-y, y - h)
  if (y >= r && y <= h - r && x >= 0 && x <= w) return Math.max(-x, x - w)
  return d - r
}

function blend(dst, src, alpha) {
  // src over dst (both RGB, src has alpha)
  const a = alpha
  return [
    Math.round(src[0] * a + dst[0] * (1 - a)),
    Math.round(src[1] * a + dst[1] * (1 - a)),
    Math.round(src[2] * a + dst[2] * (1 - a))
  ]
}

function renderLogo(size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = size / 32 // viewBox 32 → pixel scale

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // sample center of the pixel in viewBox coords
      const vx = (px + 0.5) / scale
      const vy = (py + 0.5) / scale

      // ----- rounded square mask + 1px border, anti-aliased -----
      const sd = sdRoundedRect(vx, vy, 32, 32, 7)
      // px-space anti-alias band ~ ±0.5 / scale viewBox units
      const aaBand = 0.5 / scale

      // outside the square → transparent
      if (sd > aaBand) {
        const o = (py * size + px) * 4
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0
        continue
      }

      // pixel coverage from outer edge (1 inside, 0 outside)
      const outerCov = Math.min(1, Math.max(0, 0.5 - sd * scale))

      // border ring: from sd = -1 (outer) to sd = 0 (edge); blend with border color
      let rgb = [BG_R, BG_G, BG_B]
      if (sd >= -1) {
        // closer to edge → more border tint
        const t = Math.min(1, Math.max(0, sd + 1)) // 0 at sd=-1, 1 at sd=0
        rgb = blend(rgb, [BD_R, BD_G, BD_B], t * 0.8)
      }

      // ----- two circles with alpha blending and AA -----
      const dBlue = Math.hypot(vx - 12.5, vy - 16) - 7.5
      if (dBlue <= aaBand) {
        const cov = Math.min(1, Math.max(0, 0.5 - dBlue * scale))
        rgb = blend(rgb, [BL_R, BL_G, BL_B], CIRCLE_ALPHA * cov)
      }
      const dGreen = Math.hypot(vx - 19.5, vy - 16) - 7.5
      if (dGreen <= aaBand) {
        const cov = Math.min(1, Math.max(0, 0.5 - dGreen * scale))
        rgb = blend(rgb, [GR_R, GR_G, GR_B], CIRCLE_ALPHA * cov)
      }

      const o = (py * size + px) * 4
      out[o] = rgb[0]
      out[o + 1] = rgb[1]
      out[o + 2] = rgb[2]
      out[o + 3] = Math.round(255 * outerCov)
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// PNG encoder (truecolor + alpha, filter=None per scanline)
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9) // color type RGBA
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  const row = width * 4
  const filtered = Buffer.alloc((row + 1) * height)
  for (let y = 0; y < height; y++) {
    filtered[y * (row + 1)] = 0 // None filter
    rgba.copy(filtered, y * (row + 1) + 1, y * row, (y + 1) * row)
  }
  const idat = zlib.deflateSync(filtered, { level: 9 })

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------------------
// ICO container (multi-image, each entry is a PNG)
// ---------------------------------------------------------------------------

function encodeIco(pngs /* [{ size, buf }] */) {
  const N = pngs.length
  const dir = Buffer.alloc(6)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2) // type icon
  dir.writeUInt16LE(N, 4)

  const entries = Buffer.alloc(16 * N)
  let offset = 6 + 16 * N
  pngs.forEach((p, i) => {
    const e = entries.subarray(i * 16, (i + 1) * 16)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1)
    e.writeUInt8(0, 2) // colors
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(p.buf.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += p.buf.length
  })

  return Buffer.concat([dir, entries, ...pngs.map((p) => p.buf)])
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const outDir = path.join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map((s) => ({ size: s, buf: encodePng(s, s, renderLogo(s)) }))

const ico = encodeIco(pngs)
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)

// Also drop a 256 PNG — Electron's BrowserWindow.icon prefers a PNG path,
// and packagers (electron-builder) accept it as a fallback.
fs.writeFileSync(path.join(outDir, 'icon-256.png'), pngs[pngs.length - 1].buf)

console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'icon.ico'))} (${(ico.length / 1024).toFixed(1)} KB, ${sizes.length} sizes)`)
console.log(`wrote ${path.relative(process.cwd(), path.join(outDir, 'icon-256.png'))}`)
