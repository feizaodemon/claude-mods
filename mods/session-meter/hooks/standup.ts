// Stand-up reminder: how long the person has sat at Claude Code, kept in $.store so every open
// session shares one clock. Ten minutes with no prompt counts as a break and starts it over.
import type { Chip } from './format'

const MINUTE = 60_000
export const IDLE_RESET_MS = 10 * MINUTE // no prompt this long: they were away, the next prompt restarts the clock
export const SNOOZE_MS = 10 * MINUTE
const SOON_MS = 10 * MINUTE // the chip turns yellow this long before the reminder

// `day` / `breaks`: the local date and how many breaks were taken on it, for the encouragement line.
export type Standup = { since: number; lastActiveAt: number; snoozeUntil: number; nudged: string; day: string; breaks: number }
export type Phase = 'away' | 'ok' | 'soon' | 'due'

/** The local calendar date, `YYYY-MM-DD`. */
export function dayOf(now: number): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const fresh = (now: number): Standup => ({ since: now, lastActiveAt: now, snoozeUntil: 0, nudged: '', day: dayOf(now), breaks: 0 })

/** A stored value as a Standup; anything else (nothing stored yet, an older shape) starts fresh. */
export function parse(value: unknown, now: number): Standup {
  const v = value as Partial<Standup> | undefined
  const isOk = v && typeof v.since === 'number' && typeof v.lastActiveAt === 'number'
  if (!isOk) return fresh(now)
  return { since: v.since!, lastActiveAt: v.lastActiveAt!, snoozeUntil: v.snoozeUntil ?? 0, nudged: v.nudged ?? '', day: v.day ?? dayOf(now), breaks: v.breaks ?? 0 }
}

/** A new sitting after a break, counting the break toward today. */
function afterBreak(s: Standup, now: number): Standup {
  const today = dayOf(now)
  return { ...fresh(now), day: today, breaks: (s.day === today ? s.breaks : 0) + 1 }
}

/** A prompt from the person: after a break (ten minutes without one) the clock starts over. */
export function onActivity(s: Standup, now: number): Standup {
  return now - s.lastActiveAt >= IDLE_RESET_MS ? afterBreak(s, now) : { ...s, lastActiveAt: now }
}

/** Breaks taken today; a count from an earlier day is none. */
export const breaksToday = (s: Standup, now: number) => (s.day === dayOf(now) ? s.breaks : 0)

export const done = (s: Standup, now: number): Standup => afterBreak(s, now)
export const snooze = (s: Standup, now: number): Standup => ({ ...s, snoozeUntil: now + SNOOZE_MS })

export function phase(s: Standup, now: number, intervalMs: number): { phase: Phase; sat: number } {
  const sat = Math.max(0, now - s.since)
  if (now - s.lastActiveAt >= IDLE_RESET_MS) return { phase: 'away', sat }
  if (sat >= intervalMs && now >= s.snoozeUntil) return { phase: 'due', sat }
  if (sat >= intervalMs - SOON_MS) return { phase: 'soon', sat } // also while snoozed
  return { phase: 'ok', sat }
}

/** The one reminder per sitting (and per snooze) the toast goes out for. */
export const nudgeKey = (s: Standup) => `${s.since}:${s.snoozeUntil}`

export function duration(ms: number): string {
  const m = Math.floor(ms / MINUTE)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function standupChip(p: { phase: Phase; sat: number }): Chip | undefined {
  const d = duration(p.sat)
  if (p.phase === 'away') return undefined
  if (p.phase === 'due') return { key: 'standup', text: `起来活动下！已坐 ${d}`, short: `起来！${d}`, color: 'red', rank: 1 }
  if (p.phase === 'soon') return { key: 'standup', text: `已坐 ${d} 快该起来了`, short: `坐${d}`, color: 'yellow', rank: 3 }
  return { key: 'standup', text: `已坐 ${d}`, short: `坐${d}`, dim: true, rank: 7 }
}

// Two frames of an 8×6 pixel figure: arms down, then stretching up. '#' is a lit pixel.
const FRAMES: readonly (readonly string[])[] = [
  ['...##...', '...##...', '..####..', '.#.##.#.', '..#..#..', '..#..#..'],
  ['.#.##.#.', '.#.##.#.', '..####..', '...##...', '..#..#..', '.#....#.'],
]

/** Pixel rows two at a time as half blocks: one text row shows two pixel rows. */
export function halfBlocks(grid: readonly string[]): string[] {
  const out: string[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? ''
    const bottom = grid[y + 1] ?? ''
    let row = ''
    for (let x = 0; x < Math.max(top.length, bottom.length); x++) {
      const t = top[x] === '#'
      const b = bottom[x] === '#'
      row += t && b ? '█' : t ? '▀' : b ? '▄' : ' '
    }
    out.push(row)
  }
  return out
}

export const figure = (frame: number): string[] => halfBlocks(FRAMES[frame % FRAMES.length] ?? FRAMES[0]!)

// One suggestion per sitting, in turn: the same sentence every hour soon goes unread.
const TIPS = [
  '站起来走两步，伸个懒腰，3 分钟就够。',
  '看向 6 米外的地方 20 秒，让眼睛放松。',
  '去倒杯水，顺便走动一下。',
  '转转脖子、耸耸肩，放松肩颈。',
  '站起来做 10 个深蹲，或者原地踏步一分钟。',
] as const

/** The words beside the figure, so the picture is never the only message. */
export function advice(s: Standup, sat: number, now: number): string[] {
  const n = breaksToday(s, now)
  return [
    `你已经连续坐了 ${duration(sat)}。`,
    TIPS[Math.floor(s.since / MINUTE) % TIPS.length] ?? TIPS[0],
    ...(n > 0 ? [`今天已经活动了 ${n} 次，继续保持。`] : []),
  ]
}

/**
 * The night a late-hour reminder belongs to (the evening's date), or undefined outside the late
 * hours: from `hour` until 5 in the morning. `hour` 0 turns it off.
 */
export function lateNight(now: number, hour: number): string | undefined {
  if (hour <= 0 || hour > 23) return undefined
  const h = new Date(now).getHours()
  if (h >= hour) return dayOf(now)
  return h < 5 ? dayOf(now - 24 * 3600_000) : undefined
}
