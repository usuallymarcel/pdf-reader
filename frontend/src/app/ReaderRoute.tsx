import { Suspense, lazy, useRef } from 'react'
import { Boot } from '../ui/primitives'
import { useGateScreen } from './SessionGate'

const ReaderPage = lazy(() => import('../reader/ReaderPage'))

/**
 * Gate on entry only. Once admitted the reader is never unmounted by a session change: if the mode
 * flips or the session ends mid-book, the login appears at the next library navigation.
 */
export function ReaderRoute() {
  const screen = useGateScreen()
  const admitted = useRef(false)
  if (!screen) admitted.current = true
  if (!admitted.current) return screen
  return <Suspense fallback={<Boot label="Opening book" />}><ReaderPage /></Suspense>
}
