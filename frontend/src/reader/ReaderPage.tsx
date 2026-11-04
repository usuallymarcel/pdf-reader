import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../api/client'
import { Reader } from './Reader'
import './reader.css'

function Message({ title, detail, busy }: { title: string; detail?: string; busy?: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="reader-message">
      <button type="button" className="icon-btn" aria-label="Back to library" onClick={() => navigate('/')}><ArrowLeft size={22} /></button>
      <div>
        {busy && <Loader2 className="reader-spin" size={24} aria-hidden />}
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  )
}

function Loader({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['document', id],
    queryFn: () => api.document(id),
    refetchOnWindowFocus: 'always',
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 2500 : false),
  })
  const doc = query.data
  if (query.isError && !doc) return <Message title="This book could not be opened" detail={query.error.message} />
  if (!doc) return <div className="reader-boot" role="status" aria-label="Opening book"><Loader2 className="reader-spin" size={24} /></div>
  if (doc.status === 'processing') return <Message title="Preparing this book" detail="It will open by itself in a moment." busy />
  if (doc.status === 'failed') return <Message title="This book could not be processed" detail={doc.error ?? undefined} />
  return <Reader doc={doc} />
}

export default function ReaderPage() {
  const { id } = useParams()
  return id ? <Loader key={id} id={id} /> : null
}
