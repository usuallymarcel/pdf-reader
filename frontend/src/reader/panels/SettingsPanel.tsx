import { useEffect, type ReactNode } from 'react'
import type { DocDetail, ReaderMode } from '../../api/types'
import type {
  Fit, PageBackground, ProgressIndicator, ReaderProfile, ReflowFont, ReflowLayout, Spreads, TapLayout, Transition, WheelAction,
} from '../../settings/schema'
import { Segmented, Sheet, Slider, Switch } from '../../ui/primitives'
import { BACKGROUNDS } from '../look'

export type Scope = 'book' | 'all'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field-row">
      <span className="label">{label}{hint && <span className="hint">{hint}</span>}</span>
      {children}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h3>{title}</h3>{children}</section>
}

export function SettingsPanel({ doc, profile: p, mode, scope, onScope, onChange, onMode, onReset, onClose }: {
  doc: DocDetail
  profile: ReaderProfile
  mode: ReaderMode
  scope: Scope
  onScope: (s: Scope) => void
  onChange: (patch: Record<string, unknown>) => void
  onMode: (m: ReaderMode) => void
  onReset: () => void
  onClose: () => void
}) {
  useEffect(() => {
    document.body.classList.add('reader-settings-open')
    return () => document.body.classList.remove('reader-settings-open')
  }, [])
  const kindLabel = doc.kind === 'manga' ? 'All manga' : 'All novels'
  const filter = (patch: Record<string, unknown>) => onChange({ filters: patch })
  const reflow = (patch: Record<string, unknown>) => onChange({ reflow: patch })
  const paged = mode === 'paged'
  const image = mode !== 'reflow'
  return (
    <Sheet title="Reading settings" onClose={onClose} modal={false}>
      <div className="settings-scope">
        <Segmented label="Apply settings to" value={scope} onChange={onScope}
          options={[{ value: 'book', label: 'This book' }, { value: 'all', label: kindLabel }]} />
      </div>

      <Group title="Layout">
        <div className="field-col">
          <Segmented<ReaderMode> label="Reading mode" value={mode} onChange={onMode}
            options={[{ value: 'paged', label: 'Paged' }, { value: 'scroll', label: 'Continuous' }, ...(doc.has_text ? [{ value: 'reflow' as const, label: 'Text' }] : [])]} />
          {!doc.has_text && <span className="hint">Text mode needs a book with a text layer; this one is image only.</span>}
        </div>
        {image && (
          <Row label="Direction">
            <Segmented label="Direction" value={p.direction} onChange={(direction) => onChange({ direction })}
              options={[{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]} />
          </Row>
        )}
        {paged && (
          <>
            <Row label="Spreads">
              <Segmented<Spreads> label="Spreads" value={p.spreads} onChange={(spreads) => onChange({ spreads })}
                options={[{ value: 'auto', label: 'Auto' }, { value: 'single', label: 'Single' }, { value: 'double', label: 'Double' }]} />
            </Row>
            <Row label="Cover alone"><Switch label="Cover alone" checked={p.coverAlone} onChange={(coverAlone) => onChange({ coverAlone })} /></Row>
            <Row label="Shift pairing by one" hint="For scans with misaligned facing pages">
              <Switch label="Shift pairing by one" checked={p.spreadShift} onChange={(spreadShift) => onChange({ spreadShift })} />
            </Row>
          </>
        )}
        {image && (
          <>
            <Row label="Fit">
              <Segmented<Fit> label="Fit" value={p.fit} onChange={(fit) => onChange({ fit })}
                options={[{ value: 'contain', label: 'Page' }, { value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'original', label: '100%' }]} />
            </Row>
            <Slider label="Page gap" value={p.pageGap} min={0} max={48} step={2} format={(v) => `${v}px`} onChange={(pageGap) => onChange({ pageGap })} />
          </>
        )}
        {paged && (
          <Row label="Crop margins"><Switch label="Crop margins" checked={p.cropMargins} onChange={(cropMargins) => onChange({ cropMargins })} /></Row>
        )}
      </Group>

      {mode === 'reflow' && (
        <Group title="Text">
          <div className="field-col">
            <Segmented<ReflowFont> label="Font" value={p.reflow.font} onChange={(font) => reflow({ font })}
              options={[{ value: 'literata', label: 'Literata' }, { value: 'inter', label: 'Inter' }, { value: 'serif', label: 'Serif' }, { value: 'system', label: 'System' }, { value: 'opendyslexic', label: 'Dyslexic' }]} />
          </div>
          <Slider label="Size" value={p.reflow.fontSize} min={12} max={36} step={1} format={(v) => `${v}px`} onChange={(fontSize) => reflow({ fontSize })} />
          <Slider label="Line height" value={p.reflow.lineHeight} min={1.1} max={2.4} step={0.05} format={(v) => v.toFixed(2)} onChange={(lineHeight) => reflow({ lineHeight })} />
          <Slider label="Margin" value={p.reflow.margin} min={0} max={96} step={4} format={(v) => `${v}px`} onChange={(margin) => reflow({ margin })} />
          <Slider label="Line length" value={p.reflow.maxWidth} min={40} max={100} step={2} format={(v) => `${v} ch`} onChange={(maxWidth) => reflow({ maxWidth })} />
          <Slider label="Paragraph spacing" value={p.reflow.paragraphSpacing} min={0} max={2} step={0.1} format={(v) => `${v.toFixed(1)} em`} onChange={(paragraphSpacing) => reflow({ paragraphSpacing })} />
          <Slider label="Indent" value={p.reflow.indent} min={0} max={3} step={0.1} format={(v) => `${v.toFixed(1)} em`} onChange={(indent) => reflow({ indent })} />
          <Row label="Justify"><Switch label="Justify" checked={p.reflow.justify} onChange={(justify) => reflow({ justify })} /></Row>
          <Row label="Hyphenate"><Switch label="Hyphenate" checked={p.reflow.hyphenate} onChange={(hyphenate) => reflow({ hyphenate })} /></Row>
          <Row label="Layout">
            <Segmented<ReflowLayout> label="Text layout" value={p.reflow.layout} onChange={(layout) => reflow({ layout })}
              options={[{ value: 'paged', label: 'Pages' }, { value: 'scroll', label: 'Scroll' }]} />
          </Row>
          <Row label="Columns">
            <Segmented<'auto' | 1 | 2> label="Columns" value={p.reflow.columns} onChange={(columns) => reflow({ columns })}
              options={[{ value: 'auto', label: 'Auto' }, { value: 1, label: '1' }, { value: 2, label: '2' }]} />
          </Row>
        </Group>
      )}

      <Group title="Look">
        <div className="swatches" role="radiogroup" aria-label="Background">
          {(Object.keys(BACKGROUNDS) as PageBackground[]).map((b) => (
            <button key={b} type="button" role="radio" aria-checked={p.background === b} aria-label={b} className="swatch"
              style={{ background: BACKGROUNDS[b] }} onClick={() => onChange({ background: b })} />
          ))}
        </div>
        <Slider label="Brightness" value={p.filters.brightness} min={0.3} max={1.3} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(brightness) => filter({ brightness })} />
        <Slider label="Contrast" value={p.filters.contrast} min={0.7} max={1.5} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(contrast) => filter({ contrast })} />
        <Slider label="Warmth" value={p.filters.warmth} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(warmth) => filter({ warmth })} />
        <Row label="Invert"><Switch label="Invert" checked={p.filters.invert} onChange={(invert) => filter({ invert })} /></Row>
        <Row label="Grayscale"><Switch label="Grayscale" checked={p.filters.grayscale} onChange={(grayscale) => filter({ grayscale })} /></Row>
      </Group>

      <Group title="Controls">
        <Row label="Tap layout">
          <Segmented<TapLayout> label="Tap layout" value={p.tapLayout} onChange={(tapLayout) => onChange({ tapLayout })}
            options={[{ value: 'sides', label: 'Sides' }, { value: 'kindle', label: 'Kindle' }, { value: 'edges', label: 'Edges' }, { value: 'off', label: 'Off' }]} />
        </Row>
        <Row label="Invert taps"><Switch label="Invert taps" checked={p.tapInvert} onChange={(tapInvert) => onChange({ tapInvert })} /></Row>
        <Row label="Swipe to turn"><Switch label="Swipe to turn" checked={p.swipe} onChange={(swipe) => onChange({ swipe })} /></Row>
        <Row label="Transition">
          <Segmented<Transition> label="Transition" value={p.transition} onChange={(transition) => onChange({ transition })}
            options={[{ value: 'slide', label: 'Slide' }, { value: 'fade', label: 'Fade' }, { value: 'none', label: 'None' }]} />
        </Row>
        <Row label="Mouse wheel">
          <Segmented<WheelAction> label="Mouse wheel" value={p.wheel} onChange={(wheel) => onChange({ wheel })}
            options={[{ value: 'page', label: 'Page' }, { value: 'zoom', label: 'Zoom' }, { value: 'scroll', label: 'Scroll' }]} />
        </Row>
        <Row label="Sticky zoom" hint="Keep the zoom level when turning pages">
          <Switch label="Sticky zoom" checked={p.stickyZoom} onChange={(stickyZoom) => onChange({ stickyZoom })} />
        </Row>
      </Group>

      <Group title="While reading">
        <Row label="Progress">
          <Segmented<ProgressIndicator> label="Progress indicator" value={p.indicator} onChange={(indicator) => onChange({ indicator })}
            options={[{ value: 'off', label: 'Off' }, { value: 'hairline', label: 'Line' }, { value: 'pages', label: 'Pages' }]} />
        </Row>
        <Slider label="Preload" value={p.preload} min={1} max={8} step={1} format={(v) => `${v} ${v === 1 ? 'page' : 'pages'}`} onChange={(preload) => onChange({ preload })} />
        <Row label="Keep screen awake"><Switch label="Keep screen awake" checked={p.keepAwake} onChange={(keepAwake) => onChange({ keepAwake })} /></Row>
        <Row label="Continue to next volume"><Switch label="Continue to next volume" checked={p.autoNextVolume} onChange={(autoNextVolume) => onChange({ autoNextVolume })} /></Row>
      </Group>

      <button type="button" className="btn settings-reset" onClick={onReset}>
        {scope === 'book' ? 'Reset this book to defaults' : `Reset ${kindLabel.toLowerCase()}`}
      </button>
    </Sheet>
  )
}
