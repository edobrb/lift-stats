import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ExerciseConfig } from '../config/exercises'
import type { Phase, RepMetrics } from '../types'
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
  phase: Phase | null
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
  const fpsRef = useRef(0)
  const startMediaRef = useRef<number | null>(null)
  const startFramesRef = useRef<number | null>(null)
  const lastMediaRef = useRef(0)
  const lastUiRef = useRef(0)
  const lastRepRef = useRef<{ ecc: number; con: number } | null>(null)

  const onFrame = useCallback(
    (info: FrameInfo) => {
      const video = videoRef.current
      const canvas = canvasRef.current
      const engine = engineRef.current
      const detector = detectorRef.current
      if (!video || !canvas || !engine || !detector || video.videoWidth === 0) return

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
      startMediaRef.current = null
      startFramesRef.current = null
      fpsRef.current = 0
      lastRepRef.current = null

      if (!engineRef.current) engineRef.current = await createPoseEngine()
      const stream = await startCamera(video)
      streamRef.current = stream
      recorderRef.current = recordVideo ? startRecorder(stream) : null
      setStatus('tracking')
      stopLoopRef.current = startFrameLoop(video, onFrame)
    } catch (err) {
      stopCamera(streamRef.current, video)
      streamRef.current = null
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Could not start the camera.')
    }
  }, [exercise, recordVideo, onFrame, videoRef, canvasRef])

  const stop = useCallback(async (): Promise<SetResult> => {
    setStatus('stopping')
    stopLoopRef.current?.()
    stopLoopRef.current = null

    const recorder = recorderRef.current
    recorderRef.current = null
    const video = recorder ? await recorder.stop() : null

    stopCamera(streamRef.current, videoRef.current)
    streamRef.current = null

    const detector = detectorRef.current
    if (detector) finalizeRepDetector(detector)
    const reps = detector ? detector.reps : []
    const durationMs = Math.max(0, (lastMediaRef.current - (startMediaRef.current ?? lastMediaRef.current)) * 1000)

    setStatus('idle')
    setLive((l) => ({ ...l, phase: null }))
    return { reps, durationMs, fps: fpsRef.current, video }
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

  // iOS Safari keeps camera + recorder alive when the page is backgrounded and may
  // suspend without unmounting — release on pagehide / tab-hide while tracking.
  useEffect(() => {
    if (status !== 'tracking') return
    const release = () => {
      teardown()
      setStatus('idle')
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release()
    }
    window.addEventListener('pagehide', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', release)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [status, teardown])

  return { status, error, live, start, stop, cancel }
}
