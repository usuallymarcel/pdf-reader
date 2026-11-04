import { FileUp } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useUploads } from './store'

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

/** Full-page drop target and clipboard paste. Active on every shell route, never in the reader. */
export function DropZone({ maxUploadMb }: { maxUploadMb: number }) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setActive(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setActive(false)
      useUploads.getState().add([...(e.dataTransfer?.files ?? [])], maxUploadMb)
    }
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length === 0) return
      e.preventDefault()
      useUploads.getState().add(files, maxUploadMb)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [maxUploadMb])

  if (!active) return null
  return (
    <div className="drop-target" aria-hidden="true">
      <div>
        <FileUp size={32} strokeWidth={1.5} />
        <p>Drop to add to your library</p>
      </div>
    </div>
  )
}
