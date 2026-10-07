// Every toast the meter sends, decided in one place from one snapshot, so the rules (once each,
// never mid-turn for the person, never to an empty desk for the cache) are written once and tested.
import { clock, kCount } from './format'

export const CHEAP_REWRITE = 20_000 // context tokens under which a cache rewrite is not worth a toast

export type Snapshot = {
  /** A main-thread turn is under way: reminders about the person wait for it to end. */
  running: boolean
  /** Ten minutes without a prompt: nobody is there to act on a cache warning. */
  away: boolean
  /** The last main-thread response's `at`, and how long its cache has left. */
  cache?: { at: number; left: number; warnMs: number }
  context: { tokens?: number; percent?: number; window: number; warnAt?: number }
  /** Windows the current pace runs out before their reset; `key` is the window and its reset. */
  pace: { key: string; label: string; at: string; reset?: string }[]
  /** The stand-up reminder while due; `key` is the sitting and snooze it is for. */
  standup?: { key: string; sat: string }
  /** The late-hour night we are in, and the clock time. */
  night?: { key: string; time: string }
}

// What has been sent already. `nudged` and `night` are shared across sessions through $.store.
export type Memo = { cacheFor: number; ctx: boolean; ctxStrong: boolean; pace: string[]; nudged: string; night: string }
export const EMPTY_MEMO: Memo = { cacheFor: 0, ctx: false, ctxStrong: false, pace: [], nudged: '', night: '' }

export function decideToasts(s: Snapshot, m: Memo): { toasts: string[]; memo: Memo } {
  const toasts: string[] = []
  const memo = { ...m }

  // The cache: worth a toast only when the rewrite costs something (its price is the whole
  // context) and someone is there to send the next message.
  const tokens = s.context.tokens ?? 0
  if (s.cache && s.cache.at !== m.cacheFor && tokens >= CHEAP_REWRITE && !s.away && s.cache.left > 0 && s.cache.left <= s.cache.warnMs) {
    memo.cacheFor = s.cache.at
    toasts.push(`提示缓存还剩 ${clock(s.cache.left)} 过期：现在发下一条消息，否则要重新写入约 ${kCount(tokens)} token`)
  }

  // The context: at the warning size, and again at twice it; each again after it drops well below.
  const { warnAt, window } = s.context
  if (warnAt !== undefined && s.context.tokens !== undefined) {
    const t = s.context.tokens
    if (!m.ctx && t >= warnAt) {
      memo.ctx = true
      toasts.push(`上下文已到 ${kCount(t)}（${s.context.percent ?? '–'}%）：找个合适的节点手动 /compact`)
    } else if (m.ctx && t < warnAt * 0.85) memo.ctx = false
    if (!m.ctxStrong && t >= warnAt * 2 && warnAt * 2 <= window) {
      memo.ctxStrong = true
      toasts.push(`上下文已到 ${kCount(t)}：每轮都在重读这么多，建议现在 /compact，或写交接后 /clear`)
    } else if (m.ctxStrong && t < warnAt * 1.7) memo.ctxStrong = false
  }

  // The rate limits: once per window and reset.
  for (const p of s.pace) {
    if (memo.pace.includes(p.key)) continue
    memo.pace = [...memo.pace, p.key].slice(-8)
    toasts.push(`${p.label}额度按当前速度约 ${p.at} 用完${p.reset ? `（${p.reset} 重置）` : ''}：可以降低 effort 或换小一点的模型`)
  }

  // The person: never in the middle of a turn.
  if (!s.running) {
    if (s.standup && s.standup.key !== m.nudged) {
      memo.nudged = s.standup.key
      toasts.push(`已经连续坐了 ${s.standup.sat}，起来活动 3 分钟吧`)
    }
    if (s.night && s.night.key !== m.night) {
      memo.night = s.night.key
      toasts.push(`已经 ${s.night.time} 了：收个尾，早点休息`)
    }
  }
  return { toasts, memo }
}
