import { useQuery } from '@tanstack/react-query'
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'

const DEBOUNCE_MS = 300
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }

const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name: string) => ENTITIES[name] ?? '')

/** Renders the server's escaped snippet as text nodes; only its <mark> pairs become elements. */
export function Snippet({ html }: { html: string }): ReactNode {
  const parts = html.split(/(<mark>.*?<\/mark>)/g)
  return parts.map((part, i) => {
    const marked = /^<mark>(.*)<\/mark>$/.exec(part)
    return <Fragment key={i}>{marked ? <mark>{decode(marked[1] ?? '')}</mark> : decode(part)}</Fragment>
  })
}

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [value])
  return debounced
}

export function InsideSearch({ query }: { query: string }) {
  const term = useDebounced(query.trim())
  const { data: hits, isFetching } = useQuery({
    queryKey: ['search', term],
    queryFn: () => api.search(term),
    enabled: term.length >= 2,
    staleTime: 30_000,
  })
  if (term.length < 2) return null
  if (!hits?.length) {
    return isFetching ? <p className="inside-empty">Searching inside books</p> : <p className="inside-empty">No matches inside your books</p>
  }
  return (
    <section className="inside" aria-labelledby="inside-title">
      <h2 id="inside-title" className="section-title">Inside books</h2>
      <ul>
        {hits.map((hit) => (
          <li key={`${hit.document_id}:${hit.page}`}>
            <Link to={`/read/${hit.document_id}?page=${hit.page}`} viewTransition className="inside-hit">
              <span className="inside-meta"><span>{hit.title}</span><span>Page {hit.page}</span></span>
              <span className="inside-snippet"><Snippet html={hit.snippet} /></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
