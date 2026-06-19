// Prepares offline assets so the app runs with no CDN at runtime:
//  1. copies the MediaPipe vision WASM runtime out of node_modules
//  2. downloads the pose model (atomically — partial downloads never "stick")
//  3. rasterizes PWA PNG icons from public/icon.svg (for installability)
// Safe to run repeatedly. Network / sharp failures are non-fatal so `npm install`
// never breaks — re-run `npm run setup:assets` once online / with sharp present.
import {
  existsSync,
  mkdirSync,
  cpSync,
  statSync,
  createWriteStream,
  renameSync,
  unlinkSync,
  readFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const wasmSrc = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmDest = join(pub, 'mediapipe', 'wasm')
const modelDir = join(pub, 'mediapipe', 'models')
const modelPath = join(modelDir, 'pose_landmarker_lite.task')
const iconSvg = join(pub, 'icon.svg')
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task'
const MIN_MODEL_BYTES = 1_000_000

function copyWasm() {
  if (!existsSync(wasmSrc)) {
    console.warn('[setup:assets] @mediapipe/tasks-vision not installed yet — skipping wasm copy.')
    return
  }
  mkdirSync(wasmDest, { recursive: true })
  cpSync(wasmSrc, wasmDest, { recursive: true })
  console.log('[setup:assets] Copied MediaPipe wasm ->', wasmDest)
}

async function downloadModel() {
  if (existsSync(modelPath) && statSync(modelPath).size > MIN_MODEL_BYTES) {
    console.log('[setup:assets] Pose model already present — skipping download.')
    return
  }
  mkdirSync(modelDir, { recursive: true })
  const tmp = `${modelPath}.partial`
  console.log('[setup:assets] Downloading pose model ...')
  try {
    const res = await fetch(MODEL_URL)
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    const expected = Number(res.headers.get('content-length')) || 0
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmp)
      const src = Readable.fromWeb(res.body)
      src.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      src.pipe(out)
    })
    const size = statSync(tmp).size
    if (size < MIN_MODEL_BYTES || (expected && size !== expected)) {
      throw new Error(`size mismatch: got ${size}, expected ${expected || `>${MIN_MODEL_BYTES}`}`)
    }
    renameSync(tmp, modelPath) // atomic: only a fully-verified file appears at modelPath
    console.log('[setup:assets] Saved model ->', modelPath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    console.warn(
      `[setup:assets] Could not download the model (${err.message}).\n` +
        `  Download it manually to: ${modelPath}\n  From: ${MODEL_URL}`,
    )
  }
}

async function generateIcons() {
  if (!existsSync(iconSvg)) return
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch {
    console.warn('[setup:assets] sharp not installed — skipping PNG icon generation (PWA install icons).')
    return
  }
  const bg = '#0b0f17'
  const svg = readFileSync(iconSvg)
  try {
    await sharp(svg, { density: 512 }).resize(192, 192).png().toFile(join(pub, 'pwa-192.png'))
    await sharp(svg, { density: 512 }).resize(512, 512).png().toFile(join(pub, 'pwa-512.png'))
    // Maskable: full-bleed dark background with the mark inside the ~80% safe zone.
    await sharp(svg, { density: 512 })
      .resize(410, 410)
      .flatten({ background: bg })
      .extend({ top: 51, bottom: 51, left: 51, right: 51, background: bg })
      .png()
      .toFile(join(pub, 'pwa-512-maskable.png'))
    // iOS apple-touch-icon must be an opaque PNG (iOS adds its own rounding).
    await sharp(svg, { density: 512 }).resize(180, 180).flatten({ background: bg }).png().toFile(join(pub, 'apple-touch-icon.png'))
    console.log('[setup:assets] Generated PWA PNG icons.')
  } catch (err) {
    console.warn(`[setup:assets] Icon generation failed (${err.message}).`)
  }
}

copyWasm()
await downloadModel()
await generateIcons()
