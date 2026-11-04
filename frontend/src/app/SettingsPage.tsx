import { Check, LogOut, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AuthStatus, Direction, DocKind } from '../api/types'
import { formatBytes, storageEstimate, useDownloads } from '../offline/downloads'
import { offlineSupported } from '../offline/scope'
import { ColorwayPicker } from '../settings/ColorwayPicker'
import type { Corners, Fit, Preferences, ReaderProfile, ReflowLayout, Spreads, TapLayout, Theme } from '../settings/schema'
import { usePreferences } from '../settings/store'
import { ColorField, Segmented, Switch, toast } from '../ui/primitives'
import { useLogout, useOnline, useReadySession } from './session'
import { THEMES, usableColors } from './theme'

declare const __APP_VERSION__: string

const CORNERS: readonly { value: Corners; label: string }[] = [{ value: 'sharp', label: 'Sharp' }, { value: 'soft', label: 'Soft' }, { value: 'round', label: 'Round' }]

const ACCENTS = [
  ['#7c9cff', 'Periwinkle'], ['#e8795f', 'Terracotta'], ['#e0b04c', 'Amber'], ['#4fb99a', 'Jade'],
  ['#e66f97', 'Rose'], ['#a78bda', 'Iris'], ['#c9ccd3', 'Silver'],
] as const

const COVER_SIZES = [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }] as const
const KINDS = [{ value: 'manga', label: 'Manga' }, { value: 'novel', label: 'Novels' }] as const
const DIRECTIONS: readonly { value: Direction; label: string }[] = [{ value: 'ltr', label: 'Left to right' }, { value: 'rtl', label: 'Right to left' }]
const MODES: readonly { value: ReaderProfile['mode']; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: 'paged', label: 'Paged' }, { value: 'scroll', label: 'Continuous' }, { value: 'reflow', label: 'Text' },
]
const TEXT_LAYOUTS: readonly { value: ReflowLayout; label: string }[] = [{ value: 'paged', label: 'Pages' }, { value: 'scroll', label: 'Continuous' }]
const SPREADS: readonly { value: Spreads; label: string }[] = [{ value: 'auto', label: 'Auto' }, { value: 'single', label: 'Single' }, { value: 'double', label: 'Double' }]
const FITS: readonly { value: Fit; label: string }[] = [
  { value: 'contain', label: 'Page' }, { value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'original', label: 'Original' },
]
const TAP_LAYOUTS: readonly { value: TapLayout; label: string }[] = [
  { value: 'sides', label: 'Sides' }, { value: 'kindle', label: 'Kindle' }, { value: 'edges', label: 'Edges' }, { value: 'off', label: 'Off' },
]

const SERVER_STATUS: Record<AuthStatus, string> = {
  disabled: 'Single library. Accounts aren’t set up on this server.',
  unavailable: 'The account service is unreachable, so everyone sees the shared library for now.',
  ok: 'Connected to the account service.',
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section"><h2>{title}</h2><div className="settings-card">{children}</div></section>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field-row">
      <span className="label">{label}{hint && <span className="hint">{hint}</span>}</span>
      {children}
    </div>
  )
}

function Stacked({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field-col"><span className="label">{label}</span>{children}</div>
}

function Appearance({ prefs, update }: { prefs: Preferences; update: (p: unknown) => void }) {
  const custom = !ACCENTS.some(([value]) => value === prefs.accent.toLowerCase())
  const customTheme = prefs.theme === 'custom'
  const usable = usableColors(prefs.customTheme.bg, prefs.customTheme.fg)
  const tile = (value: Theme, label: string, background: string, color: string) => (
    <button key={value} type="button" role="radio" aria-checked={prefs.theme === value} aria-label={label} className="theme-tile" onClick={() => update({ theme: value })}>
      <span style={{ background, color }}>Aa</span>
      {label}
    </button>
  )
  return (
    <Section title="Appearance">
      <Stacked label="Theme">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {tile('system', 'System', 'linear-gradient(135deg, #f6f6f7 50%, #0b0c0e 50%)', 'transparent')}
          {THEMES.map((t) => tile(t.value, t.label, t.bg, t.fg))}
          {tile('custom', 'Custom', usable.bg, usable.fg)}
        </div>
        {customTheme && (
          <div className="color-fields">
            <ColorField label="Background" value={usable.bg} onChange={(bg) => update({ customTheme: { bg } })} />
            <ColorField label="Text" value={prefs.customTheme.fg} onChange={(fg) => update({ customTheme: { fg } })} />
          </div>
        )}
        {customTheme && usable.adjusted && <p className="hint" role="status">That text color would be unreadable, so the app is using a clearer one.</p>}
      </Stacked>
      <Stacked label="Accent">
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={prefs.accent.toLowerCase() === value} aria-label={label} style={{ background: value }} onClick={() => update({ accent: value })}>
              {prefs.accent.toLowerCase() === value && <Check size={16} strokeWidth={3} color="var(--on-accent)" />}
            </button>
          ))}
          <label className="swatch-custom" data-on={custom} style={custom ? { background: prefs.accent } : undefined}>
            <span className="sr-only">Custom accent colour</span>
            <input type="color" value={prefs.accent} onChange={(e) => update({ accent: e.target.value })} />
          </label>
        </div>
      </Stacked>
      <Stacked label="Corners">
        <Segmented label="Corners" value={prefs.corners} options={CORNERS} onChange={(corners) => update({ corners })} />
      </Stacked>
      <Stacked label="Cover size">
        <Segmented label="Cover size" value={prefs.coverSize} options={COVER_SIZES} onChange={(coverSize) => update({ coverSize })} />
      </Stacked>
      <Row label="Group series" hint="Show volumes of a series as one stack">
        <Switch label="Group series" checked={prefs.groupSeries} onChange={(groupSeries) => update({ groupSeries })} />
      </Row>
      <Row label="Haptics" hint="A light tap on long-press, on devices that support it">
        <Switch label="Haptics" checked={prefs.haptics} onChange={(haptics) => update({ haptics })} />
      </Row>
    </Section>
  )
}

function ReadingDefaults({ prefs, update }: { prefs: Preferences; update: (p: unknown) => void }) {
  const [kind, setKind] = useState<DocKind>('manga')
  const profile = prefs.profiles[kind]
  const set = (patch: Partial<ReaderProfile>) => update({ profiles: { [kind]: patch } })
  return (
    <Section title="Reading defaults">
      <Segmented label="Defaults for" value={kind} options={KINDS} onChange={setKind} />
      <Stacked label="Direction"><Segmented label="Direction" value={profile.direction} options={DIRECTIONS} onChange={(direction) => set({ direction })} /></Stacked>
      <Stacked label="Default mode"><Segmented label="Default mode" value={profile.mode} options={MODES} onChange={(mode) => set({ mode })} /></Stacked>
      <Stacked label="Text flow"><Segmented label="Text flow" value={profile.reflow.layout} options={TEXT_LAYOUTS} onChange={(layout) => update({ profiles: { [kind]: { reflow: { layout } } } })} /></Stacked>
      <Stacked label="Spreads"><Segmented label="Spreads" value={profile.spreads} options={SPREADS} onChange={(spreads) => set({ spreads })} /></Stacked>
      <Stacked label="Fit"><Segmented label="Fit" value={profile.fit} options={FITS} onChange={(fit) => set({ fit })} /></Stacked>
      <Stacked label="Reading colors">
        <ColorwayPicker value={profile.background} custom={profile.customColors} showText onChange={(patch) => update({ profiles: { [kind]: patch } })} />
      </Stacked>
      <Stacked label="Tap zones"><Segmented label="Tap zones" value={profile.tapLayout} options={TAP_LAYOUTS} onChange={(tapLayout) => set({ tapLayout })} /></Stacked>
      <p className="hint">Every book can still override these from inside the reader.</p>
    </Section>
  )
}

function Storage() {
  const books = useDownloads((s) => s.books)
  const { remove, clear } = useDownloads()
  const [estimate, setEstimate] = useState<{ used: number; quota: number } | null>(null)
  const list = Object.values(books).sort((a, b) => b.downloadedAt - a.downloadedAt)
  const total = list.reduce((sum, b) => sum + b.size, 0)
  useEffect(() => { void storageEstimate().then(setEstimate) }, [books])
  if (!offlineSupported) {
    return <Section title="Storage"><p className="hint">Offline storage needs a secure (https) connection.</p></Section>
  }
  return (
    <Section title="Storage">
      <Row label="Downloaded books" hint={estimate ? `${formatBytes(estimate.used)} used of ${formatBytes(estimate.quota)} available` : undefined}>
        <span className="muted">{list.length > 0 ? formatBytes(total) : 'None'}</span>
      </Row>
      {list.length > 0 && (
        <ul className="download-list">
          {list.map((b) => (
            <li key={b.id}>
              <span className="download-title">{b.doc.title}</span>
              <span className="muted">{formatBytes(b.size)}</span>
              <button type="button" className="icon-btn" onClick={() => void remove(b.id)} aria-label={`Remove ${b.doc.title}`}><Trash2 size={18} /></button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 1 && <button type="button" className="btn" onClick={() => void clear().then(() => toast('Downloads cleared'))}>Clear all downloads</button>}
    </Section>
  )
}

function Account() {
  const session = useReadySession()
  const logout = useLogout()
  if (!session.user) return null
  return (
    <Section title="Account">
      <Row label={session.user.name} hint="Signing out removes this account’s downloads from this device">
        <button type="button" className="btn" onClick={() => logout.mutate()} disabled={logout.isPending}><LogOut size={16} aria-hidden="true" /> Sign out</button>
      </Row>
    </Section>
  )
}

export function SettingsPage() {
  const prefs = usePreferences((s) => s.prefs)
  const update = usePreferences((s) => s.update)
  const reset = usePreferences((s) => s.reset)
  const session = useReadySession()
  const online = useOnline()
  return (
    <div className="page settings">
      <header className="page-head"><h1>Settings</h1></header>
      <Account />
      <Appearance prefs={prefs} update={update} />
      <ReadingDefaults prefs={prefs} update={update} />
      <Storage />
      <Section title="About">
        <Row label="Server"><span className="status-text">{online ? SERVER_STATUS[session.auth_status] : 'Offline. Changes sync when you reconnect.'}</span></Row>
        <Row label="Upload limit"><span className="muted">{session.max_upload_mb.toLocaleString()} MB per file</span></Row>
        <Row label="Version"><span className="muted">Shelf {__APP_VERSION__}</span></Row>
        <button type="button" className="btn btn-danger" onClick={() => { reset(); toast('Settings reset to defaults') }}>Reset settings to default</button>
      </Section>
    </div>
  )
}
