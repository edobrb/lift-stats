import type { Landmark, PhaseKind } from '../types'

// Canvas overlay: the live camera frame, the pose skeleton, the tracked point,
// a position trace, and the heads-up stats. Drawn in canvas pixel space, which
// equals the video's intrinsic size, so landmarks (normalized 0..1) map directly.

const ECCENTRIC_COLOR = '#f43f5e'
const CONCENTRIC_COLOR = '#22c55e'
const HOLD_COLOR = '#fbbf24' // amber — the lifter is paused/holding at an extreme
const ACCENT = '#38bdf8'
const DIM = 'rgba(255,255,255,0.55)'

const CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [11, 12], [11, 23], [12, 24], [23, 24], // torso
  [11, 13], [13, 15], [12, 14], [14, 16], // arms
  [23, 25], [25, 27], [24, 26], [26, 28], // legs
]

export interface Hud {
  exerciseName: string
  repCount: number
  phase: PhaseKind | null
  phaseElapsedMs: number
  fps: number
  lastEccentricMs: number | null
  lastConcentricMs: number | null
  trackedY: number | null
  trace: number[]
  status: string
}

const isHold = (phase: PhaseKind | null): boolean => phase === 'holdTop' || phase === 'holdBottom'

const phaseColor = (phase: PhaseKind | null): string =>
  phase === 'eccentric'
    ? ECCENTRIC_COLOR
    : phase === 'concentric'
      ? CONCENTRIC_COLOR
      : isHold(phase)
        ? HOLD_COLOR
        : ACCENT

const phaseLabel = (phase: PhaseKind | null, status: string): string =>
  phase === 'eccentric'
    ? 'ECCENTRIC'
    : phase === 'concentric'
      ? 'CONCENTRIC'
      : phase === 'holdTop'
        ? 'HOLD · TOP'
        : phase === 'holdBottom'
          ? 'HOLD · BOTTOM'
          : status

const roundRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
    return
  }
  // Fallback for Safari < 16, which lacks CanvasRenderingContext2D.roundRect.
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

const drawSkeleton = (ctx: CanvasRenderingContext2D, lm: Landmark[], w: number, h: number) => {
  ctx.lineWidth = Math.max(2, w * 0.004)
  ctx.strokeStyle = 'rgba(56,189,248,0.85)'
  for (const [a, b] of CONNECTIONS) {
    const p = lm[a]
    const q = lm[b]
    if (!p || !q || (p.visibility ?? 1) < 0.4 || (q.visibility ?? 1) < 0.4) continue
    ctx.beginPath()
    ctx.moveTo(p.x * w, p.y * h)
    ctx.lineTo(q.x * w, q.y * h)
    ctx.stroke()
  }
  ctx.fillStyle = ACCENT
  const r = Math.max(3, w * 0.006)
  for (const p of lm) {
    if ((p.visibility ?? 1) < 0.4) continue
    ctx.beginPath()
    ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

const drawTrace = (ctx: CanvasRenderingContext2D, trace: number[], w: number, h: number, color: string) => {
  if (trace.length < 2) return
  const bandX = w - w * 0.1
  const bandW = w * 0.06
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(2, w * 0.003)
  ctx.beginPath()
  trace.forEach((y, i) => {
    const px = bandX + (i / (trace.length - 1)) * bandW
    const py = Math.min(h, Math.max(0, y)) * h
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  })
  ctx.stroke()
}

const drawTrackedMarker = (ctx: CanvasRenderingContext2D, y: number, w: number, h: number, color: string) => {
  const py = y * h
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.5, w * 0.0025)
  ctx.setLineDash([w * 0.02, w * 0.02])
  ctx.beginPath()
  ctx.moveTo(0, py)
  ctx.lineTo(w, py)
  ctx.stroke()
  ctx.setLineDash([])
}

export const drawOverlay = (
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  landmarks: Landmark[] | null,
  hud: Hud,
): void => {
  const w = ctx.canvas.width
  const h = ctx.canvas.height
  ctx.drawImage(video, 0, 0, w, h)

  const color = phaseColor(hud.phase)
  if (hud.trackedY !== null) drawTrackedMarker(ctx, hud.trackedY, w, h, color)
  if (landmarks) drawSkeleton(ctx, landmarks, w, h)
  drawTrace(ctx, hud.trace, w, h, color)

  const pad = w * 0.03
  const unit = h * 0.001
  ctx.textBaseline = 'top'

  // Rep counter
  ctx.fillStyle = '#fff'
  ctx.font = `700 ${72 * unit}px system-ui, sans-serif`
  ctx.fillText(`${hud.repCount}`, pad, pad)
  ctx.fillStyle = DIM
  ctx.font = `600 ${20 * unit}px system-ui, sans-serif`
  ctx.fillText('REPS', pad + 4, pad + 78 * unit)

  // Exercise + fps (top-right)
  ctx.textAlign = 'right'
  ctx.fillStyle = DIM
  ctx.font = `600 ${22 * unit}px system-ui, sans-serif`
  ctx.fillText(`${hud.exerciseName.toUpperCase()} · ${Math.round(hud.fps)} fps`, w - pad, pad)
  ctx.textAlign = 'left'

  // Phase pill + live timer (eccentric red / concentric green / hold amber)
  const pillY = h - pad - 56 * unit
  const label = phaseLabel(hud.phase, hud.status)
  ctx.font = `700 ${26 * unit}px system-ui, sans-serif`
  const labelW = ctx.measureText(label).width
  const pillW = labelW + 40 * unit
  ctx.fillStyle = hud.phase ? color : 'rgba(255,255,255,0.18)'
  roundRectPath(ctx, pad, pillY, pillW, 56 * unit, 28 * unit)
  ctx.fill()
  ctx.fillStyle = hud.phase ? '#0b0f17' : '#fff'
  ctx.fillText(label, pad + 20 * unit, pillY + 14 * unit)

  if (hud.phase) {
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${30 * unit}px system-ui, sans-serif`
    ctx.fillText(`${(hud.phaseElapsedMs / 1000).toFixed(2)}s`, pad + pillW + 18 * unit, pillY + 12 * unit)
  }

  // Last rep tempo (bottom-right)
  if (hud.lastEccentricMs !== null && hud.lastConcentricMs !== null) {
    ctx.textAlign = 'right'
    ctx.fillStyle = '#fff'
    ctx.font = `600 ${24 * unit}px system-ui, sans-serif`
    const ecc = (hud.lastEccentricMs / 1000).toFixed(2)
    const con = (hud.lastConcentricMs / 1000).toFixed(2)
    ctx.fillText(`last  ${ecc}s ↓  ${con}s ↑`, w - pad, h - pad - 28 * unit)
    ctx.textAlign = 'left'
  }
}

/** Match the canvas backing store to the video's intrinsic size (once it's known). */
export const syncCanvasSize = (canvas: HTMLCanvasElement, video: HTMLVideoElement): boolean => {
  const w = video.videoWidth
  const h = video.videoHeight
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w
    canvas.height = h
    return true
  }
  return false
}
