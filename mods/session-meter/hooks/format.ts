import type { ModelUsage, SessionUsage } from 'claude-code'

import type { Chip, LastStep, Reading } from '../types'

export const WARN_MS = 60_000 // the cache line turns to a warning this long before expiry

export function ttlMs(option: unknown): number {
  return option === '5m' ? 5 * 60_000 : 60 * 60_000
}

// The TTL a cache write gets now and why: this plugin's `cacheTtl` option when it is `1h` or `5m`,
// else inferred from the plan. A subscription gets 1h within plan usage and 5m on usage credits,
// and a rate-limit window at 100% stands for the latter. The mod reads nothing from the
// environment or settings.json: whoever fixes the TTL there sets `cacheTtl` to match.
export function ttlFor(option: unknown, rateLimits: readonly { percentUsed: number }[]): { ttl: number; source: string } {
  if (option === '1h' || option === '5m') return { ttl: ttlMs(option), source: '插件设置' }
  return rateLimits.some(r => r.percentUsed >= 100)
    ? { ttl: ttlMs('5m'), source: '推断：额度已用满，按超额 5 分钟' }
    : { ttl: ttlMs('1h'), source: '推断：额度内 1 小时' }
}

// Share of the prompt the cache served: read / (uncached + read + written).
export function hitPercent(u: ModelUsage): number | null {
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null
}

export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// A local clock time, with its weekday when it is not today (a weekly window resets days away),
// or its month and day when it is six days or more off. `now` absent: the time alone.
export function hhmm(iso: string | undefined, now?: number): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (now === undefined || d.toDateString() === new Date(now).toDateString()) return time
  return Math.abs(d.getTime() - now) < 6 * 24 * 3600_000 ? `${WEEKDAY[d.getDay()]}${time}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

export const hhmmAt = (ms: number, now?: number) => hhmm(new Date(ms).toISOString(), now)

export const WINDOW_LABEL: Record<string, string> = { five_hour: '5小时', seven_day: '7天', spend_limit: '额度' }

// The context forecast (from token-weather): icon, word and color by how full the window is.
const FORECAST = [
  { upTo: 25, icon: '☀', word: '晴', color: 'yellow' },
  { upTo: 50, icon: '☁', word: '多云', color: 'cyan' },
  { upTo: 75, icon: '☂', word: '阵雨', color: 'blue' },
  { upTo: 90, icon: '⛈', word: '雷雨', color: 'magenta' },
  { upTo: Infinity, icon: '⚠', word: '该压缩了', color: 'red' },
] as const
export const forecast = (percent: number) => FORECAST.find(f => percent < f.upTo) ?? FORECAST[4]

// The context size the warning fires at: `percent` of the window, capped at `capTokens`. What a
// turn costs and how well the model attends follow the tokens, not the share of the window, so a
// 1M window warns at the cap long before 80% of it. Undefined when both are off.
export function warnTokens(window: number, percent: number, capTokens: number): number | undefined {
  const byShare = percent > 0 ? (window * percent) / 100 : Infinity
  const at = Math.min(byShare, capTokens > 0 ? capTokens : Infinity)
  return Number.isFinite(at) && at > 0 ? at : undefined
}

// The forecast's scale: the warning sits at 80 on it, where the weather turns to storms.
export const forecastPercent = (tokens: number, warnAt: number) => Math.round((tokens / warnAt) * 80)

// How many more turns, at the recent average growth, until the context reaches `target` tokens.
// Only growth counts: a /compact or /clear shrinks the context but says nothing about the pace.
export function turnsLeft(history: readonly Reading[], target: number | undefined): number | undefined {
  const grows = history.slice(-7).flatMap((r, i, a) => (i > 0 && r.tokens > (a[i - 1]?.tokens ?? 0) ? [r.tokens - (a[i - 1]?.tokens ?? 0)] : []))
  const now = history.at(-1)?.tokens
  if (grows.length === 0 || now === undefined || target === undefined) return undefined
  const room = target - now
  if (room <= 0) return undefined
  return Math.ceil(room / (grows.reduce((a, b) => a + b, 0) / grows.length))
}

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 24 * 3600_000 }
const RECENT_MS = 30 * 60_000 // the stretch the recent pace is read over
const RECENT_MIN_MS = 10 * 60_000 // less than this of it says too little

export type Sample = { t: number; pct: number }

// Percent per millisecond over the last half hour of samples, or undefined with under ten minutes
// of them. Zero when nothing was used: at that pace the window never runs out.
export function recentRate(samples: readonly Sample[], now: number): number | undefined {
  const recent = samples.filter(s => s.t >= now - RECENT_MS)
  const first = recent[0]
  const lastOne = recent.at(-1)
  if (!first || !lastOne || lastOne.t - first.t < RECENT_MIN_MS) return undefined
  return Math.max(0, (lastOne.pct - first.pct) / (lastOne.t - first.t))
}

// When a rate-limit window runs out, if that comes before its reset: at the recent pace (`rate`,
// percent per ms) when there is one, else at the window's average pace so far, which needs a
// tenth of the window behind it. Undefined for a window with no known length.
export function exhaustsAt(r: { kind: string; percentUsed: number; resetsAt?: string }, now: number, rate?: number): number | undefined {
  const length = WINDOW_MS[r.kind]
  const reset = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  if (!length || Number.isNaN(reset) || r.percentUsed <= 0 || r.percentUsed >= 100) return undefined
  let at: number
  if (rate !== undefined) {
    if (rate <= 0) return undefined
    at = now + (100 - r.percentUsed) / rate
  } else {
    const elapsed = length - (reset - now)
    if (elapsed < length / 10) return undefined
    at = now + ((100 - r.percentUsed) / r.percentUsed) * elapsed
  }
  return at < reset ? at : undefined
}

// A rate-limit window as a five-cell meter.
export function meter(percent: number, width = 5): string {
  const full = Math.min(width, Math.round((percent / 100) * width))
  return '▰'.repeat(full) + '▱'.repeat(width - full)
}

// Cells a string takes: CJK, fullwidth forms and the weather symbols count two.
export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += /[ᄀ-ᅟ☀-➿⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1
  return n
}

export type { Chip }

export function cacheChip(last: LastStep | null, now: number, ttl: number): Chip {
  if (last === null) return { key: 'cache', text: '❄ 缓存 –', short: '❄ –', dim: true, rank: 2 }
  const left = last.at + ttl - now
  if (left <= 0) return { key: 'cache', text: '❄ 缓存已过期', short: '❄ 过期', color: 'red', rank: 2 }
  const isSoon = left <= WARN_MS
  return { key: 'cache', text: `❄ 缓存 ${clock(left)}${isSoon ? ' 快过期' : ''}`, short: `❄ ${clock(left)}`, color: isSoon ? 'yellow' : 'cyan', rank: 2 }
}

// What the chips are judged against: the context warning's size in tokens, and each rate-limit
// window's recent pace (percent per ms) where one is known.
export type Judge = { warnPercent: number; warnCapTokens: number; rates?: Readonly<Record<string, number | undefined>> }
export const DEFAULT_JUDGE: Judge = { warnPercent: 80, warnCapTokens: 200_000 }

// Every part the engine has a figure for, in the order the band shows them.
export function chips(last: LastStep | null, now: number, ttl: number, usage: SessionUsage, history: readonly Reading[] = [], judge: Judge = DEFAULT_JUDGE): Chip[] {
  const out: Chip[] = []
  const { context, rateLimits, cost } = usage
  const warnAt = context.window ? warnTokens(context.window, judge.warnPercent, judge.warnCapTokens) : undefined
  if (context.percent !== undefined && context.tokens !== undefined) {
    const f = forecast(warnAt ? forecastPercent(context.tokens, warnAt) : context.percent)
    out.push({
      key: 'context', rank: 1, color: f.color,
      text: `${f.icon} ${f.word} 上下文 ${context.percent}% ${kTokens(context.tokens)}/${kTokens(context.window)}`,
      short: `${f.icon} ${kTokens(context.tokens)}`,
    })
  }
  out.push(cacheChip(last, now, ttl))
  for (const r of rateLimits) {
    const pct = Math.round(r.percentUsed)
    const label = WINDOW_LABEL[r.kind] ?? r.kind
    const reset = hhmm(r.resetsAt, now)
    const runsOut = exhaustsAt(r, now, judge.rates?.[r.kind])
    out.push({
      key: `limit:${r.kind}`, rank: 3, color: pct >= 90 ? 'red' : pct >= 70 || runsOut ? 'yellow' : undefined,
      text: `${label} ${meter(pct)} ${pct}%${runsOut ? ` 预计${hhmmAt(runsOut, now)}用完` : ''}${reset ? ` ${reset}重置` : ''}`,
      short: `${label} ${pct}%${runsOut ? '!' : ''}`,
    })
  }
  // Turns until the context warning, in place of a sparkline that took reading.
  const left = turnsLeft(history, warnAt)
  if (left !== undefined && warnAt !== undefined) out.push({ key: 'turns', text: `约 ${left} 轮到 ${kTokens(warnAt)}`, short: `${left}轮`, color: left <= 3 ? 'yellow' : undefined, dim: left > 3, rank: 5 })
  // The hit rate needs no action while the cache works; it shows only when it looks broken.
  if (last?.hitPercent != null && last.hitPercent < 70) out.push({ key: 'hit', text: `命中 ${last.hitPercent}% 缓存可能失效`, short: `命中${last.hitPercent}%`, color: 'yellow', rank: 4 })
  // A subscription's figure in API prices: informative, never a reason to act, so last to go.
  if (cost) out.push({ key: 'cost', text: `$${cost.usd.toFixed(2)}`, short: `$${cost.usd.toFixed(2)}`, dim: true, rank: 8 })
  return out
}

export const SEP = ' │ '

// Fits the chips into at most `maxRows` rows of `columns` cells: full text where everything fits,
// the short forms where it does not, then the lowest-ranked chips dropped until it fits.
export function layout(all: readonly Chip[], columns: number, maxRows = 2): { chip: Chip; label: string }[][] {
  const pack = (items: { chip: Chip; label: string }[]) => {
    const rows: { chip: Chip; label: string }[][] = []
    let used = 0
    for (const it of items) {
      const w = cells(it.label)
      const row = rows.at(-1)
      if (row && used + cells(SEP) + w <= columns) {
        row.push(it)
        used += cells(SEP) + w
      } else {
        rows.push([it])
        used = w
      }
    }
    return rows
  }
  let kept = [...all]
  for (;;) {
    for (const useShort of [false, true]) {
      const rows = pack(kept.map(chip => ({ chip, label: useShort ? chip.short : chip.text })))
      if (rows.length <= maxRows) return rows
    }
    if (kept.length <= 1) return pack(kept.map(chip => ({ chip, label: chip.short })))
    const worst = Math.max(...kept.map(c => c.rank))
    const at = kept.map(c => c.rank).lastIndexOf(worst)
    kept = kept.filter((_, i) => i !== at)
  }
}

// The whole meter as one plain line: /meter's first line, and what decides a redraw.
export function line(last: LastStep | null, now: number, ttl: number, usage: SessionUsage, history: readonly Reading[] = [], judge: Judge = DEFAULT_JUDGE): string {
  return chips(last, now, ttl, usage, history, judge).map(c => c.text).join(SEP)
}

// /meter's cache line. A step stored by an older version and kept across a reload has no TTL of its
// own: it counts down 1h and names no source.
export function cacheDetail(step: LastStep | null, now: number): string {
  if (!step) return '提示缓存：主线程还没有响应'
  const ttl = step.ttl ?? ttlMs('1h')
  const source = step.ttlSource ? `（${step.ttlSource}）` : ''
  const left = step.at + ttl - now
  return `提示缓存：上次主线程响应在 ${clock(now - step.at)} 前，TTL ${ttl / 60_000} 分钟${source}，${left > 0 ? `还剩 ${clock(left)}` : '已过期'}；命中率 ${step.hitPercent ?? '–'}%`
}
