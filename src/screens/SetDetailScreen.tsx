import { useEffect, useRef, useState } from 'react'
import type { LiftSet, RepMetrics } from '../types'
import { getExercise } from '../config/exercises'
import { aggregateReps, velocityLossPct } from '../lib/metrics'
import { analyzeVideo } from '../lib/analyzeVideo'
import { getSet, getSetVideo, deleteSet, updateSet } from '../storage/sets'
import { exportSetJson } from '../lib/exportSet'
import { navigate, setLeaveGuard } from '../hooks/useRouter'
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
  const [recomputing, setRecomputing] = useState(false)
  const [progress, setProgress] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

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

  // Warn before leaving with unsaved rep-boundary edits: beforeunload covers a full page
  // reload/close, and the router leave-guard covers in-app navigation (nav tabs, back link).
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    setLeaveGuard(() => window.confirm('Discard unsaved rep edits?'))
    return () => {
      window.removeEventListener('beforeunload', handler)
      setLeaveGuard(null)
    }
  }, [dirty])

  const remove = async () => {
    if (!window.confirm('Delete this set and its recording?')) return
    setLeaveGuard(null) // deleting intentionally discards edits — don't double-prompt
    await deleteSet(id)
    navigate({ name: 'history' })
  }

  const saveEdits = async () => {
    if (!set) return
    const reindexed = reps.map((r, i) => ({ ...r, index: i + 1 }))
    const updated = { ...set, reps: reindexed, repCount: reindexed.length }
    await updateSet(updated)
    setSet(updated)
    setReps(reindexed)
    setDirty(false)
  }

  const resetEdits = () => {
    if (set) {
      setReps(set.reps)
      setDirty(false)
    }
  }

  const removeRep = (rep: RepMetrics) => {
    setReps((current) => current.filter((r) => r !== rep))
    setDirty(true)
  }

  // Re-run pose detection over the saved clip with the current detector (backfills
  // holds onto old sets, re-applies detector improvements). Loads as unsaved edits.
  const recompute = async () => {
    if (!videoBlob || !set || recomputing) return
    const controller = new AbortController()
    abortRef.current = controller
    setRecomputing(true)
    setProgress(0)
    try {
      const result = await analyzeVideo(videoBlob, getExercise(set.exercise), {
        fps: set.fps,
        onProgress: setProgress,
        signal: controller.signal,
      })
      setReps(result.reps)
      setDirty(true)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        window.alert(`Recompute failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
    } finally {
      setRecomputing(false)
      abortRef.current = null
    }
  }

  const cancelRecompute = () => abortRef.current?.abort()

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
        {agg.totalHoldMs > 0 ? <Stat label="Hold time" value={formatClock(agg.totalHoldMs)} /> : null}
        <Stat label="Avg ROM" value={formatRom(agg.avgRangeOfMotion)} />
        <Stat label="Best velocity" value={formatVelocity(agg.bestConcentricVelocity)} />
        <Stat label="Velocity loss" value={`${velocityLossPct(reps)}%`} />
        <Stat label="Avg peak vel" value={formatVelocity(agg.avgPeakVelocity)} />
      </div>

      {videoBlob ? (
        <section className="section">
          <div className="section__head">
            <h3>Rewatch & adjust reps</h3>
            {recomputing ? (
              <button className="btn btn--ghost btn--sm" onClick={cancelRecompute}>
                Cancel
              </button>
            ) : (
              <button
                className="btn btn--ghost btn--sm"
                onClick={recompute}
                title="Re-detect every rep from the video with the latest detector"
              >
                ↻ Recompute
              </button>
            )}
          </div>
          {recomputing && (
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div className="progress__bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span className="progress__label">Recomputing reps… {Math.round(progress * 100)}%</span>
            </div>
          )}
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
        <p className="muted small">Tap ✕ to drop a misdetected rep, then Save changes.</p>
        <RepBreakdown reps={reps} onRemove={removeRep} />
      </section>

      <div className="actions">
        <button className="btn btn--ghost" onClick={() => void exportSetJson(set, reps)}>
          ⬇ Export JSON
        </button>
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
