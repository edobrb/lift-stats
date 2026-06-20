import { useCallback, useEffect, useRef } from 'react'
import type { LiftSet } from '../types'
import { EXERCISES, getExercise } from '../config/exercises'
import { sessionStore, useApp, useSession } from '../state/store'
import { usePoseTracker, type SetResult } from '../hooks/usePoseTracker'
import { navigate, redirect } from '../hooks/useRouter'
import { saveSet } from '../storage/sets'
import { makeId } from '../lib/id'

export const TrackingScreen = () => {
  const app = useApp()
  const session = useSession()
  const pending = session.pending

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startedAtRef = useRef(0)

  const exercise = pending ? getExercise(pending.exercise) : EXERCISES.squat

  // Persist the finished set immediately and jump straight to its detail screen — there is
  // no separate review step (Set Detail already has the rep editor, breakdown and delete).
  // Used by Stop and by the OS background-stop path (visibility hidden) so a set is never
  // lost. The detail screen's own dirty-edit guard covers any later boundary edits. Guarded
  // by savedRef so a manual Stop racing the background-stop can't double-save the set.
  const savedRef = useRef(false)
  const buildAndSave = useCallback(
    async (result: SetResult) => {
      if (!pending || savedRef.current) return
      savedRef.current = true
      const reps = result.reps.map((r, i) => ({ ...r, index: i + 1 }))
      const set: LiftSet = {
        id: makeId(),
        profileId: app.profileId ?? 'unknown',
        exercise: pending.exercise,
        weight: pending.weight,
        unit: app.unit,
        startedAt: startedAtRef.current || Date.now(),
        durationMs: result.durationMs,
        fps: Math.round(result.fps),
        reps,
        repCount: reps.length,
        hasVideo: result.video !== null,
        videoMime: result.video?.mime ?? null,
        notes: '',
      }
      await saveSet(set, result.video)
      sessionStore.set({ pending: null })
      // replaceState (redirect) so Back from Set Detail returns Home, not the dead #/track.
      redirect({ name: 'setDetail', id: set.id })
    },
    [app.profileId, app.unit, pending],
  )

  const tracker = usePoseTracker(videoRef, canvasRef, exercise, app.recordVideo, buildAndSave)

  // Bounce home only if we land on /track WITHOUT a pending session (e.g. a stale bookmark).
  // After a save we clear `pending` ourselves and navigate to the new set, so the savedRef
  // guard prevents this from racing in and redirecting home instead.
  useEffect(() => {
    if (!pending && !savedRef.current) redirect({ name: 'home' })
  }, [pending])

  // Render nothing once there's no pending session — either a stale visit (the effect above
  // bounces home) or the brief tick after a save before the route switches to the new set.
  if (!pending) return null

  const handleStart = async () => {
    startedAtRef.current = Date.now()
    await tracker.start()
  }

  const handleStop = async () => {
    await buildAndSave(await tracker.stop())
  }

  const weightLabel = pending.weight !== null ? ` · ${pending.weight}${app.unit}` : ''

  return (
    <div className="track">
      <video ref={videoRef} className="track__video" playsInline muted autoPlay />
      <canvas ref={canvasRef} className="track__canvas" />

      <div className="track__top">
        <button
          className="iconbtn iconbtn--ghost"
          aria-label="Close"
          onClick={() => {
            tracker.cancel()
            navigate({ name: 'home' })
          }}
        >
          ✕
        </button>
        <div className="track__title">
          {exercise.emoji} {exercise.name}
          {weightLabel}
        </div>
        <div className="track__badge">{tracker.live.delegate ?? ''}</div>
      </div>

      {tracker.status === 'idle' && (
        <div className="overlay">
          <div className="overlay__card">
            <div className="overlay__emoji">{exercise.emoji}</div>
            <h2>{exercise.name}</h2>
            <p className="muted">{exercise.guidance}</p>
            <button className="btn btn--primary btn--big" onClick={handleStart}>
              Start camera
            </button>
            <p className="small muted">Reps and eccentric / concentric timing are tracked on-device.</p>
          </div>
        </div>
      )}

      {tracker.status === 'loading' && (
        <div className="overlay">
          <div className="overlay__card">
            <div className="spinner" />
            <p>Loading pose model & camera…</p>
          </div>
        </div>
      )}

      {tracker.status === 'error' && (
        <div className="overlay">
          <div className="overlay__card">
            <h2>Couldn’t start</h2>
            <p className="muted">{tracker.error}</p>
            <button className="btn btn--primary" onClick={handleStart}>
              Try again
            </button>
          </div>
        </div>
      )}

      {tracker.status === 'tracking' && (
        <div className="track__bottom">
          {!tracker.live.personDetected && <div className="track__hint">Step into frame</div>}
          <button className="btn btn--stop" onClick={handleStop}>
            Stop · {tracker.live.repCount} {tracker.live.repCount === 1 ? 'rep' : 'reps'}
          </button>
        </div>
      )}
    </div>
  )
}
