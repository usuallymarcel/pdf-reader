import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { Doc } from '../../api/types'

export function EndCard({ doc, next, onNext, onBack }: {
  doc: Pick<Doc, 'title'>
  next: Doc | null
  background: string
  onNext: () => void
  onBack: () => void
}) {
  return (
    <div className="endcard" onPointerDown={(e) => { if ((e.target as Element).closest('button')) e.stopPropagation() }}>
      <span className="endcard-mark"><Check size={20} aria-hidden /></span>
      <h2>Finished</h2>
      <p>{doc.title}</p>
      <div className="endcard-actions">
        {next && (
          <button type="button" className="btn btn-primary" onClick={onNext}>
            Volume {next.volume}<ArrowRight size={18} aria-hidden />
          </button>
        )}
        <button type="button" className="btn" onClick={onBack}><ArrowLeft size={18} aria-hidden />Library</button>
      </div>
    </div>
  )
}
