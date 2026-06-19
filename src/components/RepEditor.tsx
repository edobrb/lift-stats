import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Phase, RepMetrics } from '../types'
import { applyBounds, repBounds, turnaroundLabel } from '../lib/repEdit'
import { formatSeconds } from '../lib/timing'

// Advanced video tooling: rewatch the set and fine-tune each rep's start /
// turnaround / end against the footage. Controlled component — edits are pushed up
// via onChange so the parent owns the (persisted) rep array.

export const RepEditor = ({
  blob,
  reps,
  startsWith,
  fps,
  onChange,
}: {
  blob: Blob
  reps: RepMetrics[]
  startsWith: Phase
  fps: number
  onChange: (reps: RepMetrics[]) => void
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const playUntilRef = useRef<number | null>(null)
  const scrubbingRef = useRef(false)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState(0)

  const step = 1 / (fps > 0 ? fps : 30)
  const fallbackEnd = reps.reduce((m, r) => Math.max(m, r.endMs / 1000), 1)
  const dur = duration > 0 && Number.isFinite(duration) ? duration : fallbackEnd

  // Object URL lifecycle.
  useEffect(() => {
    const url = URL.createObjectURL(blob)
    const v = videoRef.current
    if (v) v.src = url
    return () => URL.revokeObjectURL(url)
  }, [blob])

  // MediaRecorder webm/mp4 blobs often report duration = Infinity until you seek to
  // the end once — force it so the timeline has a real length.
  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    if (!Number.isFinite(v.duration) || v.duration === 0) {
      const onSeeked = () => {
        setDuration(Number.isFinite(v.duration) ? v.duration : 0)
        v.currentTime = 0
        v.removeEventListener('seeked', onSeeked)
      }
      v.addEventListener('seeked', onSeeked)
      v.currentTime = 1e7
    } else {
      setDuration(v.duration)
    }
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    setCurrentTime(v.currentTime)
    if (playUntilRef.current !== null && v.currentTime >= playUntilRef.current) {
      v.pause()
      playUntilRef.current = null
    }
  }

  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current
      if (!v) return
      const clamped = Math.min(Math.max(0, t), dur || 0)
      v.currentTime = clamped
      setCurrentTime(clamped)
    },
    [dur],
  )

  const stepFrames = (n: number) => {
    videoRef.current?.pause()
    playUntilRef.current = null
    seek(currentTime + n * step)
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    playUntilRef.current = null
    if (v.paused) void v.play()
    else v.pause()
  }

  const playRep = () => {
    const rep = reps[selected]
    const v = videoRef.current
    if (!rep || !v) return
    const b = repBounds(rep, startsWith)
    seek(b.startSec)
    playUntilRef.current = b.endSec
    void v.play()
  }

  const timeFromPointer = (e: ReactPointerEvent) => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    return Math.min(Math.max(0, ratio), 1) * dur
  }

  const onTrackDown = (e: ReactPointerEvent) => {
    scrubbingRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    videoRef.current?.pause()
    playUntilRef.current = null
    seek(timeFromPointer(e))
  }
  const onTrackMove = (e: ReactPointerEvent) => {
    if (scrubbingRef.current) seek(timeFromPointer(e))
  }
  const onTrackUp = () => {
    scrubbingRef.current = false
  }

  const setPoint = (which: 'start' | 'turn' | 'end') => {
    const rep = reps[selected]
    if (!rep) return
    const b = repBounds(rep, startsWith)
    const next =
      which === 'start'
        ? { ...b, startSec: currentTime }
        : which === 'turn'
          ? { ...b, turnSec: currentTime }
          : { ...b, endSec: currentTime }
    const updated = applyBounds(rep, next, startsWith, fps)
    onChange(reps.map((r, i) => (i === selected ? updated : r)))
  }

  const selectRep = (i: number) => {
    setSelected(i)
    const rep = reps[i]
    if (rep) seek(rep.startMs / 1000)
  }

  const pct = (sec: number) => `${dur > 0 ? (sec / dur) * 100 : 0}%`
  const rep = reps[selected]
  const bounds = rep ? repBounds(rep, startsWith) : null

  return (
    <div className="editor">
      <video
        ref={videoRef}
        className="replay"
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      <div
        className="timeline"
        ref={trackRef}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
        onPointerUp={onTrackUp}
        onPointerCancel={onTrackUp}
      >
        {reps.map((r, i) => {
          const b = repBounds(r, startsWith)
          const eccFirst = startsWith === 'eccentric'
          return (
            <div key={r.startMs} className={`timeline__rep${i === selected ? ' is-selected' : ''}`}>
              {/* first phase */}
              <span
                className={`timeline__seg ${eccFirst ? 'seg--ecc' : 'seg--con'}`}
                style={{ left: pct(b.startSec), width: pct(b.turnSec - b.startSec) }}
              />
              {/* second phase */}
              <span
                className={`timeline__seg ${eccFirst ? 'seg--con' : 'seg--ecc'}`}
                style={{ left: pct(b.turnSec), width: pct(b.endSec - b.turnSec) }}
              />
            </div>
          )
        })}
        <span className="timeline__playhead" style={{ left: pct(currentTime) }} />
      </div>

      <div className="transport">
        <button className="tbtn" aria-label="Jump to rep start" onClick={() => bounds && seek(bounds.startSec)}>
          ⏮
        </button>
        <button className="tbtn" aria-label="Step back one frame" onClick={() => stepFrames(-1)}>
          ◁
        </button>
        <button className="tbtn tbtn--play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="tbtn" aria-label="Step forward one frame" onClick={() => stepFrames(1)}>
          ▷
        </button>
        <button className="tbtn" aria-label="Play this rep" onClick={playRep}>
          ⏯
        </button>
        <span className="transport__time">
          {formatSeconds(currentTime * 1000)} / {formatSeconds(dur * 1000)}
        </span>
      </div>

      <div className="rep-picker">
        {reps.map((r, i) => (
          <button
            key={r.startMs}
            className={`rep-pip${i === selected ? ' is-active' : ''}`}
            onClick={() => selectRep(i)}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {rep && bounds && (
        <div className="card editor__panel">
          <div className="editor__row">
            <strong>Rep {selected + 1}</strong>
            <span className="muted small">
              {formatSeconds(rep.eccentricMs)} ↓ / {formatSeconds(rep.concentricMs)} ↑
            </span>
          </div>
          <div className="editor__row muted small">
            <span>start {bounds.startSec.toFixed(2)}s</span>
            <span>
              {turnaroundLabel(startsWith)} {bounds.turnSec.toFixed(2)}s
            </span>
            <span>end {bounds.endSec.toFixed(2)}s</span>
          </div>
          <p className="muted small">Scrub or step to a frame, then set a boundary to the playhead:</p>
          <div className="setpoints">
            <button className="btn btn--ghost" onClick={() => setPoint('start')}>
              ◁ Set start
            </button>
            <button className="btn btn--ghost" onClick={() => setPoint('turn')}>
              Set {turnaroundLabel(startsWith)}
            </button>
            <button className="btn btn--ghost" onClick={() => setPoint('end')}>
              Set end ▷
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
