import type { ExerciseId, Phase } from '../types'

// MediaPipe Pose 33-landmark indices (only the ones we use).
export const POSE = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const

export interface ExerciseConfig {
  id: ExerciseId
  name: string
  emoji: string
  /**
   * Which physical phase the rep begins with. Squat & bench start by lowering
   * (eccentric); deadlift & pull-up start by lifting (concentric). The detector
   * uses this only to decide where a rep boundary falls — the eccentric/concentric
   * *labels* come from the gravity invariant (load moving down = eccentric).
   */
  startsWith: Phase
  /** Minimum vertical travel (fraction of frame height) for movement to count. */
  minRangeOfMotion: number
  /** Landmark indices whose averaged y is the tracked 1-D signal. */
  trackedLandmarks: number[]
  guidance: string
}

export const EXERCISES: Record<ExerciseId, ExerciseConfig> = {
  pullup: {
    id: 'pullup',
    name: 'Pull-up',
    emoji: '🧗',
    startsWith: 'concentric',
    minRangeOfMotion: 0.06,
    trackedLandmarks: [POSE.leftShoulder, POSE.rightShoulder],
    guidance: 'Film from the front or slightly to the side. Keep your torso in frame from hang to chin-over-bar.',
  },
  squat: {
    id: 'squat',
    name: 'Squat',
    emoji: '🏋️',
    startsWith: 'eccentric',
    minRangeOfMotion: 0.08,
    trackedLandmarks: [POSE.leftHip, POSE.rightHip],
    guidance: 'Film from the side with your whole body in frame, lights in front of you.',
  },
  bench: {
    id: 'bench',
    name: 'Bench Press',
    emoji: '💪',
    startsWith: 'eccentric',
    minRangeOfMotion: 0.04,
    trackedLandmarks: [POSE.leftWrist, POSE.rightWrist],
    guidance: 'Film from the side at roughly bench height. Keep both wrists visible the whole set.',
  },
  deadlift: {
    id: 'deadlift',
    name: 'Deadlift',
    emoji: '🪨',
    startsWith: 'concentric',
    minRangeOfMotion: 0.08,
    trackedLandmarks: [POSE.leftHip, POSE.rightHip],
    guidance: 'Film from the side with your whole body in frame from floor to lockout.',
  },
}

export const EXERCISE_ORDER: ExerciseId[] = ['pullup', 'squat', 'bench', 'deadlift']

export const getExercise = (id: ExerciseId): ExerciseConfig => EXERCISES[id]
