// Domain types. Everything is plain data — no classes.

export type ExerciseId = 'pullup' | 'squat' | 'bench' | 'deadlift'
export type Phase = 'eccentric' | 'concentric'
/**
 * The kind of phase shown live on the HUD. Beyond the two moving phases the lifter
 * can be HOLDING still at an extreme — at the top of the lift (`holdTop`, the user's
 * "fermo top") or at the bottom (`holdBottom`, "fermo bottom"). These dwell phases are
 * counted separately so a pause is never folded into the adjacent moving phase.
 */
export type PhaseKind = Phase | 'holdTop' | 'holdBottom'
export type WeightUnit = 'kg' | 'lb'

/** A single body keypoint in normalized image coordinates (origin top-left, 0..1). */
export interface Landmark {
  x: number
  y: number
  z: number
  visibility?: number
}

export interface Profile {
  id: string
  name: string
  createdAt: number
}

/**
 * Metrics for one completed repetition. Timings are derived from frame media-time.
 *
 * `eccentricMs`/`concentricMs` count ONLY time the load was actually moving. Time the
 * lifter spent paused/holding still at an extreme is reported separately as
 * `holdTopMs` (paused at the top of the lift) and `holdBottomMs` (paused at the bottom),
 * so a dwell is never wrongly folded into a moving phase. The hold fields are optional:
 * sets saved before holds were detected lack them and must be treated as 0 everywhere.
 */
export interface RepMetrics {
  index: number // 1-based position within the set
  eccentricMs: number // moving-down time only
  concentricMs: number // moving-up time only
  eccentricFrames: number
  concentricFrames: number
  holdTopMs?: number // paused at the top of the lift (optional, missing → 0)
  holdBottomMs?: number // paused at the bottom of the lift (optional, missing → 0)
  holdTopFrames?: number
  holdBottomFrames?: number
  rangeOfMotion: number // normalized fraction of frame height (0..1)
  peakVelocity: number // normalized units per second (max over the rep)
  meanConcentricVelocity: number // normalized units per second
  startMs: number // media-time at rep start (ms)
  endMs: number // media-time at rep end (ms)
}

export interface LiftSet {
  id: string
  profileId: string
  exercise: ExerciseId
  weight: number | null
  unit: WeightUnit
  startedAt: number // epoch ms
  durationMs: number
  fps: number
  reps: RepMetrics[]
  repCount: number
  hasVideo: boolean
  videoMime: string | null
  notes: string
}

/** Stored separately from the set record so listings stay lightweight. */
export interface SetVideo {
  setId: string
  blob: Blob
  mime: string
}
