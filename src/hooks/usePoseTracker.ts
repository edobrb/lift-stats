import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ExerciseConfig } from '../config/exercises'
import type { PhaseKind, RepMetrics } from '../types'
import { createPoseEngine, type PoseEngine } from '../lib/pose'
import {
  startCamera,
  stopCamera,
  startFrameLoop,
  startRecorder,
  type FrameInfo,
  type Recording,
} from '../lib/camera'
import { extractSignal } from '../lib/signal'
import {
  createRepDetector,
  stepRepDetector,
  finalizeRepDetector,
  currentPhaseElapsedMs,
  type RepDetectorState,
} from '../lib/repDetector'
import { drawOverlay, syncCanvasSize, type Hud } from '../lib/draw'

export type TrackerStatus = 'idle' | 'loading' | 'tracking' | 'stopping' | 'error'

export interface LiveStats {
  repCount: number
  phase: PhaseKind | null // includes hold states while the lifter pauses at an extreme
  fps: number
  delegate: 'GPU' | 'CPU' | null
  personDetected: boolean
}

export interface SetResult {
  reps: RepMetrics[]
  durationMs: number
  fps: number
  video: { blob: Blob; mime: string } | null
}

const TRACE_LENGTH = 140
const UI_THROTTLE_MS = 120

export const usePoseTracker = (
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  exercise: ExerciseConfig,
  recordVideo: boolean,
  // Called when the OS backgrounds the page mid-set: we stop & hand back the result
  // so the screen can preserve it (rather than discarding the recording).
  onBackgroundStop?: (result: SetResult) => void,
) => {
  const [status, setStatus] = useState<TrackerStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveStats>({
    repCount: 0,
    phase: null,
    fps: 0,
    delegate: null,
    personDetected: false,
  })

  const engineRef = useRef<PoseEngine | null>(null)
  const detectorRef = useRef<RepDetectorState | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<Recording | null>(null)
  const stopLoopRef = useRef<(() => void) | null>(null)

  const traceRef = useRef<number[]>([])
  const stoppingRef = useRef<Promise<SetResult> | null>(null)
  const fpsRef = useRef(0)
  const startMediaRef = useRef<number | null>(null)
  const startFramesRef = useRef<number | null>(null)
  const lastMediaRef = useRef(0)
  const lastUiRef = useRef(0)
  const lastRepRef = useRef<{ ecc: number; con: number } | null>(null)
  const frameSeenRef = useRef(false)
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onFrame = useCallback(
    (info: FrameInfo) => {
      const video = videoRef.current
      const canvas = canvasRef.current
      const engine = engineRef.current
      const detector = detectorRef.current
      if (!video || !canvas || !engine || !detector || video.videoWidth === 0) return
      frameSeenRef.current = true

      syncCanvasSize(canvas, video)
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (startMediaRef.current === null) {
        startMediaRef.current = info.mediaTimeSec
        startFramesRef.current = info.presentedFrames
      }
      lastMediaRef.current = info.mediaTimeSec
      const dMedia = info.mediaTimeSec - startMediaRef.current
      const dFrames = info.presentedFrames - (startFramesRef.current ?? 0)
      if (dMedia > 0.3) fpsRef.current = dFrames / dMedia

      // Engine timestamp: a monotonic wall clock that keeps increasing across sets
      // (media-time restarts near 0 each set and would corrupt VIDEO-mode tracking).
      const tsMs = info.now
      let landmarks = null
      try {
        landmarks = engine.detect(video, tsMs)
      } catch {
        landmarks = null
      }

      let trackedY: number | null = null
      if (landmarks) {
        const sample = extractSignal(landmarks, exercise)
        if (sample) {
          trackedY = sample.y
          const completed = stepRepDetector(detector, sample.y, info.mediaTimeSec, info.presentedFrames)
          if (completed.length > 0) {
            const last = completed[completed.length - 1]!
            lastRepRef.current = { ecc: last.eccentricMs, con: last.concentricMs }
          }
          const trace = traceRef.current
          trace.push(detector.smoothedY)
          if (trace.length > TRACE_LENGTH) trace.shift()
        }
      }

      const hud: Hud = {
        exerciseName: exercise.name,
        repCount: detector.reps.length,
        phase: detector.currentPhase,
        phaseElapsedMs: currentPhaseElapsedMs(detector, info.mediaTimeSec),
        fps: fpsRef.current,
        lastEccentricMs: lastRepRef.current?.ecc ?? null,
        lastConcentricMs: lastRepRef.current?.con ?? null,
        trackedY,
        trace: traceRef.current,
        status: landmarks ? 'Tracking' : 'No person detected',
      }
      drawOverlay(ctx, video, landmarks, hud)

      if (info.now - lastUiRef.current > UI_THROTTLE_MS) {
        lastUiRef.current = info.now
        setLive({
          repCount: detector.reps.length,
          phase: detector.currentPhase,
          fps: fpsRef.current,
          delegate: engine.delegate,
          personDetected: landmarks !== null,
        })
      }
    },
    [exercise, videoRef, canvasRef],
  )

  // Release everything (frame loop, recorder, camera) without producing a set.
  const teardown = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
    stopLoopRef.current?.()
    stopLoopRef.current = null
    const recorder = recorderRef.current
    recorderRef.current = null
    void recorder?.stop()
    stopCamera(streamRef.current, videoRef.current)
    streamRef.current = null
  }, [videoRef])

  const cancel = useCallback(() => {
    teardown()
    setStatus('idle')
    setLive((l) => ({ ...l, phase: null }))
  }, [teardown])

  const start = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    setError(null)
    setStatus('loading')
    try {
      detectorRef.current = createRepDetector(exercise)
      traceRef.current = []
      stoppingRef.current = null
      startMediaRef.current = null
      startFramesRef.current = null
      fpsRef.current = 0
      lastRepRef.current = null
      frameSeenRef.current = false

      if (!engineRef.current) engineRef.current = await createPoseEngine()
      const stream = await startCamera(video)
      streamRef.current = stream
      recorderRef.current = recordVideo ? startRecorder(stream) : null
      setStatus('tracking')
      stopLoopRef.current = startFrameLoop(video, onFrame)

      // Watchdog: a stuck/paused stream presents no frames; surface an error
      // instead of sitting on a frozen "tracking" screen forever.
      if (watchdogRef.current) clearTimeout(watchdogRef.current)
      watchdogRef.current = setTimeout(() => {
        if (!frameSeenRef.current) {
          teardown()
          setStatus('error')
          setError('The camera started but produced no frames. Try again or check camera permissions.')
        }
      }, 3000)
    } catch (err) {
      stopCamera(streamRef.current, video)
      streamRef.current = null
      setStatus('error')
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      setError(
        offline
          ? 'You appear to be offline and the pose engine isn’t cached yet. Connect once and start a set to enable offline tracking afterwards.'
          : err instanceof Error
            ? err.message
            : 'Could not start the camera.',
      )
    }
  }, [exercise, recordVideo, onFrame, teardown, videoRef, canvasRef])

  const stop = useCallback((): Promise<SetResult> => {
    // Re-entrancy guard: a manual Stop and the background-stop (visibility hidden) can fire
    // almost together. Return the in-flight stop so the hardware is torn down and the
    // detector finalized exactly once, and both callers see the same result.
    if (stoppingRef.current) return stoppingRef.current
    const run = (async (): Promise<SetResult> => {
      setStatus('stopping')
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current)
        watchdogRef.current = null
      }
      stopLoopRef.current?.()
      stopLoopRef.current = null

      const recorder = recorderRef.current
      recorderRef.current = null
      const video = recorder ? await recorder.stop() : null

      stopCamera(streamRef.current, videoRef.current)
      streamRef.current = null

      const detector = detectorRef.current
      if (detector) finalizeRepDetector(detector)
      // Rebase rep times to be zero-based against the recorded video (whose playback
      // timeline starts at ~0), so the editor's handles line up with the footage.
      const origin = (startMediaRef.current ?? 0) * 1000
      const reps = (detector ? detector.reps : []).map((r) => ({
        ...r,
        startMs: Math.max(0, r.startMs - origin),
        endMs: Math.max(0, r.endMs - origin),
      }))
      const durationMs = Math.max(0, (lastMediaRef.current - (startMediaRef.current ?? lastMediaRef.current)) * 1000)

      setStatus('idle')
      setLive((l) => ({ ...l, phase: null }))
      return { reps, durationMs, fps: fpsRef.current, video }
    })()
    stoppingRef.current = run
    return run
  }, [videoRef])

  // Release hardware on unmount (includes finalizing any active recorder).
  useEffect(
    () => () => {
      teardown()
      engineRef.current?.close()
      engineRef.current = null
    },
    [teardown],
  )

  // iOS Safari keeps camera + recorder alive when backgrounded and may suspend the
  // page without unmounting. While tracking: if the tab is hidden (app switch,
  // notification) we stop and hand the set back so it's preserved, not discarded;
  // on terminal pagehide we best-effort release the hardware.
  useEffect(() => {
    if (status !== 'tracking') return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void stop().then((result) => onBackgroundStop?.(result))
      }
    }
    const onPageHide = () => teardown()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [status, stop, teardown, onBackgroundStop])

  return { status, error, live, start, stop, cancel }
}
