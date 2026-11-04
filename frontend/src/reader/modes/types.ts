import type { ReaderProfile } from '../../settings/schema'
import type { PageSize } from '../layout/spreads'
import type { Position } from '../layout/position'
import type { PageRenderer } from '../pdf/renderer'

/** Everything a stage needs from the reader around it. */
export interface StageEnv {
  sizes: readonly PageSize[]
  renderer: PageRenderer
  /** Host for the end-of-book card; a stage places it after the last page. */
  endCard: HTMLElement
  /** The reader moved; fires on every settled page change. */
  onPosition(pos: Position, fraction?: number): void
  /** The end card came into view / left. */
  onEndCard(visible: boolean): void
  onBoundary(edge: 'start' | 'end'): void
  /** Forward gesture on the end card. */
  onPastEnd(): void
  /** True when a forward gesture past the end leads somewhere (next volume). */
  hasNext(): boolean
  onMenuTap(): void
  /** A page turn happened by any means: lets the chrome get out of the way. */
  onFlip(): void
  /** Reader-level popups (chrome or panels) that a tap should dismiss rather than act through. */
  overlayOpen(): boolean
  dismissOverlay(): void
  onZoomed(zoomed: boolean): void
}

export interface ReaderStage {
  next(): void
  prev(): void
  goTo(pos: Position, animate?: boolean): void
  goToEnd(): void
  zoomBy(factor: number): void
  zoomReset(): void
  update(profile: ReaderProfile): void
  position(): Position
  destroy(): void
}

export const dpr = () => Math.min(window.devicePixelRatio || 1, 3)
