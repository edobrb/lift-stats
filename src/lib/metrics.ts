import type { RepMetrics } from '../types'

export interface SetAggregate {
  repCount: number
  avgEccentricMs: number
  avgConcentricMs: number
  avgRangeOfMotion: number
  avgPeakVelocity: number
  avgMeanConcentricVelocity: number
  bestConcentricVelocity: number
  /** Time under tension = sum of eccentric + concentric (MOVING time) across all reps. */
  timeUnderTensionMs: number
  /** Total paused/holding time across the set (top + bottom holds); 0 for old sets. */
  totalHoldMs: number
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

export const aggregateReps = (reps: RepMetrics[]): SetAggregate => ({
  repCount: reps.length,
  avgEccentricMs: mean(reps.map((r) => r.eccentricMs)),
  avgConcentricMs: mean(reps.map((r) => r.concentricMs)),
  avgRangeOfMotion: mean(reps.map((r) => r.rangeOfMotion)),
  avgPeakVelocity: mean(reps.map((r) => r.peakVelocity)),
  avgMeanConcentricVelocity: mean(reps.map((r) => r.meanConcentricVelocity)),
  bestConcentricVelocity: reps.reduce((m, r) => Math.max(m, r.meanConcentricVelocity), 0),
  timeUnderTensionMs: reps.reduce((a, r) => a + r.eccentricMs + r.concentricMs, 0),
  totalHoldMs: reps.reduce((a, r) => a + (r.holdTopMs ?? 0) + (r.holdBottomMs ?? 0), 0),
})

/**
 * Velocity loss across the set (a fatigue indicator used in velocity-based
 * training): how far the slowest concentric dropped below the fastest, as a %.
 */
export const velocityLossPct = (reps: RepMetrics[]): number => {
  if (reps.length < 2) return 0
  const vels = reps.map((r) => r.meanConcentricVelocity)
  const best = Math.max(...vels)
  if (best <= 0) return 0
  const worst = Math.min(...vels)
  return Math.round(((best - worst) / best) * 100)
}
