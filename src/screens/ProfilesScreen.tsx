import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Profile } from '../types'
import { listProfiles, createProfile, deleteProfile } from '../storage/profiles'
import { requestPersistentStorage, storageEstimate } from '../storage/db'
import { appStore, useApp } from '../state/store'
import { navigate } from '../hooks/useRouter'
import { formatBytes, formatDate } from '../lib/timing'

export const ProfilesScreen = () => {
  const app = useApp()
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [storage, setStorage] = useState<{ usage: number; quota: number; pct: number } | null>(null)

  const refresh = useCallback(async () => {
    setProfiles(await listProfiles())
    setStorage(await storageEstimate())
  }, [])

  useEffect(() => {
    void requestPersistentStorage()
    void refresh()
  }, [refresh])

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const profile = await createProfile(name)
    setName('')
    appStore.set({ profileId: profile.id })
    await refresh()
  }

  const select = (id: string) => {
    appStore.set({ profileId: id })
    navigate({ name: 'home' })
  }

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`Delete "${label}" and all of its tracked sets? This cannot be undone.`)) return
    await deleteProfile(id)
    if (app.profileId === id) appStore.set({ profileId: null })
    await refresh()
  }

  return (
    <div className="screen">
      <header className="screen__head">
        <h1>Profiles</h1>
        <p className="muted">Everything is stored on this device only.</p>
      </header>

      <form className="card row" onSubmit={add}>
        <input
          className="input"
          placeholder="New profile name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
        />
        <button className="btn btn--primary" type="submit">
          Add
        </button>
      </form>

      <ul className="list">
        {profiles.map((profile) => (
          <li key={profile.id} className={`list__item${app.profileId === profile.id ? ' is-active' : ''}`}>
            <button className="list__main" onClick={() => select(profile.id)}>
              <span className="avatar">{profile.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{profile.name}</strong>
                <span className="muted block">since {formatDate(profile.createdAt)}</span>
              </span>
            </button>
            <button className="iconbtn" aria-label="Delete profile" onClick={() => remove(profile.id, profile.name)}>
              🗑
            </button>
          </li>
        ))}
        {profiles.length === 0 && <li className="empty">No profiles yet — add one to start.</li>}
      </ul>

      {storage && storage.quota > 0 && (
        <p className="muted small">
          Storage used: {formatBytes(storage.usage)} of {formatBytes(storage.quota)} ({Math.round(storage.pct * 100)}%)
        </p>
      )}
    </div>
  )
}
