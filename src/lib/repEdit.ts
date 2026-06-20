import type { Phase, PhaseKind, RepMetrics } from '../types'

// ---------------------------------------------------------------------------
// A rep is a chain of up to four phases along the video timeline, in order:
//   move1 · hold1 · move2 · hold2
// For an eccentric-first lift (squat/bench) that is:
//   eccentric (down) · hold-bottom · concentric (up) · hold-top
// For a concentric-first lift (deadlift/pull-up):
//   concentric (up) · hold-top · eccentric (down) · hold-bottom
//
// That gives FIVE editable points on the timeline (seconds):
//   start → enter1 → leave1 → enter2 → end
//   • start  — rep begins (first moving phase starts)
//   • enter1 — first extreme reached (first moving phase ends, first hold starts)
//   • leave1 — leaves the first extreme (first hold ends, second moving phase starts)
//   • enter2 — second extreme reached (second moving phase ends, trailing hold starts)
//   • end    — rep ends (trailing hold ends)
// When a hold has zero duration its two surrounding points coincide, which collapses
// back to the classic start → turnaround → end model. Pulling the points apart again
// is how the editor lets you create / fine-tune a pause.
// ---------------------------------------------------------------------------

export type Boundary = 'start' | 'enter1' | 'leave1' | 'enter2' | 'end'
export const BOUNDARIES: readonly Boundary[] = ['start', 'enter1', 'leave1', 'enter2', 'end']

export interface RepPoints {
  start: number
  enter1: number
  leave1: number
  enter2: number
  end: number
}

/** Back-compat 3-point view (start → turnaround → end) used by the detector test. */
export interface RepBounds {
  startSec: number
  turnSec: number
  endSec: number
}

/** One coloured stretch of a rep on the timeline (for segment drawing). */
export interface RepSegment {
  kind: PhaseKind
  startSec: number
  endSec: number
}

const ms = (v: number | undefined): number => v ?? 0

/** The four phase kinds in timeline order for this exercise. */
const phaseOrder = (startsWith: Phase): readonly [PhaseKind, PhaseKind, PhaseKind, PhaseKind] =>
  startsWith === 'eccentric'
    ? ['eccentric', 'holdBottom', 'concentric', 'holdTop']
    : ['concentric', 'holdTop', 'eccentric', 'holdBottom']

const phaseMs = (rep: RepMetrics, kind: PhaseKind): number =>
  kind === 'eccentric'
    ? rep.eccentricMs
    : kind === 'concentric'
      ? rep.concentricMs
      : kind === 'holdTop'
        ? ms(rep.holdTopMs)
        : ms(rep.holdBottomMs)

/**
 * The five editable points for a rep, placed along its real start→end span. The stored
 * phase durations rarely sum to the rep's wall-clock span (the One-Euro extremes the span
 * is anchored on lag the true ones), so the interior points are distributed proportionally
 * to fill start→end — this keeps the points aligned with the drawn phase blocks and with
 * `repSegments`. Old sets with no hold data collapse to start → turnaround → end.
 */
export const repPoints = (rep: RepMetrics, startsWith: Phase): RepPoints => {
  const start = rep.startMs / 1000
  const end = rep.endMs / 1000
  const durs = phaseOrder(startsWith).map((k) => phaseMs(rep, k))
  const total = durs.reduce((a, d) => a + d, 0)
  const span = Math.max(0, end - start)
  const scale = total > 0 ? span / (total / 1000) : 0
  let cursor = start
  const cum = durs.map((d) => (cursor += (d / 1000) * scale))
  return { start, enter1: cum[0]!, leave1: cum[1]!, enter2: cum[2]!, end }
}

/** Drawable phase blocks straight from a set of points (always aligned to the handles). */
export const repBlocks = (p: RepPoints, startsWith: Phase): RepSegment[] => {
  const order = phaseOrder(startsWith)
  const edges = [p.start, p.enter1, p.leave1, p.enter2, p.end]
  return order.map((kind, i) => ({ kind, startSec: edges[i]!, endSec: edges[i + 1]! }))
}

/**
 * Break a rep into its drawable sub-segments along the video timeline, dropping any
 * zero-length phases (so old sets without holds render as the plain ecc/con split).
 * Used by the minimap, where empty holds shouldn't leave gaps.
 */
export const repSegments = (rep: RepMetrics, startsWith: Phase): RepSegment[] =>
  repBlocks(repPoints(rep, startsWith), startsWith).filter((s) => s.endSec - s.startSec > 1e-6)

/**
 * Recompute a rep's timing fields from edited points. Range-of-motion and peak velocity
 * are preserved (they come from pose displacement, not the timeline); mean concentric
 * velocity is rescaled to the new concentric duration. Hold phases are preserved and
 * editable — the time between `enter1`/`leave1` and between `enter2`/`end` becomes the
 * hold durations, so dragging those points apart creates or resizes a pause.
 */
export const applyPoints = (rep: RepMetrics, pts: RepPoints, startsWith: Phase, fps: number): RepMetrics => {
  const safeFps = fps > 0 ? fps : 30
  const minMove = 1 / safeFps
  const start = Math.max(0, pts.start)
  const end = Math.max(pts.end, start)
  // Clamp the interior points into a monotonic non-decreasing chain.
  let enter1 = Math.min(Math.max(pts.enter1, start), end)
  let leave1 = Math.min(Math.max(pts.leave1, enter1), end)
  let enter2 = Math.min(Math.max(pts.enter2, leave1), end)
  // Keep each MOVING phase at least one frame long (when the rep has room) so a collapsed
  // boundary can't silently zero a rep's tempo/velocity. Holds may legitimately be zero.
  if (end - start >= 2 * minMove) {
    if (enter1 - start < minMove) enter1 = start + minMove
    if (leave1 < enter1) leave1 = enter1
    if (enter2 - leave1 < minMove) enter2 = Math.min(leave1 + minMove, end)
    if (enter2 < leave1) enter2 = leave1
  }

  const order = phaseOrder(startsWith)
  const durs = [enter1 - start, leave1 - enter1, enter2 - leave1, end - enter2]
  const sec: Record<PhaseKind, number> = { eccentric: 0, concentric: 0, holdTop: 0, holdBottom: 0 }
  order.forEach((kind, i) => (sec[kind] = durs[i]!))
  const frames = (s: number) => Math.max(0, Math.round(s * safeFps))

  return {
    ...rep,
    startMs: start * 1000,
    endMs: end * 1000,
    eccentricMs: sec.eccentric * 1000,
    concentricMs: sec.concentric * 1000,
    holdTopMs: sec.holdTop * 1000,
    holdBottomMs: sec.holdBottom * 1000,
    eccentricFrames: frames(sec.eccentric),
    concentricFrames: frames(sec.concentric),
    holdTopFrames: frames(sec.holdTop),
    holdBottomFrames: frames(sec.holdBottom),
    meanConcentricVelocity: sec.concentric > 0 ? rep.rangeOfMotion / sec.concentric : 0,
  }
}

// --- Back-compat 3-point API (kept for the detector test harness) -----------

export const repBounds = (rep: RepMetrics, startsWith: Phase): RepBounds => {
  const p = repPoints(rep, startsWith)
  return { startSec: p.start, turnSec: p.enter1, endSec: p.end }
}

export const applyBounds = (rep: RepMetrics, bounds: RepBounds, startsWith: Phase, fps: number): RepMetrics =>
  applyPoints(
    rep,
    { start: bounds.startSec, enter1: bounds.turnSec, leave1: bounds.turnSec, enter2: bounds.endSec, end: bounds.endSec },
    startsWith,
    fps,
  )

// --- Labels -----------------------------------------------------------------

/** Label for the classic turnaround point given which phase the rep starts with. */
export const turnaroundLabel = (startsWith: Phase): string => (startsWith === 'eccentric' ? 'bottom' : 'top')

/** The extreme names for this lift: [first extreme reached, second extreme reached]. */
const extremes = (startsWith: Phase): readonly [string, string] =>
  startsWith === 'eccentric' ? ['Bottom', 'Top'] : ['Top', 'Bottom']

/** Short label for an editable boundary handle/chip. */
export const boundaryLabel = (b: Boundary, startsWith: Phase): string => {
  const [first, second] = extremes(startsWith)
  switch (b) {
    case 'start':
      return 'Start'
    case 'enter1':
      return `${first} in`
    case 'leave1':
      return `${first} out`
    case 'enter2':
      return second
    case 'end':
      return 'End'
  }
}

/** Short label for a phase block. */
export const phaseLabel = (kind: PhaseKind): string =>
  kind === 'eccentric' ? 'Down' : kind === 'concentric' ? 'Up' : 'Hold'
