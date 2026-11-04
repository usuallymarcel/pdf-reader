import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import type { Stats } from '../api/types'
import { useOnline } from './session'

function duration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 && hours < 100 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

const dayLabel = (date: string, style: 'short' | 'long' = 'short') =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: style === 'short' ? 'short' : 'long', timeZone: 'UTC' })

/** A round number of minutes just above the busiest day, so the top tick reads cleanly. */
function niceMax(seconds: number) {
  const minutes = seconds / 60
  const step = [10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].find((s) => s >= minutes) ?? 1440
  return step * 60
}

function DailyChart({ days }: { days: Stats['daily_seconds'] }) {
  const [active, setActive] = useState<number | null>(null)
  const max = niceMax(Math.max(...days.map((d) => d.seconds), 1))
  const focus = active === null ? null : days[active]
  const first = days[0]
  const last = days.at(-1)
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">Last 30 days</span>
        <span className="chart-readout" aria-live="polite">{focus ? `${dayLabel(focus.date, 'long')}: ${duration(focus.seconds)}` : ''}</span>
      </figcaption>
      <div className="chart-plot" onPointerLeave={() => setActive(null)}>
        <span className="chart-tick chart-tick-top" aria-hidden="true">{duration(max)}</span>
        <div className="chart-bars" aria-hidden="true">
          {days.map((day, i) => (
            <div key={day.date} className="chart-slot" data-active={active === i} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
              {day.seconds > 0 && <span style={{ height: `${Math.max(2, (day.seconds / max) * 100)}%` }} />}
            </div>
          ))}
        </div>
      </div>
      <div className="chart-axis" aria-hidden="true">
        <span>{first && dayLabel(first.date)}</span>
        <span>{last && dayLabel(last.date)}</span>
      </div>
      <details className="chart-table">
        <summary>View as table</summary>
        <table>
          <thead><tr><th scope="col">Date</th><th scope="col">Time read</th></tr></thead>
          <tbody>
            {days.filter((d) => d.seconds > 0).map((d) => <tr key={d.date}><td>{dayLabel(d.date, 'long')}</td><td>{duration(d.seconds)}</td></tr>)}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

export function StatsPage() {
  const online = useOnline()
  const { data, isPending } = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const tiles = data && [
    ['Time read', duration(data.seconds_read)],
    ['Pages read', data.pages_read.toLocaleString()],
    ['Books finished', data.finished.toLocaleString()],
    ['Day streak', data.streak_days.toLocaleString()],
  ]
  return (
    <div className="page stats">
      <header className="page-head"><h1>Stats</h1></header>
      {isPending && <div className="tiles" aria-hidden="true">{[0, 1, 2, 3].map((i) => <div key={i} className="tile skeleton-tile" />)}</div>}
      {!isPending && !data && <p className="muted">{online ? 'Stats could not be loaded.' : 'Stats need a connection.'}</p>}
      {tiles && (
        <>
          <dl className="tiles">
            {tiles.map(([label, value]) => <div key={label} className="tile"><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {data.daily_seconds.length > 0 && <DailyChart days={data.daily_seconds} />}
        </>
      )}
    </div>
  )
}
