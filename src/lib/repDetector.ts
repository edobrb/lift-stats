import type { Phase, PhaseKind, RepMetrics } from '../types'
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
// MOVING vs HOLD. Eccentric/concentric durations count ONLY while the load is actually
// moving. A lifter often pauses still at an extreme (standing at the top of a squat
// between reps, the chest pause of a paused bench): that dwell is detected as its own
// phase — "hold top" / "hold bottom" — by a displacement-over-a-window classifier (net
// progress stalls ⇒ a hold; sustained progress ⇒ moving), and accumulated separately so
// it is never folded into the adjacent moving phase. A hold is classed top/bottom by
// where it sits in the running ROM (image-y increases DOWNWARD, so top = smaller y).
//
// Functions mutate the passed-in state for per-frame performance (no classes); each
// `step` returns the reps completed on that frame (usually 0, occasionally 1).

const HYSTERESIS_FRACTION = 0.18 // retrace past an extreme to confirm a turn
const ROM_GATE_FRACTION = 0.5 // a half-rep must clear this fraction of running ROM
const REFRACTORY_S = 0.25 // min seconds between confirmed turns
const MIN_PHASE_MS = 120 // a valid half-phase lasts at least this long
const EXTREME_EMA = 0.3 // how fast the adaptive top/bottom levels track
const MEDIAN_WINDOW = 3

// Moving/hold classifier. Instantaneous velocity is too noisy to separate a true pause
// from a slow grind (camera jitter alone produces velocity spikes well above any sane
// threshold). Instead we judge NET PROGRESS over a short trailing window of the
// median-filtered signal: the displacement between the window's endpoints is unbiased by
// zero-mean jitter (which oscillates and averages out), so a genuine hold reads ≈0 even on
// noisy real footage while even a slow ~3s phase still advances steadily. (A max−min RANGE
// would instead be positively biased by noise and read a real hold as movement.) The load
// is STILL when net |Δy| over the last HOLD_WINDOW_MS is below STILL_DISP×rom, and MOVING
// once it exceeds MOVE_DISP×rom (the gap is hysteresis against flicker). A dwell must last
// at least MIN_HOLD_MS to be promoted from "slow movement" to a real hold.
const HOLD_WINDOW_MS = 200 // trailing window over which net progress is measured
const STILL_DISP_FRAC = 0.06 // below this fraction of ROM over the window ⇒ still
const MOVE_DISP_FRAC = 0.1 // above this fraction of ROM over the window ⇒ moving
const HOLD_DISP_FLOOR = 0.01 // absolute Δy floor (units) so tiny-ROM lifts shrug off jitter
const MIN_HOLD_MS = 120 // a dwell must last at least this long to count as a hold
// How far net progress must climb above its resting floor for the load to count as having
// DEPARTED the extreme (ending the hold). Kept just above per-frame jitter so the departure
// — and thus the next phase's start — is detected within a frame or two of true onset.
const DEPART_MARGIN_FLOOR = 0.008
const DEPART_MARGIN_FRAC = 0.025

type MachineState = 'wait' | 'descending' | 'ascending'

interface Mark {
  y: number
  t: number // seconds (media time)
  frame: number
}

// A completed moving half-phase, carrying the dwell that immediately followed the
// extreme it reached. `holdAfterMs`/`holdAfterFrames` is the still time spent at the
// reached extreme before the phase was confirmed to have turned around — it belongs to
// the rep as a hold (top or bottom depending on this phase's direction).
interface HalfPhase {
  phase: Phase
  startT: number
  endT: number // media-time the load stopped MOVING (start of the trailing dwell)
  startFrame: number
  endFrame: number
  movingMs: number
  movingFrames: number
  holdAfterMs: number
  holdAfterFrames: number
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
  // The moving/hold classifier runs off the median-filtered signal, NOT the One-Euro
  // output: One-Euro lags ~0.2s, so during a real pause its value is still catching up to
  // the extreme and would read as slow movement, masking the hold. The median signal
  // plateaus immediately. `motionWindow` is a trailing ring of recent median samples over
  // which net progress (displacement) is measured to tell a hold from a slow grind.
  motionWindow: Mark[]
  // moving/hold accounting within the active phase
  movingMs: number // time classified as moving so far this phase
  movingFrames: number
  dwellMs: number // contiguous still-time accumulated at the current rest (candidate hold)
  dwellFrames: number
  // The portion of the current dwell during which the load was GENUINELY at rest (net
  // progress below the still threshold). Once the load starts departing the extreme its net
  // progress climbs into the still→move band before the move threshold is finally crossed;
  // that trailing "drift" is the load already moving, not holding. Tracking the rest portion
  // lets us back-date the hold's end to the departure point (so the next moving phase starts
  // when the lifter actually started moving, not ~10 frames later when detection caught up).
  dwellRestMs: number
  dwellRestFrames: number
  dwellMinDisp: number // lowest net-progress seen this dwell (the rest "floor"); the load is
  // judged to have DEPARTED once progress rises a small margin above it — adapting to the
  // actual jitter level rather than a fixed threshold, so departure is caught within a frame
  // or two of true onset regardless of ROM.
  holdMs: number // confirmed still-time this phase (dwell promoted past MIN_HOLD_MS)
  holdFrames: number
  // Once a phase's terminal hold is confirmed, movement that resumes belongs to the NEXT
  // phase (it is the load reversing off the extreme), but the turn isn't geometrically
  // confirmed until ~hysteresis of retrace. We bank that resumed-moving time here and
  // seed the next phase with it, so it isn't mis-attributed to the phase just ended.
  postHoldMovingMs: number
  postHoldMovingFrames: number
  moving: boolean // classifier hysteresis state: is the load currently moving?
  // adaptive range
  topLevel: number // EMA of confirmed top extremes (min y)
  bottomLevel: number // EMA of confirmed bottom extremes (max y)
  // pairing
  pending: HalfPhase | null
  carryHoldMs: number // hold time at the turnaround, owned by the rep being assembled
  carryHoldFrames: number
  carryHoldKind: 'top' | 'bottom' | null
  lastTurnT: number
  reps: RepMetrics[]
  // live readout
  currentPhase: PhaseKind | null
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
  motionWindow: [],
  movingMs: 0,
  movingFrames: 0,
  dwellMs: 0,
  dwellFrames: 0,
  dwellRestMs: 0,
  dwellRestFrames: 0,
  dwellMinDisp: 0,
  holdMs: 0,
  holdFrames: 0,
  postHoldMovingMs: 0,
  postHoldMovingFrames: 0,
  moving: true,
  topLevel: 0,
  bottomLevel: 0,
  pending: null,
  carryHoldMs: 0,
  carryHoldFrames: 0,
  carryHoldKind: null,
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
// Moving duration, floored so a degenerate phase never zeroes a tempo.
const movingSec = (h: HalfPhase): number => Math.max(1e-3, h.movingMs / 1000)

// Reset the per-phase moving/hold accumulators at a new phase boundary. The new phase
// inherits any moving time that was banked while the previous phase's terminal hold was
// already over (the reversal off the extreme that the geometry hadn't confirmed yet).
const resetPhaseAccounting = (s: RepDetectorState): void => {
  s.movingMs = s.postHoldMovingMs
  s.movingFrames = s.postHoldMovingFrames
  s.postHoldMovingMs = 0
  s.postHoldMovingFrames = 0
  s.dwellMs = 0
  s.dwellFrames = 0
  s.dwellRestMs = 0
  s.dwellRestFrames = 0
  s.dwellMinDisp = 0
  s.holdMs = 0
  s.holdFrames = 0
  s.moving = true
}

const closeHalf = (s: RepDetectorState, phase: Phase): HalfPhase => {
  // Any unpromoted dwell still in progress at the turn is genuine rest at the
  // reached extreme — fold it into the phase's hold total.
  const holdMs = s.holdMs + s.dwellMs
  const holdFrames = s.holdFrames + s.dwellFrames
  return {
    phase,
    startT: s.phaseStart.t,
    endT: s.run.t,
    startFrame: s.phaseStart.frame,
    endFrame: s.run.frame,
    movingMs: s.movingMs,
    movingFrames: s.movingFrames,
    holdAfterMs: holdMs,
    holdAfterFrames: holdFrames,
    rom: Math.abs(s.run.y - s.phaseStart.y),
    peakVelocity: s.phasePeakVelocity,
  }
}

// Assemble two paired half-phases into a rep. Each half carries the dwell that followed
// it; the timeline order of a rep is the two moving phases each followed by their hold:
//   squat/bench (eccentric-first):  eccentric + holdBottom + concentric + holdTop
//   deadlift/pullup (concentric-first): concentric + holdTop + eccentric + holdBottom
// The eccentric phase always ends at the bottom, so its trailing hold is holdBottom; the
// concentric ends at the top, so its trailing hold is holdTop. `carryHold*` only applies
// in the edge case where detection begins mid-rep on a trailing half: the dwell from the
// rep's starting extreme is carried in so it isn't lost (0 in the normal settle→reps case).
const formRep = (s: RepDetectorState, first: HalfPhase, second: HalfPhase): RepMetrics => {
  const ecc = first.phase === 'eccentric' ? first : second
  const con = first.phase === 'concentric' ? first : second
  // Trailing dwell of each moving phase, classed by where that phase ended.
  const holdBottomFromEcc = ecc.holdAfterMs
  const holdTopFromCon = con.holdAfterMs
  const holdBottomFromEccFrames = ecc.holdAfterFrames
  const holdTopFromConFrames = con.holdAfterFrames
  // The dwell carried in from the rep's starting extreme.
  const carriedTopMs = s.carryHoldKind === 'top' ? s.carryHoldMs : 0
  const carriedBottomMs = s.carryHoldKind === 'bottom' ? s.carryHoldMs : 0
  const carriedTopFrames = s.carryHoldKind === 'top' ? s.carryHoldFrames : 0
  const carriedBottomFrames = s.carryHoldKind === 'bottom' ? s.carryHoldFrames : 0

  const holdTopMs = holdTopFromCon + carriedTopMs
  const holdBottomMs = holdBottomFromEcc + carriedBottomMs
  const holdTopFrames = holdTopFromConFrames + carriedTopFrames
  const holdBottomFrames = holdBottomFromEccFrames + carriedBottomFrames

  const rep: RepMetrics = {
    index: s.reps.length + 1,
    eccentricMs: movingSec(ecc) * 1000,
    concentricMs: movingSec(con) * 1000,
    eccentricFrames: ecc.movingFrames,
    concentricFrames: con.movingFrames,
    holdTopMs,
    holdBottomMs,
    holdTopFrames,
    holdBottomFrames,
    rangeOfMotion: (ecc.rom + con.rom) / 2,
    peakVelocity: Math.max(ecc.peakVelocity, con.peakVelocity),
    meanConcentricVelocity: con.rom / movingSec(con),
    startMs: first.startT * 1000,
    // The rep ends when its second moving phase finishes its trailing dwell, so the
    // editor's end handle sits past the pause rather than at the extreme.
    endMs: (second.endT + second.holdAfterMs / 1000) * 1000,
  }
  s.reps.push(rep)
  // The hold carried into this rep has now been consumed.
  s.carryHoldMs = 0
  s.carryHoldFrames = 0
  s.carryHoldKind = null
  return rep
}

// Pair completed half-phases into reps, respecting which phase the rep starts with.
const acceptHalf = (s: RepDetectorState, half: HalfPhase, gate: number, out: RepMetrics[]): void => {
  if (half.rom < gate || half.movingMs < MIN_PHASE_MS) return // noise / partial
  if (s.pending === null || s.pending.phase === half.phase) {
    s.pending = half
  } else if (s.pending.phase === s.cfg.startsWith) {
    out.push(formRep(s, s.pending, half))
    s.pending = null
  } else {
    // The pending was a trailing half; this one starts a rep. The pending's trailing
    // dwell becomes the new rep's starting (carried) hold so it isn't lost.
    s.carryHoldMs = s.pending.holdAfterMs
    s.carryHoldFrames = s.pending.holdAfterFrames
    s.carryHoldKind = s.pending.phase === 'eccentric' ? 'bottom' : 'top'
    s.pending = half
  }
}

// Push the latest median sample into the trailing motion window and return the net signed
// progress (|y_now − y_window_start|) across it. Endpoint progress — unlike a max−min RANGE
// — is NOT positively biased by zero-mean camera jitter (which oscillates and cancels over
// the window), so a genuine hold reads ≈0 even on noisy real footage while steady movement
// still advances. The samples are already median(3)-filtered, so the endpoints are smooth.
const windowDisplacement = (s: RepDetectorState, medianY: number, t: number, frame: number): number => {
  const win = s.motionWindow
  win.push(mark(medianY, t, frame))
  const cutoff = t - HOLD_WINDOW_MS / 1000
  while (win.length > 1 && win[0]!.t < cutoff) win.shift()
  return Math.abs(win[win.length - 1]!.y - win[0]!.y)
}

// Classify this sample as moving/still from the windowed displacement and tally its
// time into moving vs hold. `disp` is the net |Δy| over the trailing window; `still`/
// `move` are the hysteresis thresholds (units). `reversing` is true when the load is
// pulling back AWAY from the run extreme. Once a phase's terminal hold has been confirmed,
// the motion that resumes is the NEXT phase reversing off that extreme, so it is banked
// into postHoldMoving rather than this phase's movingMs — but ONLY when actually reversing.
const classifyMotion = (
  s: RepDetectorState,
  disp: number,
  dtMs: number,
  still: number,
  move: number,
  departMargin: number,
  reversing: boolean,
): void => {
  const creditMoving = (ms: number, frames: number): void => {
    // A confirmed hold (holdMs>0) followed by motion REVERSING off the extreme belongs to
    // the next phase. A mid-phase pause (a sticking point) also sets holdMs>0, but the load
    // then CONTINUES in the same direction (not reversing) — that motion must stay in THIS
    // phase, else the rest of the phase would leak into the next one (squashing this phase's
    // tempo and inflating the next).
    if (s.holdMs > 0 && reversing) {
      s.postHoldMovingMs += ms
      s.postHoldMovingFrames += frames
    } else {
      s.movingMs += ms
      s.movingFrames += frames
    }
  }
  if (s.moving) {
    if (disp < still) {
      // Progress has stalled → start accumulating a candidate dwell. This first frame is
      // genuinely at rest, so it seeds the rest portion and the rest "floor".
      s.moving = false
      s.dwellMs = dtMs
      s.dwellFrames = 1
      s.dwellRestMs = dtMs
      s.dwellRestFrames = 1
      s.dwellMinDisp = disp
    } else {
      creditMoving(dtMs, 1)
    }
    return
  }
  // Currently still.
  if (disp > move) {
    // Progress resumed. Split the dwell at the moment the load actually started departing:
    // the REST portion (net progress stayed below `still`) is the real hold; the trailing
    // DRIFT (dwellMs − dwellRest, where progress had climbed into the still→move band) is
    // the load already moving but not yet over the move threshold. Crediting the drift as
    // movement back-dates the hold's end to the departure, so the next phase begins ~when
    // the lifter actually started moving rather than ~10 frames later at detection.
    const driftMs = s.dwellMs - s.dwellRestMs
    const driftFrames = s.dwellFrames - s.dwellRestFrames
    if (s.dwellRestMs < MIN_HOLD_MS) {
      // The genuine rest was too brief to be a real hold — it was all just slow movement.
      creditMoving(s.dwellMs, s.dwellFrames)
    } else {
      s.holdMs += s.dwellRestMs
      s.holdFrames += s.dwellRestFrames
      creditMoving(driftMs, driftFrames)
    }
    s.dwellMs = 0
    s.dwellFrames = 0
    s.dwellRestMs = 0
    s.dwellRestFrames = 0
    s.moving = true
    creditMoving(dtMs, 1)
  } else {
    // Still stalled → keep accumulating the candidate dwell. The rest portion tracks the
    // dwell while net progress stays near its running floor (within departMargin); once
    // progress climbs a margin above the floor — the load departing the extreme — the rest
    // portion FREEZES, marking where the hold really ended (the trailing climb up to the
    // move threshold is then back-dated to movement). Judging departure relative to the
    // floor, not a fixed level, catches it within a frame or two of true onset.
    s.dwellMs += dtMs
    s.dwellFrames += 1
    s.dwellMinDisp = Math.min(s.dwellMinDisp, disp)
    if (disp <= s.dwellMinDisp + departMargin) {
      s.dwellRestMs = s.dwellMs
      s.dwellRestFrames = s.dwellFrames
    }
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
  const medianY = median(s.medianBuf, rawY)
  const smoothed = oneEuroStep(s.euro, medianY, t)
  s.euro = smoothed.state
  const y = smoothed.value
  s.smoothedY = y

  if (!s.initialized) {
    s.initialized = true
    s.lastY = y
    s.lastT = t
    s.motionWindow = [mark(medianY, t, frame)]
    s.waitMin = mark(y, t, frame)
    s.waitMax = mark(y, t, frame)
    s.topLevel = y
    s.bottomLevel = y
    return completed
  }

  const dt = Math.max(1e-3, t - s.lastT)
  const dtMs = dt * 1000
  const velocity = Math.abs((y - s.lastY) / dt)

  const rom = Math.max(s.cfg.minRangeOfMotion, s.bottomLevel - s.topLevel)
  const hysteresis = Math.max(0.02, HYSTERESIS_FRACTION * rom)
  const gate = Math.max(s.cfg.minRangeOfMotion * 0.6, ROM_GATE_FRACTION * rom)
  const refractoryOk = t - s.lastTurnT > REFRACTORY_S
  // Net progress over the trailing window, and the ROM-scaled hold/move thresholds the
  // classifier judges it against (with an absolute floor so tiny-ROM lifts still work).
  const disp = windowDisplacement(s, medianY, t, frame)
  const stillThresh = Math.max(HOLD_DISP_FLOOR, STILL_DISP_FRAC * rom)
  const moveThresh = Math.max(HOLD_DISP_FLOOR * 2, MOVE_DISP_FRAC * rom)
  const departMargin = Math.max(DEPART_MARGIN_FLOOR, DEPART_MARGIN_FRAC * rom)

  switch (s.state) {
    case 'wait': {
      if (y < s.waitMin.y) s.waitMin = mark(y, t, frame)
      if (y > s.waitMax.y) s.waitMax = mark(y, t, frame)
      if (y > s.waitMin.y + hysteresis) {
        // First motion is downward → eccentric. Anchor the phase at the top apex's Y (for
        // ROM) but timestamp it NOW — the moment motion began — so the discarded settle time
        // isn't baked into the first rep's start boundary.
        s.phaseStart = mark(s.waitMin.y, t, frame)
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        resetPhaseAccounting(s)
        s.movingMs = dtMs
        s.movingFrames = 1
        s.state = 'descending'
        s.currentPhase = 'eccentric'
      } else if (y < s.waitMax.y - hysteresis) {
        // First motion is upward → concentric. Anchor the bottom apex's Y, timestamp now.
        s.phaseStart = mark(s.waitMax.y, t, frame)
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        resetPhaseAccounting(s)
        s.movingMs = dtMs
        s.movingFrames = 1
        s.state = 'ascending'
        s.currentPhase = 'concentric'
      }
      break
    }
    case 'descending': {
      if (velocity > s.phasePeakVelocity) s.phasePeakVelocity = velocity
      // Reversing = pulling back UP, away from the bottom extreme reached so far.
      const reversing = y < s.run.y
      classifyMotion(s, disp, dtMs, stillThresh, moveThresh, departMargin, reversing)
      // Track the extreme position, but freeze its TIMESTAMP once the load stalls: during a
      // long hold, jitter keeps nudging y to fractionally-new extrema and an unfrozen run.t
      // (= the phase's endT) would creep through the whole dwell, double-counting the hold in
      // endMs and inflating the rep's drawn span. While moving, the time tracks the extreme.
      if (y > s.run.y) s.run = mark(y, s.moving ? t : s.run.t, s.moving ? frame : s.run.frame)
      // Live HUD: a sustained dwell in a descending phase is a pause at/near the bottom.
      s.currentPhase = !s.moving && s.dwellMs >= MIN_HOLD_MS ? 'holdBottom' : 'eccentric'
      if (refractoryOk && y < s.run.y - hysteresis) {
        const half = closeHalf(s, 'eccentric') // top → bottom
        s.bottomLevel = lerp(s.bottomLevel, s.run.y, EXTREME_EMA)
        s.lastTurnT = t
        // The new phase starts at the extreme just reached, but AFTER the trailing dwell
        // that belongs to the half just closed (folded into the prior rep's endMs). Keep
        // y at the extreme so ROM is unchanged; advance only t/frame past the hold so the
        // next rep's startMs == the prior rep's endMs (no overlap of the hold).
        s.phaseStart = mark(s.run.y, s.run.t + half.holdAfterMs / 1000, s.run.frame + half.holdAfterFrames)
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        // Seeds movingMs from the reversal time already banked since the hold ended.
        resetPhaseAccounting(s)
        s.state = 'ascending'
        s.currentPhase = 'concentric'
        acceptHalf(s, half, gate, completed)
      }
      break
    }
    case 'ascending': {
      if (velocity > s.phasePeakVelocity) s.phasePeakVelocity = velocity
      // Reversing = dropping back DOWN, away from the top extreme reached so far.
      const reversing = y > s.run.y
      classifyMotion(s, disp, dtMs, stillThresh, moveThresh, departMargin, reversing)
      // Freeze the extreme's timestamp once stalled (see the descending case for why).
      if (y < s.run.y) s.run = mark(y, s.moving ? t : s.run.t, s.moving ? frame : s.run.frame)
      // Live HUD: a sustained dwell in an ascending phase is a pause at/near the top.
      s.currentPhase = !s.moving && s.dwellMs >= MIN_HOLD_MS ? 'holdTop' : 'concentric'
      if (refractoryOk && y > s.run.y + hysteresis) {
        const half = closeHalf(s, 'concentric') // bottom → top
        s.topLevel = lerp(s.topLevel, s.run.y, EXTREME_EMA)
        s.lastTurnT = t
        // The new phase starts at the extreme just reached, but AFTER the trailing dwell
        // that belongs to the half just closed (folded into the prior rep's endMs). Keep
        // y at the extreme so ROM is unchanged; advance only t/frame past the hold so the
        // next rep's startMs == the prior rep's endMs (no overlap of the hold).
        s.phaseStart = mark(s.run.y, s.run.t + half.holdAfterMs / 1000, s.run.frame + half.holdAfterFrames)
        s.run = mark(y, t, frame)
        s.phasePeakVelocity = velocity
        // Seeds movingMs from the reversal time already banked since the hold ended.
        resetPhaseAccounting(s)
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

/**
 * Milliseconds elapsed in the phase currently in progress (0 while waiting). While the
 * live phase is a HOLD the timer reflects the dwell so far (how long the lifter has been
 * paused); while MOVING it reflects the moving-only time accumulated this phase. We use the
 * moving accumulator rather than wall-clock since phaseStart, because phaseStart.t is
 * advanced past the prior hold (so the timeline tiles without overlap) and is therefore not
 * a real "movement began" instant — and the moving-only reading matches the eccentric/
 * concentric semantics the rep ultimately stores.
 */
export const currentPhaseElapsedMs = (s: RepDetectorState, _t: number): number => {
  if (s.state === 'wait') return 0
  if (s.currentPhase === 'holdTop' || s.currentPhase === 'holdBottom') return Math.max(0, s.dwellMs)
  return Math.max(0, s.movingMs)
}

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
