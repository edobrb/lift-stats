// Drives the REAL rep detector with synthetic lift signals and checks rep count
// and eccentric/concentric timing. Run: npm run check
import {
  createRepDetector,
  stepRepDetector,
  finalizeRepDetector,
} from '../src/lib/repDetector'
import { EXERCISES } from '../src/config/exercises'
import { repBounds, applyBounds } from '../src/lib/repEdit'
import type { ExerciseId, RepMetrics } from '../src/types'

interface Sample {
  y: number
  t: number
  frame: number
}

// Deterministic pseudo-noise so runs are reproducible.
let seed = 1234567
const noise = (amp: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return ((seed / 0x7fffffff) * 2 - 1) * amp
}

// Build a triangle-wave signal of `n` reps.
// startsConcentric: deadlift/pullup begin by moving UP (y decreasing) from the bottom.
const buildSignal = (
  n: number,
  opts: { top: number; bottom: number; eccS: number; conS: number; holdS: number; fps: number; startsConcentric: boolean; noiseAmp: number; midHoldS?: number; easeIn?: boolean },
): Sample[] => {
  const { top, bottom, eccS, conS, holdS, fps, startsConcentric, noiseAmp, midHoldS = 0, easeIn = false } = opts
  const dt = 1 / fps
  const samples: Sample[] = []
  let t = 0
  let frame = 0
  const push = (y: number) => {
    samples.push({ y: Math.min(1, Math.max(0, y + noise(noiseAmp))), t, frame })
    t += dt
    frame += 1
  }
  // smoothstep eases the ramp in AND out (slow start, fast middle) — a realistic lift moves
  // off an extreme gradually, which is exactly what makes naive onset detection lag.
  const shape = (p: number) => (easeIn ? p * p * (3 - 2 * p) : p)
  const ramp = (from: number, to: number, secs: number) => {
    const steps = Math.max(1, Math.round(secs / dt))
    for (let i = 1; i <= steps; i++) push(from + (to - from) * shape(i / steps))
  }
  const hold = (y: number, secs: number) => {
    const steps = Math.max(1, Math.round(secs / dt))
    for (let i = 0; i < steps; i++) push(y)
  }
  // A moving phase, optionally with a sticking-point pause at its MIDPOINT (a dwell where
  // the load briefly stops then CONTINUES in the same direction). The phase's moving time
  // must still be measured as `secs` total — the mid pause must not leak into the next phase.
  const movePhase = (from: number, to: number, secs: number) => {
    if (midHoldS > 0) {
      const mid = (from + to) / 2
      ramp(from, mid, secs / 2)
      hold(mid, midHoldS)
      ramp(mid, to, secs / 2)
    } else {
      ramp(from, to, secs)
    }
  }

  // Settle at the starting position.
  hold(startsConcentric ? bottom : top, 0.6)
  for (let r = 0; r < n; r++) {
    if (startsConcentric) {
      movePhase(bottom, top, conS) // concentric (up)
      hold(top, holdS)
      movePhase(top, bottom, eccS) // eccentric (down)
      hold(bottom, holdS)
    } else {
      movePhase(top, bottom, eccS) // eccentric (down)
      hold(bottom, holdS)
      movePhase(bottom, top, conS) // concentric (up)
      hold(top, holdS)
    }
  }
  return samples
}

const run = (exercise: ExerciseId, samples: Sample[]): RepMetrics[] => {
  const detector = createRepDetector(EXERCISES[exercise])
  const reps: RepMetrics[] = []
  for (const s of samples) reps.push(...stepRepDetector(detector, s.y, s.t, s.frame))
  reps.push(...finalizeRepDetector(detector))
  return reps
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

let failures = 0
const expect = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? '✅' : '❌'} ${name} — ${detail}`)
  if (!cond) failures += 1
}

interface Case {
  label: string
  exercise: ExerciseId
  n: number
  eccS: number
  conS: number
  holdS: number // dwell injected at BOTH extremes of every rep
  startsConcentric: boolean
  noiseAmp: number
  midHoldS?: number // optional sticking-point pause at the MIDPOINT of each moving phase
  easeIn?: boolean // ramps accelerate gradually (realistic), which stresses onset latency
  maxOnsetLagMs?: number // assert each rep's first-phase start lags the true onset by < this
}

const cases: Case[] = [
  { label: 'Squat ×5 (clean, 2s ecc / 1s con)', exercise: 'squat', n: 5, eccS: 2.0, conS: 1.0, holdS: 0.25, startsConcentric: false, noiseAmp: 0 },
  { label: 'Squat ×8 (noisy)', exercise: 'squat', n: 8, eccS: 1.5, conS: 0.8, holdS: 0.25, startsConcentric: false, noiseAmp: 0.006 },
  { label: 'Bench ×6 (small ROM, noisy)', exercise: 'bench', n: 6, eccS: 1.2, conS: 0.6, holdS: 0.25, startsConcentric: false, noiseAmp: 0.005 },
  { label: 'Deadlift ×5 (starts concentric)', exercise: 'deadlift', n: 5, eccS: 1.5, conS: 1.2, holdS: 0.25, startsConcentric: true, noiseAmp: 0.004 },
  { label: 'Pull-up ×10 (starts concentric, fast)', exercise: 'pullup', n: 10, eccS: 1.0, conS: 0.9, holdS: 0.25, startsConcentric: true, noiseAmp: 0.004 },
  // Paused squat: a LONG dwell at the bottom (1.5s) must be separated out as holdBottom,
  // leaving the moving ecc/con phases short — not folded into a 3.5s "eccentric".
  { label: 'Paused squat ×4 (1.5s bottom pause)', exercise: 'squat', n: 4, eccS: 1.2, conS: 0.9, holdS: 1.5, startsConcentric: false, noiseAmp: 0.004 },
  // Realistic phone jitter (noiseAmp 0.012, well above the others) with a long 1.5s hold:
  // the net-displacement classifier must still detect the hold rather than letting jitter
  // mask it and fold it into the moving phases.
  { label: 'Squat ×4 (realistic jitter, 1.5s holds)', exercise: 'squat', n: 4, eccS: 1.5, conS: 1.0, holdS: 1.5, startsConcentric: false, noiseAmp: 0.012 },
  // Sticking point: a 0.5s pause MID-eccentric and MID-concentric. The moving ecc/con
  // times must stay ≈ the true ramp durations — the post-pause motion must NOT leak into
  // the next phase (the bug where holdMs>0 wrongly banked all later motion to postHold).
  { label: 'Squat ×4 (0.5s mid-phase sticking pause)', exercise: 'squat', n: 4, eccS: 1.4, conS: 1.0, holdS: 0.25, startsConcentric: false, noiseAmp: 0.004, midHoldS: 0.5 },
  // Realistic gradual acceleration off the extremes (ease-in) with long holds: the down
  // phase of each rep must begin close to the TRUE descent onset, not ~10 frames late once
  // the displacement finally crosses the move threshold. Asserts the onset lag stays small.
  { label: 'Squat ×4 (ease-in onset, 1.0s holds)', exercise: 'squat', n: 4, eccS: 1.4, conS: 1.0, holdS: 1.0, startsConcentric: false, noiseAmp: 0.005, easeIn: true, maxOnsetLagMs: 300 },
]

for (const c of cases) {
  const signal = buildSignal(c.n, {
    top: 0.3,
    bottom: c.exercise === 'bench' ? 0.45 : 0.62,
    eccS: c.eccS,
    conS: c.conS,
    holdS: c.holdS,
    fps: 30,
    startsConcentric: c.startsConcentric,
    noiseAmp: c.noiseAmp,
    midHoldS: c.midHoldS ?? 0,
    easeIn: c.easeIn ?? false,
  })
  const reps = run(c.exercise, signal)
  const avgEcc = mean(reps.map((r) => r.eccentricMs)) / 1000
  const avgCon = mean(reps.map((r) => r.concentricMs)) / 1000
  const avgHoldTop = mean(reps.map((r) => r.holdTopMs ?? 0)) / 1000
  const avgHoldBottom = mean(reps.map((r) => r.holdBottomMs ?? 0)) / 1000

  console.log(`\n${c.label}`)
  console.log(`   reps=${reps.length}/${c.n}  avgEcc=${avgEcc.toFixed(2)}s (want ~${c.eccS})  avgCon=${avgCon.toFixed(2)}s (want ~${c.conS})`)
  console.log(`   avgHoldTop=${avgHoldTop.toFixed(2)}s  avgHoldBottom=${avgHoldBottom.toFixed(2)}s (each want ~${c.holdS})`)
  expect(`${c.label}: rep count`, reps.length >= c.n - 1 && reps.length <= c.n, `got ${reps.length}, expected ${c.n}`)
  if (reps.length > 0) {
    // MOVING-ONLY ecc/con: must track the pure ramp durations and EXCLUDE the holds.
    expect(`${c.label}: eccentric timing (moving only)`, Math.abs(avgEcc - c.eccS) <= c.eccS * 0.3 + 0.15, `${avgEcc.toFixed(2)}s vs ${c.eccS}s`)
    expect(`${c.label}: concentric timing (moving only)`, Math.abs(avgCon - c.conS) <= c.conS * 0.3 + 0.2, `${avgCon.toFixed(2)}s vs ${c.conS}s`)
    // Holds: each extreme's dwell must be detected ≈ the injected holdS, not lost into a
    // moving phase. Tolerance allows for the velocity-band edges trimming a little. Skipped
    // for the mid-phase-pause case, where the sticking-point dwell is (acceptably) folded
    // into the phase's extreme hold bucket and so inflates it beyond holdS.
    if (!c.midHoldS) {
      const holdTol = c.holdS * 0.35 + 0.12
      expect(`${c.label}: hold-top detected`, Math.abs(avgHoldTop - c.holdS) <= holdTol, `${avgHoldTop.toFixed(2)}s vs ${c.holdS}s`)
      expect(`${c.label}: hold-bottom detected`, Math.abs(avgHoldBottom - c.holdS) <= holdTol, `${avgHoldBottom.toFixed(2)}s vs ${c.holdS}s`)
    }
    // Frame counts should be plausible (>0) and consistent with ~30fps.
    const fr = reps[0]!
    expect(`${c.label}: frame counts populated`, fr.eccentricFrames > 0 && fr.concentricFrames > 0, `ecc=${fr.eccentricFrames} con=${fr.concentricFrames} frames`)
    // Hold frames should be populated across the set (the very first rep's leading dwell
    // is the discarded settle, and noise can drop a single rep's hold below MIN_HOLD, so
    // assert on the set average rather than one rep).
    const avgHoldTopFrames = mean(reps.map((r) => r.holdTopFrames ?? 0))
    const avgHoldBottomFrames = mean(reps.map((r) => r.holdBottomFrames ?? 0))
    expect(`${c.label}: hold frame counts populated`, avgHoldTopFrames > 0 && avgHoldBottomFrames > 0, `avg holdTop=${avgHoldTopFrames.toFixed(1)} holdBottom=${avgHoldBottomFrames.toFixed(1)} frames`)

    // Reps must TILE the timeline: each rep's start coincides with the previous rep's end
    // (the trailing hold belongs to the rep that ends, not the next one). Catches the
    // overlap bug where rep N+1 started at the extreme, before rep N's trailing hold ended.
    let maxAdj = 0
    for (let i = 0; i < reps.length - 1; i++) {
      maxAdj = Math.max(maxAdj, Math.abs(reps[i + 1]!.startMs - reps[i]!.endMs))
    }
    expect(`${c.label}: reps contiguous (no overlap)`, maxAdj < 1, `max |start[i+1]-end[i]| = ${maxAdj.toFixed(2)}ms`)

    // A rep's drawn SPAN (end-start) must ≈ the sum of its phase durations. Catches the
    // run.t-creep bug where a long hold's timestamp drift inflated endMs far past the sum,
    // bleeding the rep's editor blocks across its neighbours. Lenient: smoothing/hysteresis
    // make span and sum differ by a little, but never by the ~60% the creep bug produced.
    let maxSpanErr = 0
    for (const r of reps) {
      const span = r.endMs - r.startMs
      const sum = r.eccentricMs + r.concentricMs + (r.holdTopMs ?? 0) + (r.holdBottomMs ?? 0)
      maxSpanErr = Math.max(maxSpanErr, Math.abs(span - sum))
    }
    const meanSpan = mean(reps.map((r) => r.endMs - r.startMs))
    expect(`${c.label}: rep span ≈ sum of phases`, maxSpanErr <= 0.2 * meanSpan + 200, `max |span-sum| = ${maxSpanErr.toFixed(0)}ms (span≈${meanSpan.toFixed(0)}ms)`)

    // Onset latency: the first phase of each rep must begin close to the TRUE motion onset.
    // For an eccentric-first cycle the rep r (0-indexed) starts descending at
    // settle + r·(eccS + holdS + conS + holdS). We assert the detected start doesn't lag it
    // by more than maxOnsetLagMs — the fix that pulls the down phase back to where the lifter
    // actually started moving instead of ~10 frames later at detection.
    if (c.maxOnsetLagMs !== undefined && !c.startsConcentric) {
      const settleS = 0.6
      const cycleS = c.eccS + c.conS + 2 * c.holdS
      let maxLag = -Infinity
      let minLag = Infinity
      reps.forEach((r, i) => {
        const trueOnsetMs = (settleS + i * cycleS) * 1000
        const lag = r.startMs - trueOnsetMs // +ve = detected late
        maxLag = Math.max(maxLag, lag)
        minLag = Math.min(minLag, lag)
      })
      console.log(`   onset lag: ${(minLag / 1000 * 30).toFixed(1)}..${(maxLag / 1000 * 30).toFixed(1)} frames @30fps`)
      expect(`${c.label}: down starts near true onset`, Math.abs(maxLag) <= c.maxOnsetLagMs && Math.abs(minLag) <= c.maxOnsetLagMs, `lag range ${minLag.toFixed(0)}..${maxLag.toFixed(0)}ms (max ±${c.maxOnsetLagMs})`)
    }
  }
}

// ---- Rep-boundary editing (RepEditor math) --------------------------------
console.log('\nRep-boundary editing')
const baseRep = (over: Partial<RepMetrics>): RepMetrics => ({
  index: 1,
  eccentricMs: 2000,
  concentricMs: 1000,
  eccentricFrames: 60,
  concentricFrames: 30,
  rangeOfMotion: 0.4,
  peakVelocity: 0.5,
  meanConcentricVelocity: 0.4,
  startMs: 1000,
  endMs: 4000,
  ...over,
})

// Squat (eccentric-first): turnaround = start + eccentric.
const sq = baseRep({})
const sqB = repBounds(sq, 'eccentric')
expect('repBounds: squat turnaround', Math.abs(sqB.turnSec - 3.0) < 1e-6, `turn=${sqB.turnSec}s (want 3.0)`)
// Extend the end by 1s → concentric grows to 2s, eccentric unchanged.
const sqEdited = applyBounds(sq, { ...sqB, endSec: 5.0 }, 'eccentric', 30)
expect('applyBounds: squat extend end', Math.abs(sqEdited.eccentricMs - 2000) < 1 && Math.abs(sqEdited.concentricMs - 2000) < 1, `ecc=${sqEdited.eccentricMs} con=${sqEdited.concentricMs}`)
expect('applyBounds: frame recompute', sqEdited.concentricFrames === 60, `${sqEdited.concentricFrames} frames (want 60)`)

// Deadlift (concentric-first): first phase is concentric.
const dl = baseRep({ concentricMs: 1500, eccentricMs: 1200, endMs: 3700 })
const dlB = repBounds(dl, 'concentric')
expect('repBounds: deadlift turnaround', Math.abs(dlB.turnSec - 2.5) < 1e-6, `turn=${dlB.turnSec}s (want 2.5)`)
const dlEdited = applyBounds(dl, { ...dlB, startSec: 0.5 }, 'concentric', 30)
expect('applyBounds: deadlift move start', Math.abs(dlEdited.concentricMs - 2000) < 1 && Math.abs(dlEdited.eccentricMs - 1200) < 1, `con=${dlEdited.concentricMs} ecc=${dlEdited.eccentricMs}`)

// Clamp: a turnaround past the end is pinned to the end (no negative phase).
const clamped = applyBounds(sq, { startSec: 1, turnSec: 9, endSec: 4 }, 'eccentric', 30)
expect('applyBounds: clamps turnaround', clamped.concentricMs >= 0 && clamped.eccentricMs >= 0, `ecc=${clamped.eccentricMs} con=${clamped.concentricMs}`)

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
