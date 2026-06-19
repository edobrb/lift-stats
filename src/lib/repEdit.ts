import type { Phase, RepMetrics } from '../types'

// A rep, for editing, is three points on the video timeline (seconds):
//   start → turnaround → end.
// The turnaround is the bottom (squat/bench) or the top (deadlift/pull-up): the
// boundary between the rep's first and second phase.
export interface RepBounds {
  startSec: number
  turnSec: number
  endSec: number
}

export const repBounds = (rep: RepMetrics, startsWith: Phase): RepBounds => {
  const startSec = rep.startMs / 1000
  const endSec = rep.endMs / 1000
  const firstMs = startsWith === 'eccentric' ? rep.eccentricMs : rep.concentricMs
  return { startSec, turnSec: startSec + firstMs / 1000, endSec }
}

/**
 * Recompute a rep's timing fields from edited bounds. Range-of-motion and peak
 * velocity are preserved (they come from pose displacement, not the timeline);
 * mean concentric velocity is rescaled to the new concentric duration so it stays
 * consistent with the edited timing.
 */
export const applyBounds = (
  rep: RepMetrics,
  bounds: RepBounds,
  startsWith: Phase,
  fps: number,
): RepMetrics => {
  const startSec = Math.max(0, bounds.startSec)
  const endSec = Math.max(bounds.endSec, startSec)
  const turnSec = Math.min(Math.max(bounds.turnSec, startSec), endSec)
  const firstSec = turnSec - startSec
  const secondSec = endSec - turnSec
  const eccentricSec = startsWith === 'eccentric' ? firstSec : secondSec
  const concentricSec = startsWith === 'eccentric' ? secondSec : firstSec
  const safeFps = fps > 0 ? fps : 30
  return {
    ...rep,
    startMs: startSec * 1000,
    endMs: endSec * 1000,
    eccentricMs: eccentricSec * 1000,
    concentricMs: concentricSec * 1000,
    eccentricFrames: Math.max(0, Math.round(eccentricSec * safeFps)),
    concentricFrames: Math.max(0, Math.round(concentricSec * safeFps)),
    meanConcentricVelocity: concentricSec > 0 ? rep.rangeOfMotion / concentricSec : 0,
  }
}

/** Label for the turnaround point given which phase the rep starts with. */
export const turnaroundLabel = (startsWith: Phase): string =>
  startsWith === 'eccentric' ? 'bottom' : 'top'
