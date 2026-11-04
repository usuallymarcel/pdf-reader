import { useState } from 'react'
import { coverUrl } from '../api/client'
import type { Doc } from '../api/types'

/** Lazy cover that fades in; a quiet typeset placeholder stands in until one exists. */
export function Cover({ doc, eager = false }: { doc: Doc; eager?: boolean }) {
  // Remount on a new version so a cover that arrives after processing replaces the placeholder.
  return <CoverImage key={doc.cover_version ?? 'none'} doc={doc} eager={eager} />
}

function CoverImage({ doc, eager }: { doc: Doc; eager: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'missing'>(doc.cover_version ? 'loading' : 'missing')
  return (
    <>
      {state !== 'loaded' && <span className="cover-fallback" aria-hidden="true">{state === 'missing' ? doc.title : ''}</span>}
      {doc.cover_version && state !== 'missing' && (
        <img
          key={doc.cover_version}
          src={coverUrl(doc)}
          alt=""
          draggable={false}
          decoding="async"
          loading={eager ? 'eager' : 'lazy'}
          data-loaded={state === 'loaded'}
          onLoad={() => setState('loaded')}
          onError={() => setState('missing')}
        />
      )}
    </>
  )
}
