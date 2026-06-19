import { useEffect, useRef } from 'react'
import type { LiftSet } from '../types'
import { EXERCISES, getExercise } from '../config/exercises'
import { sessionStore, useApp, useSession } from '../state/store'
import { usePoseTracker } from '../hooks/usePoseTracker'
import { navigate, redirect } from '../hooks/useRouter'
import { makeId } from '../lib/id'

export const TrackingScreen = () => {
  const app = useApp()
  const session = useSession()
  const pending = session.pending

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const startedAtRef = useRef(0)

  const exercise = pending ? getExercise(pending.exercise) : EXERCISES.squat
  const tracker = usePoseTracker(videoRef, canvasRef, exercise, app.recordVideo)

  useEffect(() => {
    if (!pending) redirect({ name: 'home' })
  }, [pending])

  if (!pending) return null

  const handleStart = async () => {
    startedAtRef.current = Date.now()
    await tracker.start()
  }

  const handleStop = async () => {
    const result = await tracker.stop()
    const set: LiftSet = {
      id: makeId(),
      profileId: app.profileId ?? 'unknown',
      exercise: pending.exercise,
      weight: pending.weight,
      unit: app.unit,
      startedAt: startedAtRef.current || Date.now(),
      durationMs: result.durationMs,
      fps: Math.round(result.fps),
      reps: result.reps,
      repCount: result.reps.length,
      hasVideo: result.video !== null,
      videoMime: result.video?.mime ?? null,
      notes: '',
    }
    sessionStore.set({ review: { set, video: result.video } })
    navigate({ name: 'review' })
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
