import type { Landmark } from '../types'
import type { ExerciseConfig } from '../config/exercises'
import { POSE } from '../config/exercises'

export interface SignalSample {
  /** Tracked vertical position, normalized (0 = top of frame, 1 = bottom). */
  y: number
  /** Minimum visibility among the tracked landmarks (0..1). */
  visibility: number
  /** Reference body scale (shoulder→hip span, normalized) for velocity context. */
  scale: number
}

const VISIBILITY_FLOOR = 0.4

/**
 * Reduce a frame's 33 landmarks to the single vertical value this exercise tracks
 * (mean y of the configured landmarks). Returns null when the tracked points are
 * not confidently visible, so the rep detector can ignore the frame.
 */
export const extractSignal = (landmarks: Landmark[], cfg: ExerciseConfig): SignalSample | null => {
  let sum = 0
  let count = 0
  let minVis = 1
  for (const idx of cfg.trackedLandmarks) {
    const p = landmarks[idx]
    if (!p) continue
    const vis = p.visibility ?? 1
    sum += p.y
    minVis = Math.min(minVis, vis)
    count += 1
  }
  if (count === 0 || minVis < VISIBILITY_FLOOR) return null

  const shoulder = landmarks[POSE.leftShoulder] ?? landmarks[POSE.rightShoulder]
  const hip = landmarks[POSE.leftHip] ?? landmarks[POSE.rightHip]
  const scale = shoulder && hip ? Math.max(0.05, Math.abs(hip.y - shoulder.y)) : 0.3

  return { y: sum / count, visibility: minVis, scale }
}
