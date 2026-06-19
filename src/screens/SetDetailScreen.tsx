import { useEffect, useState } from 'react'
import type { LiftSet, RepMetrics } from '../types'
import { getExercise } from '../config/exercises'
import { aggregateReps, velocityLossPct } from '../lib/metrics'
import { getSet, getSetVideo, deleteSet, updateSet } from '../storage/sets'
import { navigate } from '../hooks/useRouter'
import { formatClock, formatDate, formatRom, formatSeconds, formatVelocity } from '../lib/timing'
import { Stat } from '../components/Stat'
import { RepBreakdown } from '../components/RepBreakdown'
import { RepEditor } from '../components/RepEditor'

export const SetDetailScreen = ({ id }: { id: string }) => {
  const [set, setSet] = useState<LiftSet | null>(null)
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null)
  const [reps, setReps] = useState<RepMetrics[]>([])
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    Promise.all([getSet(id), getSetVideo(id)]).then(([found, video]) => {
      if (!active) return
      setSet(found ?? null)
      setReps(found?.reps ?? [])
      setVideoBlob(video?.blob ?? null)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [id])

  const remove = async () => {
    if (!window.confirm('Delete this set and its recording?')) return
    await deleteSet(id)
    navigate({ name: 'history' })
  }

  const saveEdits = async () => {
    if (!set) return
    const updated = { ...set, reps, repCount: reps.length }
    await updateSet(updated)
    setSet(updated)
    setDirty(false)
  }

  const resetEdits = () => {
    if (set) {
      setReps(set.reps)
      setDirty(false)
    }
  }

  if (loading) {
    return (
      <div className="screen screen--pad">
        <div className="spinner" />
      </div>
    )
  }

  if (!set) {
    return (
      <div className="screen screen--pad">
        <p className="muted">This set no longer exists.</p>
        <button className="btn btn--ghost" onClick={() => navigate({ name: 'history' })}>
          Back to history
        </button>
      </div>
    )
  }

  const exercise = getExercise(set.exercise)
  const agg = aggregateReps(reps)

  return (
    <div className="screen screen--pad">
      <header className="screen__head">
        <button className="link" onClick={() => navigate({ name: 'history' })}>
          ‹ History
        </button>
        <h1>
          {exercise.emoji} {exercise.name}
          {set.weight !== null ? ` · ${set.weight}${set.unit}` : ''}
        </h1>
        <p className="muted">
          {formatDate(set.startedAt)} · {formatClock(set.durationMs)} · {set.fps} fps
        </p>
      </header>

      <div className="stats">
        <Stat label="Reps" value={`${agg.repCount}`} accent />
        <Stat label="Avg eccentric" value={formatSeconds(agg.avgEccentricMs)} />
        <Stat label="Avg concentric" value={formatSeconds(agg.avgConcentricMs)} />
        <Stat label="Time under tension" value={formatClock(agg.timeUnderTensionMs)} />
        <Stat label="Avg ROM" value={formatRom(agg.avgRangeOfMotion)} />
        <Stat label="Best velocity" value={formatVelocity(agg.bestConcentricVelocity)} />
        <Stat label="Velocity loss" value={`${velocityLossPct(reps)}%`} />
        <Stat label="Avg peak vel" value={formatVelocity(agg.avgPeakVelocity)} />
      </div>

      {videoBlob ? (
        <section className="section">
          <h3>Rewatch & adjust reps</h3>
          <RepEditor
            blob={videoBlob}
            reps={reps}
            startsWith={exercise.startsWith}
            fps={set.fps}
            onChange={(next) => {
              setReps(next)
              setDirty(true)
            }}
          />
        </section>
      ) : null}

      <section className="section">
        <h3>Per-rep breakdown</h3>
        <RepBreakdown reps={reps} />
      </section>

      <div className="actions">
        <button className="btn btn--danger" onClick={remove}>
          Delete set
        </button>
      </div>

      {dirty && (
        <div className="actions actions--sticky">
          <button className="btn btn--ghost" onClick={resetEdits}>
            Reset
          </button>
          <button className="btn btn--primary" onClick={saveEdits}>
            Save changes
          </button>
        </div>
      )}
    </div>
  )
}
