import { useEffect, useRef, type KeyboardEvent } from 'react'

const CARD_SELECTOR = '[data-card-link]'

function neighbour(cards: HTMLElement[], from: HTMLElement, key: string) {
  const index = cards.indexOf(from)
  if (key === 'ArrowRight') return cards[index + 1]
  if (key === 'ArrowLeft') return cards[index - 1]
  if (key === 'Home') return cards[0]
  if (key === 'End') return cards.at(-1)
  const here = from.getBoundingClientRect()
  const down = key === 'ArrowDown'
  const rows = down ? cards.slice(index + 1) : cards.slice(0, index).reverse()
  const nextRowTop = rows.map((c) => c.getBoundingClientRect().top).find((top) => (down ? top > here.top + 4 : top < here.top - 4))
  if (nextRowTop === undefined) return undefined
  return rows
    .filter((c) => Math.abs(c.getBoundingClientRect().top - nextRowTop) < 4)
    .sort((a, b) => Math.abs(a.getBoundingClientRect().left - here.left) - Math.abs(b.getBoundingClientRect().left - here.left))[0]
}

/** One tab stop for the whole grid, arrow keys inside it. */
export function useGridKeys<T extends HTMLElement>(itemCount: number) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const grid = ref.current
    if (!grid) return
    const cards = [...grid.querySelectorAll<HTMLElement>(CARD_SELECTOR)]
    const stop = cards.find((c) => c.tabIndex === 0 && c.dataset.rover === 'on') ?? cards[0]
    for (const card of cards) card.tabIndex = card === stop ? 0 : -1
    if (stop) stop.dataset.rover = 'on'
  }, [itemCount])

  const onKeyDown = (e: KeyboardEvent<T>) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    const from = (e.target as HTMLElement).closest<HTMLElement>(CARD_SELECTOR)
    const grid = ref.current
    if (!from || !grid) return
    const next = neighbour([...grid.querySelectorAll<HTMLElement>(CARD_SELECTOR)], from, e.key)
    e.preventDefault()
    if (!next) return
    from.tabIndex = -1
    delete from.dataset.rover
    next.tabIndex = 0
    next.dataset.rover = 'on'
    next.focus()
  }

  return { ref, onKeyDown }
}
