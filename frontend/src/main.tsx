import '@fontsource-variable/inter/index.css'
import './styles/tokens.css'
import './styles/base.css'
import './app/app.css'
import './library/library.css'
import './auth/auth.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { queryClient } from './app/queryClient'
import { cachedSession } from './app/session'
import { applyTheme } from './app/theme'
import { startProgressSync } from './offline/progress'
import { registerServiceWorker } from './offline/register'
import { activateScope, scopeOf } from './offline/scope'
import { usePreferences } from './settings/store'

// Before first render, so a stored theme never flashes. public/boot.js covers the paint before this runs.
applyTheme(usePreferences.getState().prefs)

// Offline boots rely on this: the scope must be right before the first query or progress write.
const session = cachedSession()
if (session) void activateScope(scopeOf(session))

startProgressSync(() => { void queryClient.invalidateQueries({ queryKey: ['library'] }) })
void registerServiceWorker()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
