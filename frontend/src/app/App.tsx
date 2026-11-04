import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Navigate, Outlet, RouterProvider, ScrollRestoration, createBrowserRouter, useLocation } from 'react-router-dom'
import { LibraryPage } from '../library/LibraryPage'
import { SeriesPage } from '../library/SeriesPage'
import { UploadTray } from '../library/upload/UploadTray'
import { ROUTE_EVENT } from '../offline/register'
import { Toasts } from '../ui/primitives'
import { usePreferences } from '../settings/store'
import { ReaderRoute } from './ReaderRoute'
import { SessionGate } from './SessionGate'
import { SessionWatcher } from './SessionWatcher'
import { SettingsPage } from './SettingsPage'
import { Shell } from './Shell'
import { StatsPage } from './StatsPage'
import { queryClient } from './queryClient'
import { applyTheme, watchSystemTheme } from './theme'

function ThemeSync() {
  const theme = usePreferences((s) => s.prefs.theme)
  const accent = usePreferences((s) => s.prefs.accent)
  const corners = usePreferences((s) => s.prefs.corners)
  const { bg, fg } = usePreferences((s) => s.prefs.customTheme)
  useEffect(() => {
    const apply = () => applyTheme({ theme, accent, corners, customTheme: { bg, fg } })
    apply()
    return watchSystemTheme(apply)
  }, [theme, accent, corners, bg, fg])
  return null
}

function Root() {
  const { pathname } = useLocation()
  useEffect(() => { window.dispatchEvent(new Event(ROUTE_EVENT)) }, [pathname])
  return (
    <>
      <ScrollRestoration />
      <Outlet />
      <UploadTray />
      <Toasts />
    </>
  )
}

const router = createBrowserRouter([{
  element: <Root />,
  children: [
    { path: '/read/:id', element: <ReaderRoute /> },
    {
      element: <SessionGate />,
      children: [{
        element: <Shell />,
        children: [
          { index: true, element: <LibraryPage /> },
          { path: '/series/:name', element: <SeriesPage /> },
          { path: '/stats', element: <StatsPage /> },
          { path: '/settings', element: <SettingsPage /> },
        ],
      }],
    },
    { path: '*', element: <Navigate to="/" replace /> },
  ],
}])

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <SessionWatcher />
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
