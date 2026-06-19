import { useEffect, useState } from 'react'
import type { ExerciseId, LiftSet } from '../types'
import { EXERCISE_ORDER, EXERCISES, getExercise } from '../config/exercises'
import { listSetsByProfile, deleteSet } from '../storage/sets'
import { aggregateReps } from '../lib/metrics'
import { useApp } from '../state/store'
import { navigate } from '../hooks/useRouter'
import { formatClock, formatDate, formatSeconds } from '../lib/timing'

type Filter = ExerciseId | 'all'

export const HistoryScreen = () => {
  const app = useApp()
  const [sets, setSets] = useState<LiftSet[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    if (!app.profileId) {
      setSets([])
      setLoading(false)
      return
    }
    setLoading(true)
    listSetsByProfile(app.profileId).then((rows) => {
      if (active) {
        setSets(rows)
        setLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [app.profileId])

  const remove = async (setId: string, label: string) => {
    if (!window.confirm(`Delete this ${label} set and its recording?`)) return
    await deleteSet(setId)
    setSets((current) => current.filter((s) => s.id !== setId))
  }

  const shown = filter === 'all' ? sets : sets.filter((s) => s.exercise === filter)

  return (
    <div className="screen">
      <header className="screen__head">
        <h1>History</h1>
      </header>

      <div className="chips">
        <button className={`chip${filter === 'all' ? ' is-active' : ''}`} onClick={() => setFilter('all')}>
          All
        </button>
        {EXERCISE_ORDER.map((id) => (
          <button key={id} className={`chip${filter === id ? ' is-active' : ''}`} onClick={() => setFilter(id)}>
            {EXERCISES[id].emoji} {EXERCISES[id].name}
          </button>
        ))}
      </div>

      <ul className="list">
        {shown.map((set) => {
          const ex = getExercise(set.exercise)
          const agg = aggregateReps(set.reps)
          return (
            <li key={set.id} className="list__item">
              <button className="list__main" onClick={() => navigate({ name: 'setDetail', id: set.id })}>
                <span className="avatar avatar--emoji">{ex.emoji}</span>
                <span className="grow">
                  <strong>
                    {ex.name}
                    {set.weight !== null ? ` · ${set.weight}${set.unit}` : ''}
                  </strong>
                  <span className="muted block">
                    {set.repCount} reps · {formatSeconds(agg.avgEccentricMs)}↓ / {formatSeconds(agg.avgConcentricMs)}↑ · TUT {formatClock(agg.timeUnderTensionMs)}
                  </span>
                  <span className="muted small">{formatDate(set.startedAt)}</span>
                </span>
              </button>
              <button className="iconbtn" aria-label="Delete set" onClick={() => remove(set.id, ex.name)}>
                🗑
              </button>
            </li>
          )
        })}
        {!loading && shown.length === 0 && <li className="empty">No sets recorded yet.</li>}
      </ul>
    </div>
  )
}
