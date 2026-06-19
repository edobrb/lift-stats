// Drives the REAL rep detector with synthetic lift signals and checks rep count
// and eccentric/concentric timing. Run: npm run check
import {
  createRepDetector,
  stepRepDetector,
  finalizeRepDetector,
} from '../src/lib/repDetector'
import { EXERCISES } from '../src/config/exercises'
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
  opts: { top: number; bottom: number; eccS: number; conS: number; holdS: number; fps: number; startsConcentric: boolean; noiseAmp: number },
): Sample[] => {
  const { top, bottom, eccS, conS, holdS, fps, startsConcentric, noiseAmp } = opts
  const dt = 1 / fps
  const samples: Sample[] = []
  let t = 0
  let frame = 0
  const push = (y: number) => {
    samples.push({ y: Math.min(1, Math.max(0, y + noise(noiseAmp))), t, frame })
    t += dt
    frame += 1
  }
  const ramp = (from: number, to: number, secs: number) => {
    const steps = Math.max(1, Math.round(secs / dt))
    for (let i = 1; i <= steps; i++) push(from + (to - from) * (i / steps))
  }
  const hold = (y: number, secs: number) => {
    const steps = Math.max(1, Math.round(secs / dt))
    for (let i = 0; i < steps; i++) push(y)
  }

  // Settle at the starting position.
  hold(startsConcentric ? bottom : top, 0.6)
  for (let r = 0; r < n; r++) {
    if (startsConcentric) {
      ramp(bottom, top, conS) // concentric (up)
      hold(top, holdS)
      ramp(top, bottom, eccS) // eccentric (down)
      hold(bottom, holdS)
    } else {
      ramp(top, bottom, eccS) // eccentric (down)
      hold(bottom, holdS)
      ramp(bottom, top, conS) // concentric (up)
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
  startsConcentric: boolean
  noiseAmp: number
}

const cases: Case[] = [
  { label: 'Squat ×5 (clean, 2s ecc / 1s con)', exercise: 'squat', n: 5, eccS: 2.0, conS: 1.0, startsConcentric: false, noiseAmp: 0 },
  { label: 'Squat ×8 (noisy)', exercise: 'squat', n: 8, eccS: 1.5, conS: 0.8, startsConcentric: false, noiseAmp: 0.006 },
  { label: 'Bench ×6 (small ROM, noisy)', exercise: 'bench', n: 6, eccS: 1.2, conS: 0.6, startsConcentric: false, noiseAmp: 0.005 },
  { label: 'Deadlift ×5 (starts concentric)', exercise: 'deadlift', n: 5, eccS: 1.5, conS: 1.2, startsConcentric: true, noiseAmp: 0.004 },
  { label: 'Pull-up ×10 (starts concentric, fast)', exercise: 'pullup', n: 10, eccS: 1.0, conS: 0.9, startsConcentric: true, noiseAmp: 0.004 },
]

for (const c of cases) {
  const signal = buildSignal(c.n, {
    top: 0.3,
    bottom: c.exercise === 'bench' ? 0.45 : 0.62,
    eccS: c.eccS,
    conS: c.conS,
    holdS: 0.25,
    fps: 30,
    startsConcentric: c.startsConcentric,
    noiseAmp: c.noiseAmp,
  })
  const reps = run(c.exercise, signal)
  const avgEcc = mean(reps.map((r) => r.eccentricMs)) / 1000
  const avgCon = mean(reps.map((r) => r.concentricMs)) / 1000

  console.log(`\n${c.label}`)
  console.log(`   reps=${reps.length}/${c.n}  avgEcc=${avgEcc.toFixed(2)}s (want ~${c.eccS})  avgCon=${avgCon.toFixed(2)}s (want ~${c.conS})`)
  expect(`${c.label}: rep count`, reps.length >= c.n - 1 && reps.length <= c.n, `got ${reps.length}, expected ${c.n}`)
  if (reps.length > 0) {
    expect(`${c.label}: eccentric timing`, Math.abs(avgEcc - c.eccS) <= c.eccS * 0.3 + 0.15, `${avgEcc.toFixed(2)}s vs ${c.eccS}s`)
    expect(`${c.label}: concentric timing`, Math.abs(avgCon - c.conS) <= c.conS * 0.3 + 0.15, `${avgCon.toFixed(2)}s vs ${c.conS}s`)
    // Frame counts should be plausible (>0) and consistent with ~30fps.
    const fr = reps[0]!
    expect(`${c.label}: frame counts populated`, fr.eccentricFrames > 0 && fr.concentricFrames > 0, `ecc=${fr.eccentricFrames} con=${fr.concentricFrames} frames`)
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
