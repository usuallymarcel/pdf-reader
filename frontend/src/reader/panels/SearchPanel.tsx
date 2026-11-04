import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '../../api/client'
import { Sheet } from '../../ui/primitives'
import { snippetParts } from '../look'

export function SearchPanel({ docId, onJump, onClose }: { docId: string; onJump: (page: number) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), 220)
    return () => window.clearTimeout(t)
  }, [text])
  const hits = useQuery({
    queryKey: ['search', docId, query],
    queryFn: () => api.search(query, docId, 80),
    enabled: query.length >= 2,
    staleTime: 60_000,
  })
  return (
    <Sheet title="Search in book" onClose={onClose}>
      <label className="search-field">
        <Search size={18} aria-hidden />
        <span className="sr-only">Search text</span>
        <input ref={input} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Find text" enterKeyHint="search" />
      </label>
      {hits.isError && <p className="panel-empty">Search is not available right now.</p>}
      {hits.data && !hits.data.length && <p className="panel-empty">Nothing found.</p>}
      {hits.data && (
        <ul className="search-hits">
          {hits.data.map((h, i) => (
            <li key={`${h.page}-${i}`}>
              <button type="button" onClick={() => onJump(h.page)}>
                <span className="search-page">{h.page}</span>
                <span className="search-snippet">
                  {snippetParts(h.snippet).map((p, k) => (p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
