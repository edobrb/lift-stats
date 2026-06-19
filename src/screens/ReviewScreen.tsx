import { useEffect, useRef, useState } from 'react'
import type { RepMetrics } from '../types'
import { getExercise } from '../config/exercises'
import { aggregateReps, velocityLossPct } from '../lib/metrics'
import { saveSet } from '../storage/sets'
import { sessionStore, useSession } from '../state/store'
import { navigate, redirect } from '../hooks/useRouter'
import { formatClock, formatSeconds, formatRom } from '../lib/timing'
import { Stat } from '../components/Stat'
import { RepBreakdown } from '../components/RepBreakdown'
import { VideoView } from '../components/VideoView'

export const ReviewScreen = () => {
  const session = useSession()
  const review = session.review

  // Editable copy of the detected reps — the user can drop misdetected ones here.
  const [reps, setReps] = useState<RepMetrics[]>(() => session.review?.set.reps ?? [])
  const savedRef = useRef(false)

  // Redirect home only if we land here with no review AND we didn't just save
  // (after saving we navigate to the set detail; this guard prevents bouncing home).
  useEffect(() => {
    if (!review && !savedRef.current) redirect({ name: 'home' })
  }, [review])

  // Warn before unloading the page while an unsaved set is in review.
  useEffect(() => {
    if (!review) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [review])

  if (!review) return null

  const { set, video } = review
  const exercise = getExercise(set.exercise)
  const agg = aggregateReps(reps)

  const removeRep = (rep: RepMetrics) => setReps((current) => current.filter((r) => r !== rep))

  const save = async () => {
    const finalReps = reps.map((r, i) => ({ ...r, index: i + 1 }))
    const finalSet = { ...set, reps: finalReps, repCount: finalReps.length }
    await saveSet(finalSet, video)
    savedRef.current = true
    sessionStore.set({ review: null, pending: null })
    navigate({ name: 'setDetail', id: finalSet.id })
  }

  const discard = () => {
    sessionStore.set({ review: null, pending: null })
    navigate({ name: 'home' })
  }

  return (
    <div className="screen screen--pad">
      <header className="screen__head">
        <h1>
          {exercise.emoji} {exercise.name}
        </h1>
        <p className="muted">
          {reps.length} reps · {formatClock(set.durationMs)} · {set.fps} fps
          {set.weight !== null ? ` · ${set.weight}${set.unit}` : ''}
        </p>
      </header>

      <div className="stats">
        <Stat label="Reps" value={`${agg.repCount}`} accent />
        <Stat label="Avg eccentric" value={formatSeconds(agg.avgEccentricMs)} />
        <Stat label="Avg concentric" value={formatSeconds(agg.avgConcentricMs)} />
        <Stat label="Time under tension" value={formatClock(agg.timeUnderTensionMs)} />
        <Stat label="Avg ROM" value={formatRom(agg.avgRangeOfMotion)} />
        <Stat label="Velocity loss" value={`${velocityLossPct(reps)}%`} />
      </div>

      {video && (
        <section className="section">
          <h3>Recording</h3>
          <VideoView blob={video.blob} />
        </section>
      )}

      <section className="section">
        <h3>Per-rep breakdown</h3>
        <p className="muted small">Tap ✕ to drop a misdetected rep before saving.</p>
        <RepBreakdown reps={reps} onRemove={removeRep} />
      </section>

      <div className="actions actions--sticky">
        <button className="btn btn--ghost" onClick={discard}>
          Discard
        </button>
        <button className="btn btn--primary" onClick={save}>
          Save{reps.length ? ` (${reps.length})` : ''}
        </button>
      </div>
    </div>
  )
}
