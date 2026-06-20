// Camera capture, the frame-precise loop, and video recording — all as free
// functions returning teardown handles.

export interface FrameInfo {
  /** Frame presentation time in seconds (authoritative per-frame clock). */
  mediaTimeSec: number
  /** Monotonic compositor frame counter (for precise frame counts / dropped frames). */
  presentedFrames: number
  /** performance.now() at callback time, in ms. */
  now: number
}

export const startCamera = async (video: HTMLVideoElement): Promise<MediaStream> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera API unavailable. Use HTTPS (or localhost) on a supported browser.')
  }
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    // A device that can't satisfy the ideal constraints shouldn't hard-fail — retry bare.
    if (name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true })
    } else {
      // Native getUserMedia messages are terse and inconsistent across browsers; map the
      // common failure names to something the lifter can act on.
      const message =
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Camera permission was denied. Allow camera access in your browser settings and try again.'
          : name === 'NotReadableError'
            ? 'The camera is in use by another app. Close it and try again.'
            : name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : err instanceof Error
                ? err.message
                : 'Could not start the camera.'
      throw new Error(message)
    }
  }
  video.srcObject = stream
  video.muted = true
  video.playsInline = true
  if (video.readyState < 1) {
    await new Promise<void>((resolve) =>
      video.addEventListener('loadedmetadata', () => resolve(), { once: true }),
    )
  }
  await video.play().catch(() => {
    /* play() can reject on transient interruptions; the frame loop tolerates it */
  })
  return stream
}

export const stopCamera = (stream: MediaStream | null, video: HTMLVideoElement | null): void => {
  stream?.getTracks().forEach((track) => track.stop())
  if (video) video.srcObject = null
}

/** Runs `onFrame` once per presented video frame. Returns a stop function. */
export const startFrameLoop = (
  video: HTMLVideoElement,
  onFrame: (info: FrameInfo) => void,
): (() => void) => {
  let stopped = false

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    let id = 0
    const cb: VideoFrameRequestCallback = (now, meta) => {
      if (stopped) return
      onFrame({ mediaTimeSec: meta.mediaTime, presentedFrames: meta.presentedFrames, now })
      id = video.requestVideoFrameCallback(cb)
    }
    id = video.requestVideoFrameCallback(cb)
    return () => {
      stopped = true
      video.cancelVideoFrameCallback(id)
    }
  }

  // Fallback for browsers without rVFC (old Firefox / embedded WebViews).
  let lastTime = -1
  let raf = 0
  const tick = (now: number) => {
    if (stopped) return
    if (!video.paused && !video.ended && video.currentTime !== lastTime) {
      lastTime = video.currentTime
      const quality = video.getVideoPlaybackQuality?.()
      onFrame({
        mediaTimeSec: video.currentTime,
        presentedFrames: quality?.totalVideoFrames ?? 0,
        now,
      })
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => {
    stopped = true
    cancelAnimationFrame(raf)
  }
}

// ---- Recording -------------------------------------------------------------

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E', // iOS Safari (H.264 only)
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

export const pickVideoMime = (): string => {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

export interface Recording {
  stop: () => Promise<{ blob: Blob; mime: string } | null>
}

export const startRecorder = (stream: MediaStream): Recording | null => {
  if (typeof MediaRecorder === 'undefined') return null
  const mime = pickVideoMime()
  let recorder: MediaRecorder
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  } catch {
    return null
  }
  const chunks: Blob[] = []
  let errored = false
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  // A mid-recording failure (codec error, low memory, the camera yanked by another app)
  // would otherwise be silent and yield a truncated, unplayable blob. Flag it so stop()
  // hands back null and the set is saved video-less rather than with a broken recording.
  recorder.onerror = () => {
    errored = true
  }
  recorder.start(1000)

  // Below this the blob is effectively empty/corrupt (a header with no real frames); treat
  // it as no recording so we never persist an unplayable clip.
  const MIN_BLOB_BYTES = 1024

  return {
    stop: () =>
      new Promise((resolve) => {
        if (recorder.state === 'inactive') {
          resolve(null)
          return
        }
        recorder.onstop = () => {
          const type = recorder.mimeType || mime || 'video/webm'
          const blob = chunks.length ? new Blob(chunks, { type }) : null
          resolve(!errored && blob && blob.size >= MIN_BLOB_BYTES ? { blob, mime: type } : null)
        }
        recorder.stop()
      }),
  }
}
