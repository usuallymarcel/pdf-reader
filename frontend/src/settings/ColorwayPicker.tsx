import { Palette } from 'lucide-react'
import { ColorField } from '../ui/primitives'
import { contrast } from './color'
import { COLORWAYS, resolveColors } from './colorways'
import type { CustomColors, PageBackground } from './schema'

const COMFORTABLE_CONTRAST = 4.5

/** Page and ink for reading. `showText` is off for image modes, where only the page shows. */
export function ColorwayPicker({ value, custom, showText, onChange }: {
  value: PageBackground
  custom: CustomColors
  showText: boolean
  onChange: (patch: { background?: PageBackground; customColors?: Partial<CustomColors> }) => void
}) {
  const current = resolveColors({ background: value, customColors: custom })
  const isCustom = value === 'custom'
  return (
    <>
      <div className="colorways" role="radiogroup" aria-label="Reading colors">
        {COLORWAYS.map((c) => (
          <button key={c.value} type="button" role="radio" aria-checked={value === c.value} aria-label={c.label} title={c.label}
            style={{ background: c.bg, color: c.fg }} onClick={() => onChange({ background: c.value })}>Aa</button>
        ))}
        <button type="button" role="radio" aria-checked={isCustom} aria-label="Custom colors" title="Custom"
          style={isCustom ? { background: current.bg, color: current.fg } : undefined}
          // Start from whatever is showing, so the first tweak is a small one.
          onClick={() => onChange({ background: 'custom', customColors: { bg: current.bg, fg: current.fg } })}>
          <Palette size={17} aria-hidden="true" />
        </button>
      </div>
      {isCustom && (
        <div className="color-fields">
          <ColorField label="Background" value={current.bg} onChange={(bg) => onChange({ customColors: { bg } })} />
          {showText && <ColorField label="Text" value={current.fg} onChange={(fg) => onChange({ customColors: { fg } })} />}
        </div>
      )}
      {isCustom && showText && contrast(current.bg, current.fg) < COMFORTABLE_CONTRAST && (
        <p className="hint" role="status">These two are close together, so text may be hard to read.</p>
      )}
    </>
  )
}
