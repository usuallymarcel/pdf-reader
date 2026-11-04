import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { ApiError, api } from '../api/client'
import type { Session } from '../api/types'
import { SESSION_KEY } from '../app/session'

const FAILURES: Record<number, string> = {
  401: 'That name and password don’t match.',
  403: 'Sign-ups are turned off on this server.',
  409: 'That name is already taken.',
  429: 'Too many attempts. Wait a minute and try again.',
}

export function LoginPage({ session }: { session: Session }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signup = mode === 'signup'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (signup && password.length < 8) { setError('Use at least 8 characters for your password.'); return }
    setBusy(true)
    try {
      const next = await (signup ? api.signup(name.trim(), password) : api.login(name.trim(), password))
      qc.setQueryData(SESSION_KEY, next)
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) void qc.invalidateQueries({ queryKey: SESSION_KEY })
      setError(err instanceof ApiError ? FAILURES[err.status] ?? err.message : 'Can’t reach the server. Check your connection.')
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <img src="/icon.svg" alt="" width="56" height="56" className="login-mark" />
        <h1>Shelf</h1>
        <p className="login-lead">{signup ? 'Create an account to start your library.' : 'Sign in to your library.'}</p>
        <label className="input-field">Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={100} />
        </label>
        <label className="input-field">Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{signup ? 'Create account' : 'Sign in'}</button>
        {session.allow_signup && (
          <button type="button" className="login-switch" onClick={() => { setMode(signup ? 'login' : 'signup'); setError(null) }}>
            {signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
        )}
      </form>
    </main>
  )
}
