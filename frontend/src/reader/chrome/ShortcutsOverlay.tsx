import { Sheet } from '../../ui/primitives'
import { SHORTCUTS } from '../input/keyboard'

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keyboard shortcuts" onClose={onClose}>
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{what}</dd></div>
        ))}
      </dl>
    </Sheet>
  )
}
