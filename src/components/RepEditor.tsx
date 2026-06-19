import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Phase, RepMetrics } from '../types'
import { applyBounds, repBounds, turnaroundLabel } from '../lib/repEdit'
import { formatSeconds } from '../lib/timing'

type Handle = 'start' | 'turn' | 'end'

// Advanced video tooling: rewatch the set and fine-tune each rep by dragging its
// start / turnaround / end handles directly on the timeline (frame-nudge for
// precision). Controlled — edits are pushed up via onChange.
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
  const draggingRef = useRef<Handle | null>(null)

  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState(0)
  const [activeHandle, setActiveHandle] = useState<Handle>('start')

  const step = 1 / (fps > 0 ? fps : 30)
  const fallbackEnd = reps.reduce((m, r) => Math.max(m, r.endMs / 1000), 1)
  const dur = duration > 0 && Number.isFinite(duration) ? duration : fallbackEnd

  useEffect(() => {
    const url = URL.createObjectURL(blob)
    const v = videoRef.current
    if (v) v.src = url
    return () => URL.revokeObjectURL(url)
  }, [blob])

  // MediaRecorder blobs often report duration = Infinity until you seek to the end.
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
      // timeupdate is coarse — clamp the playhead back to the exact rep end.
      const end = playUntilRef.current
      v.pause()
      v.currentTime = end
      setCurrentTime(end)
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

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    playUntilRef.current = null
    if (v.paused) void v.play()
    else v.pause()
  }

  // Clamp the selection so removing a rep elsewhere can't leave it out of range.
  const sel = reps.length > 0 ? Math.min(selected, reps.length - 1) : -1
  const rep = sel >= 0 ? reps[sel] : undefined
  const bounds = rep ? repBounds(rep, startsWith) : null

  const playRep = () => {
    const v = videoRef.current
    if (!bounds || !v) return
    seek(bounds.startSec)
    playUntilRef.current = bounds.endSec
    void v.play()
  }

  const pct = (sec: number) => `${dur > 0 ? Math.min(100, Math.max(0, (sec / dur) * 100)) : 0}%`

  // Apply a new time to one handle of the selected rep (clamped to neighbours).
  const applyHandle = (which: Handle, t: number) => {
    if (!rep || !bounds) return
    const prevEnd = sel > 0 ? reps[sel - 1]!.endMs / 1000 : 0
    const nextStart = sel < reps.length - 1 ? reps[sel + 1]!.startMs / 1000 : dur
    const next = { ...bounds }
    let landed = t
    if (which === 'start') {
      landed = Math.min(Math.max(t, prevEnd), bounds.turnSec)
      next.startSec = landed
    } else if (which === 'turn') {
      landed = Math.min(Math.max(t, bounds.startSec), bounds.endSec)
      next.turnSec = landed
    } else {
      landed = Math.max(Math.min(t, nextStart), bounds.turnSec)
      next.endSec = landed
    }
    onChange(reps.map((r, i) => (i === sel ? applyBounds(rep, next, startsWith, fps) : r)))
    seek(landed)
  }

  const nudge = (frames: number) => {
    if (!bounds) return
    const cur = activeHandle === 'start' ? bounds.startSec : activeHandle === 'turn' ? bounds.turnSec : bounds.endSec
    applyHandle(activeHandle, cur + frames * step)
  }

  const timeFromPointer = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.min(Math.max(0, (clientX - rect.left) / rect.width), 1) * dur
  }

  // Drag a boundary handle.
  const onHandleDown = (e: ReactPointerEvent, which: Handle) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = which
    setActiveHandle(which)
    videoRef.current?.pause()
    playUntilRef.current = null
  }
  const onHandleMove = (e: ReactPointerEvent) => {
    if (draggingRef.current) applyHandle(draggingRef.current, timeFromPointer(e.clientX))
  }
  const onHandleUp = () => {
    draggingRef.current = null
  }

  // Scrubbing the empty track moves the playhead (view only).
  const onTrackDown = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = null
    videoRef.current?.pause()
    playUntilRef.current = null
    seek(timeFromPointer(e.clientX))
  }
  const onTrackMove = (e: ReactPointerEvent) => {
    if (!draggingRef.current && e.buttons > 0) seek(timeFromPointer(e.clientX))
  }

  const selectRep = (i: number) => {
    setSelected(i)
    setActiveHandle('start')
    const r = reps[i]
    if (r) seek(r.startMs / 1000)
  }

  const eccFirst = startsWith === 'eccentric'
  const handleTime = (h: Handle) => (!bounds ? 0 : h === 'start' ? bounds.startSec : h === 'turn' ? bounds.turnSec : bounds.endSec)

  return (
    <div className="editor">
      <div className="editor__videowrap">
        <video
          ref={videoRef}
          className="replay"
          playsInline
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
        />
      </div>

      <div
        className="timeline"
        ref={trackRef}
        onPointerDown={onTrackDown}
        onPointerMove={onTrackMove}
      >
        {reps.map((r, i) => {
          const b = repBounds(r, startsWith)
          return (
            <div key={r.index} className={`timeline__rep${i === sel ? ' is-selected' : ''}`}>
              <span
                className={`timeline__seg ${eccFirst ? 'seg--ecc' : 'seg--con'}`}
                style={{ left: pct(b.startSec), width: pct(b.turnSec - b.startSec) }}
              />
              <span
                className={`timeline__seg ${eccFirst ? 'seg--con' : 'seg--ecc'}`}
                style={{ left: pct(b.turnSec), width: pct(b.endSec - b.turnSec) }}
              />
            </div>
          )
        })}

        {bounds &&
          (['start', 'turn', 'end'] as Handle[]).map((h) => (
            <div
              key={h}
              className={`handle handle--${h}${activeHandle === h ? ' is-active' : ''}`}
              style={{ left: pct(handleTime(h)) }}
              onPointerDown={(e) => onHandleDown(e, h)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              role="slider"
              aria-label={`${h === 'turn' ? turnaroundLabel(startsWith) : h} of rep ${sel + 1}`}
              aria-valuenow={Math.round(handleTime(h) * 1000)}
            >
              <span className="handle__grip" />
            </div>
          ))}

        <span className="timeline__playhead" style={{ left: pct(currentTime) }} />
      </div>

      <div className="transport">
        <button className="tbtn" aria-label="Jump to rep start" onClick={() => bounds && seek(bounds.startSec)}>
          ⏮
        </button>
        <button className="tbtn" aria-label="Nudge active boundary back one frame" onClick={() => nudge(-1)}>
          ◁
        </button>
        <button className="tbtn tbtn--play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="tbtn" aria-label="Nudge active boundary forward one frame" onClick={() => nudge(1)}>
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
          <button key={r.index} className={`rep-pip${i === sel ? ' is-active' : ''}`} onClick={() => selectRep(i)}>
            {i + 1}
          </button>
        ))}
      </div>

      {rep && bounds && (
        <div className="card editor__panel">
          <div className="editor__row">
            <strong>Rep {sel + 1}</strong>
            <span className="muted small">
              {formatSeconds(rep.eccentricMs)} ↓ / {formatSeconds(rep.concentricMs)} ↑
            </span>
          </div>
          <div className="boundaries">
            {(['start', 'turn', 'end'] as Handle[]).map((h) => (
              <button
                key={h}
                className={`boundary${activeHandle === h ? ' is-active' : ''}`}
                onClick={() => {
                  setActiveHandle(h)
                  seek(handleTime(h))
                }}
              >
                <span className="boundary__label">{h === 'turn' ? turnaroundLabel(startsWith) : h}</span>
                <span className="boundary__time">{handleTime(h).toFixed(2)}s</span>
              </button>
            ))}
          </div>
          <p className="muted small">Drag a handle on the bar, or pick a boundary and use ◁ ▷ to nudge it frame-by-frame.</p>
        </div>
      )}
    </div>
  )
}
