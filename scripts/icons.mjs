// Generates the PWA icons: a petrol tile with three white ledger lines (the
// same mark as the lock screen). Pure node - hand-rolled PNG encoder, no deps.
//   node scripts/icons.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(outDir, { recursive: true })

const BG = [0x0c, 0x4a, 0x4f] // --accent-deep
const FG = [0xff, 0xff, 0xff]

// --- tiny PNG encoder ---------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = ~0
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- drawing ------------------------------------------------------------

// Signed distance to a rounded rect centered geometry; used for smooth edges.
function roundedRectDist(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

function drawIcon(size, { bleed }) {
  const rgba = Buffer.alloc(size * size * 4)
  // The mark: three left-aligned bars inside a box `m` (the mark box).
  const m = bleed ? size * 0.62 : size
  const mx = (size - m) / 2
  const my = (size - m) / 2
  const barH = m * 0.08
  const gap = m * 0.115
  const x0 = mx + m * 0.24
  const widths = [m * 0.52, m * 0.37, m * 0.45]
  const alphas = [1, 1, 0.6]
  const totalH = 3 * barH + 2 * gap
  const y0 = my + (m - totalH) / 2
  const tileR = bleed ? 0 : size * 0.22

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // tile
      let a = 1
      if (!bleed) {
        const d = roundedRectDist(x + 0.5, y + 0.5, 0, 0, size, size, tileR)
        a = Math.min(1, Math.max(0, 0.5 - d))
      }
      if (a <= 0) continue
      let [r, g, b] = BG
      // bars (capsules = rounded rects with r = h/2)
      for (let k = 0; k < 3; k++) {
        const by = y0 + k * (barH + gap)
        const d = roundedRectDist(x + 0.5, y + 0.5, x0, by, widths[k], barH, barH / 2)
        const cov = Math.min(1, Math.max(0, 0.5 - d)) * alphas[k]
        if (cov > 0) {
          r = r + (FG[0] - r) * cov
          g = g + (FG[1] - g) * cov
          b = b + (FG[2] - b) * cov
        }
      }
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(a * 255)
    }
  }
  return png(size, size, rgba)
}

writeFileSync(join(outDir, 'icon-192.png'), drawIcon(192, { bleed: false }))
writeFileSync(join(outDir, 'icon-512.png'), drawIcon(512, { bleed: false }))
writeFileSync(join(outDir, 'icon-maskable-512.png'), drawIcon(512, { bleed: true }))
writeFileSync(join(outDir, 'apple-touch-icon.png'), drawIcon(180, { bleed: true }))
console.log('icons written to', outDir)
