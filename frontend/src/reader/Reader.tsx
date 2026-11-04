import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, fileUrl } from '../api/client'
import type { Bookmark, DocDetail, ReaderMode } from '../api/types'
import { deepMerge, DEFAULT_PREFERENCES, resolveProfile, type ReaderProfile } from '../settings/schema'
import { usePreferences } from '../settings/store'
import { toast } from '../ui/primitives'
import { BottomBar, CursorIdle, Indicator, TopBar } from './chrome/Bars'
import { EndCard } from './chrome/EndCard'
import { ShortcutsOverlay } from './chrome/ShortcutsOverlay'
import { TapHint } from './chrome/TapHint'
import { toggleFullscreen, useThemeColor, useWakeLock } from './hooks/device'
import { useProgress } from './hooks/useProgress'
import { isTypingTarget, resolveKey, type KeyAction } from './input/keyboard'
import { adjacentVolume, positionToAnchor, type Position } from './layout/position'
import { BACKGROUNDS, effectiveMode, filterCss, nextMode, stripOverrides } from './look'
import { PagedStage } from './modes/PagedStage'
import { buildBook, type ReflowStageApi } from './modes/reflowDom'
import { ReflowPaged } from './modes/ReflowPaged'
import { ReflowScroll } from './modes/ReflowScroll'
import { ScrollStage } from './modes/ScrollStage'
import type { ReaderStage, StageEnv } from './modes/types'
import { ContentsPanel } from './panels/ContentsPanel'
import { SearchPanel } from './panels/SearchPanel'
import { SettingsPanel, type Scope } from './panels/SettingsPanel'
import { detectLimits } from './pdf/device'
import { PdfEngine } from './pdf/engine'
import { PageRenderer } from './pdf/renderer'
import { useReaderUi, type Panel } from './store'

const OVERRIDE_SAVE_MS = 700

declare global {
  interface Window { __shelf?: { renderer: PageRenderer | null; stage: () => ReaderStage | null; engine: PdfEngine | null } }
}

const isReflowStage = (s: ReaderStage | null): s is ReflowStageApi => !!s && 'goToAnchor' in s

/** The open book: owns the engine, the active stage and everything around it. */
export function Reader({ doc }: { doc: DocDetail }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const id = doc.id
  const prefs = usePreferences((s) => s.prefs)
  const updatePrefs = usePreferences((s) => s.update)
  const [overrides, setOverrides] = useState<Record<string, unknown>>(doc.state.overrides ?? {})
  const [scope, setScope] = useState<Scope>(Object.keys(doc.state.overrides ?? {}).length ? 'book' : 'all')
  const profile = useMemo(
    () => resolveProfile(prefs, doc.kind, overrides, doc.direction),
    [prefs, doc.kind, overrides, doc.direction],
  )
  const mode = effectiveMode(profile, doc)
  const stageKind = mode === 'reflow' ? `reflow-${profile.reflow.layout}` : mode

  const library = useQuery({ queryKey: ['library'], queryFn: api.library, staleTime: 60_000 })
  const nextVolume = useMemo(() => adjacentVolume(library.data ?? [], doc, 1), [library.data, doc])
  const prevVolume = useMemo(() => adjacentVolume(library.data ?? [], doc, -1), [library.data, doc])
  const reflowDoc = useQuery({
    queryKey: ['reflow', id],
    queryFn: () => api.reflow(id),
    enabled: mode === 'reflow' && doc.has_text,
    staleTime: Infinity,
    retry: 1,
  })
  const book = useMemo(
    () => (reflowDoc.data ? buildBook(reflowDoc.data, doc.outline) : null),
    [reflowDoc.data, doc.outline],
  )

  const [renderer, setRenderer] = useState<PageRenderer | null>(null)
  const engineRef = useRef<PdfEngine | null>(null)
  useEffect(() => {
    const engine = new PdfEngine(fileUrl(id))
    const pageRenderer = new PageRenderer(engine, doc.page_sizes, detectLimits())
    engineRef.current = engine
    setRenderer(pageRenderer)
    // A macrotask, so StrictMode's throwaway first effect never starts a download.
    const open = window.setTimeout(() => engine.preload(), 0)
    return () => {
      window.clearTimeout(open)
      pageRenderer.destroy()
      engine.destroy()
      engineRef.current = null
      setRenderer(null)
    }
  }, [id, doc.page_sizes])

  const stage = useRef<ReaderStage | null>(null)
  const stageEl = useRef<HTMLDivElement>(null)
  // A ?page= deep link (library search hit) opens there instead of the saved position.
  const [searchParams] = useSearchParams()
  const linkedPage = Number(searchParams.get('page'))
  const posRef = useRef<Position>(
    Number.isInteger(linkedPage) && linkedPage >= 1 && linkedPage <= doc.page_count
      ? { page: linkedPage, offset: 0 }
      : { page: Math.max(1, doc.state.page), offset: doc.state.offset },
  )
  const profileRef = useRef(profile)
  profileRef.current = profile
  const endHost = useMemo(() => {
    const el = document.createElement('div')
    el.className = 'endcard-host'
    return el
  }, [])

  const ui = useReaderUi((s) => s.set)
  useEffect(() => {
    ui({ position: posRef.current, fraction: posRef.current.page / Math.max(1, doc.page_count), chrome: false, panel: null, atEnd: false, zoomed: false })
  }, [ui, doc.page_count])

  const jumpTo = useCallback((pos: Position) => stage.current?.goTo(pos), [])
  const reportProgress = useProgress(doc, jumpTo)

  const finishedSent = useRef(doc.state.finished)
  const haptics = prefs.haptics
  const hooks = useRef({ nextVolume, reportProgress, haptics })
  hooks.current = { nextVolume, reportProgress, haptics }

  const env = useMemo((): StageEnv | null => {
    if (!renderer) return null
    return {
      sizes: doc.page_sizes,
      renderer,
      endCard: endHost,
      onPosition(pos, fraction) {
        posRef.current = pos
        ui({ position: pos, fraction: fraction ?? pos.page / doc.page_count })
        hooks.current.reportProgress(pos)
      },
      onEndCard(visible) {
        ui({ atEnd: visible })
        if (visible && !finishedSent.current) {
          finishedSent.current = true
          api.patchState(doc.id, { finished: true }).catch(() => { finishedSent.current = false })
        }
      },
      onBoundary() { if (hooks.current.haptics) navigator.vibrate?.(14) },
      onPastEnd() {
        const v = hooks.current.nextVolume
        if (v) navigate(`/read/${v.id}`, { replace: true })
      },
      hasNext: () => !!hooks.current.nextVolume,
      onMenuTap() {
        const s = useReaderUi.getState()
        if (s.panel) ui({ panel: null })
        else ui({ chrome: !s.chrome })
      },
      onFlip() { if (useReaderUi.getState().chrome) ui({ chrome: false }) },
      overlayOpen() {
        const s = useReaderUi.getState()
        return s.chrome || (!!s.panel && s.panel !== 'settings')
      },
      dismissOverlay() { ui({ chrome: false, panel: null }) },
      onZoomed(zoomed) { ui({ zoomed }) },
    }
  }, [renderer, doc.page_sizes, doc.page_count, doc.id, endHost, navigate, ui])

  // Before paint, so a mode switch never shows an empty frame.
  useLayoutEffect(() => {
    const root = stageEl.current
    if (!root || !env) return
    if (stageKind.startsWith('reflow') && !book) return
    let s: ReaderStage
    const start = posRef.current
    if (stageKind === 'paged') s = new PagedStage(root, env, profileRef.current, start)
    else if (stageKind === 'scroll') s = new ScrollStage(root, env, profileRef.current, start)
    else if (book) {
      const anchor = positionToAnchor(book.index, start)
      s = stageKind === 'reflow-scroll'
        ? new ReflowScroll(root, env, book, profileRef.current, anchor)
        : new ReflowPaged(root, env, book, profileRef.current, anchor)
    } else return
    stage.current = s
    if (import.meta.env.DEV) window.__shelf = { renderer: env.renderer, stage: () => stage.current, engine: engineRef.current }
    root.focus({ preventScroll: true })
    return () => {
      posRef.current = s.position()
      s.destroy()
      stage.current = null
    }
  }, [env, stageKind, book])

  useEffect(() => { stage.current?.update(profile) }, [profile])

  useEffect(() => {
    if (reflowDoc.isError) {
      toast('Reflow text is not available for this book')
      setOverrides((o) => deepMerge(o, { mode: 'paged' }))
    }
  }, [reflowDoc.isError])

  useWakeLock(profile.keepAwake)
  const background = BACKGROUNDS[profile.background]
  useThemeColor(background)

  /* ---------- settings ---------- */

  const saveTimer = useRef<number | undefined>(undefined)
  const persistOverrides = useCallback((next: Record<string, unknown>) => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      api.patchState(id, { overrides: next }).catch(() => undefined)
    }, OVERRIDE_SAVE_MS)
  }, [id])

  const setProfile = useCallback((patch: Record<string, unknown>, forceBook = false) => {
    if (scope === 'book' || forceBook) {
      setOverrides((o) => {
        const next = deepMerge(o, patch)
        persistOverrides(next)
        return next
      })
    } else {
      updatePrefs({ profiles: { [doc.kind]: patch } })
      setOverrides((o) => {
        const next = stripOverrides(o, patch)
        if (Object.keys(next).length !== Object.keys(o).length) persistOverrides(next)
        return next
      })
    }
  }, [scope, doc.kind, updatePrefs, persistOverrides])

  const resetProfile = useCallback(() => {
    if (scope === 'book') {
      setOverrides({})
      persistOverrides({})
    } else {
      updatePrefs({ profiles: { [doc.kind]: DEFAULT_PREFERENCES.profiles[doc.kind] } })
    }
  }, [scope, doc.kind, updatePrefs, persistOverrides])

  const setMode = useCallback((m: ReaderMode) => setProfile({ mode: m }, true), [setProfile])

  /* ---------- bookmarks ---------- */

  const bookmarks = doc.bookmarks
  const setBookmarks = useCallback((update: (b: Bookmark[]) => Bookmark[]) => {
    queryClient.setQueryData<DocDetail>(['document', id], (d) => (d ? { ...d, bookmarks: update(d.bookmarks) } : d))
  }, [queryClient, id])

  const toggleBookmark = useCallback(() => {
    const { page } = useReaderUi.getState().position
    const existing = bookmarks.find((b) => b.page === page)
    if (existing) {
      setBookmarks((b) => b.filter((x) => x.id !== existing.id))
      api.deleteBookmark(existing.id).catch(() => toast('Could not remove the bookmark'))
    } else {
      const s = stage.current
      const locator = isReflowStage(s) ? s.anchor().block : undefined
      api.addBookmark(id, { page, locator }).then(
        (b) => setBookmarks((list) => [...list, b]),
        () => toast('Could not save the bookmark'),
      )
    }
  }, [bookmarks, setBookmarks, id])

  const openBookmark = useCallback((b: Bookmark) => {
    const s = stage.current
    if (isReflowStage(s) && b.locator !== null) s.goToAnchor({ block: b.locator, char: 0 })
    else s?.goTo({ page: b.page, offset: 0 })
  }, [])

  /* ---------- commands ---------- */

  const back = useCallback(() => {
    if (window.history.state?.idx > 0) navigate(-1)
    else navigate('/')
  }, [navigate])

  const togglePanel = useCallback((panel: Panel) => {
    const s = useReaderUi.getState()
    ui({ panel: s.panel === panel ? null : panel, chrome: false })
  }, [ui])

  const run = useCallback((action: KeyAction) => {
    const s = stage.current
    const state = useReaderUi.getState()
    switch (action) {
      case 'next': s?.next(); break
      case 'prev': s?.prev(); break
      case 'first': s?.goTo({ page: 1, offset: 0 }); break
      case 'last': s?.goToEnd(); break
      case 'zoomIn': s?.zoomBy(1.25); break
      case 'zoomOut': s?.zoomBy(0.8); break
      case 'zoomReset': s?.zoomReset(); break
      case 'fullscreen': toggleFullscreen(); break
      case 'cycleMode': setMode(nextMode(effectiveMode(profileRef.current, doc), doc.has_text)); break
      case 'bookmark': toggleBookmark(); break
      case 'contents': togglePanel('contents'); break
      case 'settings': togglePanel('settings'); break
      case 'search': togglePanel('search'); break
      case 'shortcuts': togglePanel('shortcuts'); break
      case 'prevVolume': if (prevVolume) navigate(`/read/${prevVolume.id}`, { replace: true }); break
      case 'nextVolume': if (nextVolume) navigate(`/read/${nextVolume.id}`, { replace: true }); break
      case 'escape':
        if (state.panel) ui({ panel: null })
        else if (state.chrome) ui({ chrome: false })
        else back()
        break
    }
  }, [doc, setMode, toggleBookmark, togglePanel, prevVolume, nextVolume, navigate, back, ui])

  const rtl = profile.direction === 'rtl'
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return
      const action = resolveKey(e, stageKind.startsWith('reflow') ? false : rtl)
      if (!action) return
      // Let a focused control keep Space, Enter and arrows.
      const onControl = e.target instanceof HTMLButtonElement || (e.target instanceof HTMLInputElement)
      if (onControl && (e.key === ' ' || e.key.startsWith('Arrow'))) return
      e.preventDefault()
      run(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [run, rtl, stageKind])

  const panel = useReaderUi((s) => s.panel)
  const closePanel = useCallback(() => {
    ui({ panel: null })
    stageEl.current?.focus({ preventScroll: true })
  }, [ui])
  const showBoot = stageKind.startsWith('reflow') && !book

  return (
    <div className="reader" style={{ '--reader-bg': background } as React.CSSProperties}>
      <div className="reader-filter" style={{ filter: filterCss(profile.filters) }}>
        <div key={stageKind} ref={stageEl} className="reader-stage" tabIndex={-1} role="application" aria-label={`${doc.title}, reader`} />
      </div>
      {showBoot && <div className="reader-boot" role="status" aria-label="Loading text"><Loader2 className="reader-spin" size={24} /></div>}
      {createPortal(
        <EndCard doc={doc} next={nextVolume} background={background} onBack={back}
          onNext={() => { if (nextVolume) navigate(`/read/${nextVolume.id}`, { replace: true }) }} />,
        endHost,
      )}
      <Indicator kind={profile.indicator} total={doc.page_count} rtl={rtl && !stageKind.startsWith('reflow')} />
      <CursorIdle />
      <TopBar doc={doc} bookmarks={bookmarks} onBack={back} onBookmark={toggleBookmark}
        onPanel={togglePanel} />
      <BottomBar doc={doc} renderer={renderer} rtl={rtl && mode !== 'reflow'} mode={mode}
        onSeek={(page) => stage.current?.goTo({ page, offset: 0 })}
        onCycleMode={() => run('cycleMode')} />
      <TapHint layout={profile.tapLayout} rtl={rtl && mode !== 'reflow'} invert={profile.tapInvert} enabled={stageKind !== 'scroll' && stageKind !== 'reflow-scroll'} />
      {panel === 'contents' && (
        <ContentsPanel doc={doc} renderer={renderer} bookmarks={bookmarks} onClose={closePanel}
          onJump={(page) => { stage.current?.goTo({ page, offset: 0 }); closePanel() }}
          onBookmark={(b) => { openBookmark(b); closePanel() }} />
      )}
      {panel === 'search' && (
        <SearchPanel docId={id} onClose={closePanel}
          onJump={(page) => { stage.current?.goTo({ page, offset: 0 }); closePanel() }} />
      )}
      {panel === 'settings' && (
        <SettingsPanel doc={doc} profile={profile as ReaderProfile} mode={mode} scope={scope} onScope={setScope}
          onChange={setProfile} onMode={setMode} onReset={resetProfile} onClose={closePanel} />
      )}
      {panel === 'shortcuts' && <ShortcutsOverlay onClose={closePanel} />}
    </div>
  )
}
