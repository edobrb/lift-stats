import type { Phase, RepMetrics } from '../types'
import type { ExerciseConfig } from '../config/exercises'
import { createOneEuro, oneEuroStep, type OneEuroState } from './filters'

// Rep + phase detection from the 1-D vertical signal.
//
// Pipeline (per the research): median(3) → One-Euro → adaptive normalize → a small
// state machine with hysteresis, ROM gating and a refractory period. Phase labels
// are decoupled from screen direction via the gravity invariant: for an upright
// side-on camera the load moving DOWN (image-y increasing) is always the eccentric
// phase, and moving UP is concentric — true for all four lifts. `startsWith` only
// decides where a rep boundary sits, so squat (starts at top) and deadlift (starts
// at bottom) both yield exactly one count per full cycle.
//
// Functions mutate the passed-in state for per-frame performance (no classes); each
// `step` returns the reps completed on that frame (usually 0, occasionally 1).

const HYSTERESIS_FRACTION = 0.18 // retrace past an extreme to confirm a turn
const ROM_GATE_FRACTION = 0.5 // a half-rep must clear this fraction of running ROM
const REFRACTORY_S = 0.25 // min seconds between confirmed turns
const MIN_PHASE_MS = 120 // a valid half-phase lasts at least this long
const EXTREME_EMA = 0.3 // how fast the adaptive top/bottom levels track
const MEDIAN_WINDOW = 3

type MachineState = 'wait' | 'descending' | 'ascending'

interface Mark {
  y: number
  t: number // seconds (media time)
  frame: number
}

interface HalfPhase {
  phase: Phase
  startT: number
  endT: number
  startFrame: number
  endFrame: number
  rom: number
  peakVelocity: number
}

export interface RepDetectorState {
  cfg: ExerciseConfig
  euro: OneEuroState
  medianBuf: number[]
  state: MachineState
  initialized: boolean
  // extrema observed while waiting for the first movement
  waitMin: Mark
  waitMax: Mark
  // the active monotonic run
  phaseStart: Mark // the extreme where the current phase began
  run: Mark // the most extreme point reached so far this phase
  phasePeakVelocity: number
  lastY: number
  lastT: number
  // adaptive range
  topLevel: number // EMA of confirmed top extremes (min y)
  bottomLevel: number // EMA of confirmed bottom extremes (max y)
  // pairing
  pending: HalfPhase | null
  lastTurnT: number
  reps: RepMetrics[]
  // live readout
  currentPhase: Phase | null
  smoothedY: number
}

const mark = (y: number, t: number, frame: number): Mark => ({ y, t, frame })

export const createRepDetector = (cfg: ExerciseConfig): RepDetectorState => ({
  cfg,
  euro: createOneEuro(),
  medianBuf: [],
  state: 'wait',
  initialized: false,
  waitMin: mark(1, 0, 0),
  waitMax: mark(0, 0, 0),
  phaseStart: mark(0, 0, 0),
  run: mark(0, 0, 0),
  phasePeakVelocity: 0,
  lastY: 0,
  lastT: 0,
  topLevel: 0,
  bottomLevel: 0,
  pending: null,
  lastTurnT: -999,
  reps: [],
  currentPhase: null,
  smoothedY: 0,
})

const median = (buf: number[], v: number): number => {
  buf.push(v)
  if (buf.length > MEDIAN_WINDOW) buf.shift()
  const sorted = [...buf].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? v
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const durationSec = (h: HalfPhase): number => Math.max(1e-3, h.endT - h.startT)

const closeHalf = (s: RepDetectorState, phase: Phase): HalfPhase => ({
  phase,
  startT: s.phaseStart.t,
  endT: s.run.t,
  startFrame: s.phaseStart.frame,
  endFrame: s.run.frame,
  rom: Math.abs(s.run.y - s.phaseStart.y),
  peakVelocity: s.phasePeakVelocity,
})

const formRep = (s: RepDetectorState, first: HalfPhase, second: HalfPhase): RepMetrics => {
  const ecc = first.phase === 'eccentric' ? first : second
  const con = first.phase === 'concentric' ? first : second
  const rep: RepMetrics = {
    index: s.reps.length + 1,
    eccentricMs: durationSec(ecc) * 1000,
    concentricMs: durationSec(con) * 1000,
    eccentricFrames: Math.max(0, ecc.endFrame - ecc.startFrame),
    concentricFrames: Math.max(0, con.endFrame - con.startFrame),
    rangeOfMotion: (ecc.rom + con.rom) / 2,
    peakVelocity: Math.max(ecc.peakVelocity, con.peakVelocity),
    meanConcentricVelocity: con.rom / durationSec(con),
    startMs: first.startT * 1000,
    endMs: second.endT * 1000,
  }
  s.reps.push(rep)
  return rep
}

// Pair completed half-phases into reps, respecting which phase the rep starts with.
const acceptHalf = (s: RepDetectorState, half: HalfPhase, gate: number, out: RepMetrics[]): void => {
  if (half.rom < gate || durationSec(half) * 1000 < MIN_PHASE_MS) return // noise / partial
  if (s.pending === null || s.pending.phase === half.phase) {
    s.pending = half
  } else if (s.pending.phase === s.cfg.startsWith) {
    out.push(formRep(s, s.pending, half))
    s.pending = null
  } else {
    s.pending = half // the pending was a trailing half; this one starts a rep
  }
}

/**
 * Advance the detector by one sample. `y` is the raw tracked vertical position
 * (0 top … 1 bottom), `t` the frame media-time in seconds, `frame` its index.
 * Returns reps completed on this frame.
 */
export const stepRepDetector = (
  s: RepDetectorState,
  rawY: number,
  t: number,
  frame: number,
): RepMetrics[] => {
  const completed: RepMetrics[] = []
  const smoothed = oneEuroStep(s.euro, median(s.medianBuf, rawY), t)
  s.euro = smoothed.state
  const y = smoothed.value
  s.smoothedY = y

  if (!s.initialized) {
    s.initialized = true
    s.lastY = y
    s.lastT = t
    s.waitMin = mark(y, t, frame)
    s.waitMax = mark(y, t, frame)
    s.topLevel = y
    s.bottomLevel = y
    return completed
  }

  const dt = Math.max(1e-3, t - s.lastT)
  const velocity = Math.abs((y - s.lastY) / dt)

  const rom = Math.max(s.cfg.minRangeOfMotion, s.bottomLevel - s.topLevel)
  const hysteresis = Math.max(0.02, HYSTERESIS_FRACTION * rom)
  const gate = Math.max(s.cfg.minRangeOfMotion * 0.6, ROM_GATE_FRACTION * rom)
  const refractoryOk = t - s.lastTurnT > REFRACTORY_S

  switch (s.state) {
    case 'wait': {
      if (y < s.waitMin.y) s.waitMin = mark(y, t, frame)
      if (y > s.waitMax.y) s.waitMax = mark(y, t, frame)
      if (y > s.waitMin.y + hysteresis) {
        // first motion is downward → eccentric, starting from the top apex
        s.phaseStart = s.waitMin
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        s.state = 'descending'
        s.currentPhase = 'eccentric'
      } else if (y < s.waitMax.y - hysteresis) {
        // first motion is upward → concentric, starting from the bottom
        s.phaseStart = s.waitMax
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        s.state = 'ascending'
        s.currentPhase = 'concentric'
      }
      break
    }
    case 'descending': {
      if (y > s.run.y) s.run = mark(y, t, frame)
      if (velocity > s.phasePeakVelocity) s.phasePeakVelocity = velocity
      if (refractoryOk && y < s.run.y - hysteresis) {
        const half = closeHalf(s, 'eccentric') // top → bottom
        s.bottomLevel = lerp(s.bottomLevel, s.run.y, EXTREME_EMA)
        s.lastTurnT = t
        s.phaseStart = s.run // new phase starts at the bottom
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        s.state = 'ascending'
        s.currentPhase = 'concentric'
        acceptHalf(s, half, gate, completed)
      }
      break
    }
    case 'ascending': {
      if (y < s.run.y) s.run = mark(y, t, frame)
      if (velocity > s.phasePeakVelocity) s.phasePeakVelocity = velocity
      if (refractoryOk && y > s.run.y + hysteresis) {
        const half = closeHalf(s, 'concentric') // bottom → top
        s.topLevel = lerp(s.topLevel, s.run.y, EXTREME_EMA)
        s.lastTurnT = t
        s.phaseStart = s.run // new phase starts at the top
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        s.state = 'descending'
        s.currentPhase = 'eccentric'
        acceptHalf(s, half, gate, completed)
      }
      break
    }
  }

  s.lastY = y
  s.lastT = t
  return completed
}

/** Milliseconds elapsed in the phase currently in progress (0 while waiting). */
export const currentPhaseElapsedMs = (s: RepDetectorState, t: number): number =>
  s.state === 'wait' ? 0 : Math.max(0, (t - s.phaseStart.t) * 1000)

/**
 * Close out the set: the final half-phase is normally only confirmed once the lifter
 * reverses direction, so a set that ends at lockout (or at the bottom) would otherwise
 * drop its last rep. Call once when tracking stops to flush the in-progress phase using
 * the extreme reached so far. Returns any rep completed by the flush.
 */
export const finalizeRepDetector = (s: RepDetectorState): RepMetrics[] => {
  const out: RepMetrics[] = []
  if (!s.initialized || s.state === 'wait') return out
  const rom = Math.max(s.cfg.minRangeOfMotion, s.bottomLevel - s.topLevel)
  const gate = Math.max(s.cfg.minRangeOfMotion * 0.6, ROM_GATE_FRACTION * rom)
  acceptHalf(s, closeHalf(s, s.state === 'descending' ? 'eccentric' : 'concentric'), gate, out)
  s.state = 'wait'
  s.currentPhase = null
  return out
}
