// Domain types. Everything is plain data — no classes.

export type ExerciseId = 'pullup' | 'squat' | 'bench' | 'deadlift'
export type Phase = 'eccentric' | 'concentric'
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

/** Metrics for one completed repetition. Timings are derived from frame media-time. */
export interface RepMetrics {
  index: number // 1-based position within the set
  eccentricMs: number
  concentricMs: number
  eccentricFrames: number
  concentricFrames: number
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
