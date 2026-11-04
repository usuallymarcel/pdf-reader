import { Link } from 'react-router-dom'
import type { Doc } from '../api/types'
import { Cover } from './Cover'
import { progressOf, volumeLabel } from './data'

export function ContinueShelf({ docs }: { docs: Doc[] }) {
  if (docs.length === 0) return null
  return (
    <section className="continue" aria-labelledby="continue-title">
      <h2 id="continue-title" className="section-title">Continue reading</h2>
      <ul className="continue-rail">
        {docs.map((doc) => (
          <li key={doc.id}>
            <Link to={`/read/${doc.id}`} viewTransition className="continue-card" aria-label={`Continue ${doc.title}, page ${doc.state.page} of ${doc.page_count}`}>
              <span className="cover">
                <Cover doc={doc} eager />
                <span className="cover-progress"><span style={{ transform: `scaleX(${progressOf(doc)})` }} /></span>
              </span>
              <span className="continue-text">
                <span className="card-title">{doc.series && doc.volume !== null ? doc.series : doc.title}</span>
                <span className="card-sub">{volumeLabel(doc) ?? 'Page'} {volumeLabel(doc) ? '·' : ''} {volumeLabel(doc) ? `${doc.state.page} / ${doc.page_count}` : `${doc.state.page} of ${doc.page_count}`}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
