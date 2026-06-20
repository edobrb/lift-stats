import { useEffect, useState } from 'react'
import type { ExerciseId, Profile, WeightUnit } from '../types'
import { EXERCISE_ORDER, EXERCISES, getExercise } from '../config/exercises'
import { getProfile } from '../storage/profiles'
import { appStore, sessionStore, useApp } from '../state/store'
import { navigate } from '../hooks/useRouter'

export const HomeScreen = () => {
  const app = useApp()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [selected, setSelected] = useState<ExerciseId | null>(null)
  const [weight, setWeight] = useState('')

  useEffect(() => {
    if (!app.profileId) {
      setProfile(null)
      return
    }
    let active = true
    getProfile(app.profileId).then((p) => {
      if (active) setProfile(p ?? null)
    })
    return () => {
      active = false
    }
  }, [app.profileId])

  const startTracking = () => {
    if (!selected) return
    const parsed = weight.trim() === '' ? null : Number(weight)
    const validWeight = parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null
    sessionStore.set({ pending: { exercise: selected, weight: validWeight } })
    navigate({ name: 'track' })
  }

  const exercise = selected ? getExercise(selected) : null

  return (
    <div className="screen">
      <header className="screen__head">
        <h1>Track a set</h1>
        <p className="muted">{profile ? `Athlete: ${profile.name}` : 'Select a profile first.'}</p>
      </header>

      <div className="grid">
        {EXERCISE_ORDER.map((id) => {
          const ex = EXERCISES[id]
          return (
            <button
              key={id}
              className={`tile${selected === id ? ' is-active' : ''}`}
              onClick={() => setSelected(id)}
            >
              <span className="tile__emoji">{ex.emoji}</span>
              <span className="tile__name">{ex.name}</span>
            </button>
          )
        })}
      </div>

      {exercise && (
        <div className="card config">
          <p className="config__guidance">{exercise.guidance}</p>

          <label className="field">
            <span>Weight (optional)</span>
            <div className="row">
              <input
                className="input"
                type="number"
                inputMode="decimal"
                placeholder="—"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                min={0}
              />
              <div className="seg">
                {(['kg', 'lb'] as WeightUnit[]).map((u) => (
                  <button
                    key={u}
                    className={`seg__btn${app.unit === u ? ' is-active' : ''}`}
                    onClick={() => appStore.set({ unit: u })}
                    type="button"
                  >
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={app.recordVideo}
              onChange={(e) => appStore.set({ recordVideo: e.target.checked })}
            />
            <span>Record video clip of the set</span>
          </label>

          <button className="btn btn--primary btn--big" onClick={startTracking} disabled={!app.profileId}>
            Start {exercise.name}
          </button>
        </div>
      )}
    </div>
  )
}
