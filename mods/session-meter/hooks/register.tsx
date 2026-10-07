// session-meter: a band above the prompt with the context forecast and turns left, the prompt cache
// countdown, the rate-limit windows and their pace, a cache-hit warning, the session cost, and
// stand-up / late-night reminders, fitted to the band's width. /meter prints the figures in full.
//
// Once a second the tick reads the engine, works out what the band shows (a View in $.state, which
// redraws its readers when it changes) and which toasts are due (alerts.ts). Drawing only reads.
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { View } from '../types'
import type { Memo, Snapshot } from './alerts'
import { EMPTY_MEMO, decideToasts } from './alerts'
import type { Judge, Sample } from './format'
import { SEP, WARN_MS, WINDOW_LABEL, cacheDetail, chips, exhaustsAt, hhmm, hhmmAt, hitPercent, kTokens, layout, recentRate, ttlFor, ttlMs, warnTokens } from './format'
import type { Standup } from './standup'
import { IDLE_RESET_MS, advice, done, duration, figure, lateNight, nudgeKey, onActivity, parse, phase, snooze, standupChip } from './standup'

const HISTORY = 12
const STANDUP_KEY = 'standup' // in $.store: one sitting clock shared by every session
const BEDTIME_KEY = 'bedtime' // in $.store: the night the late-hour reminder last went out for
const STORE_SYNC_MS = 15_000 // how stale the stand-up clock may be before it is read again
const SAMPLE_EVERY_MS = 60_000 // how often a rate-limit reading is kept for the recent pace
const RUNNING_MAX_MS = 30 * 60_000 // a turn that never reported its end stops counting as running
const FAILING_AFTER = 3 // ticks failed in a row before the band says its figures may be stale

// This mod's values in $.state, each read and written with $.state.get / $.state.set.
const LAST = { plugin: 'session-meter', key: 'last' } as const
const READINGS = { plugin: 'session-meter', key: 'readings' } as const
const VIEW = { plugin: 'session-meter', key: 'view' } as const

// The options; set again on each (re)load.
const cfg = { ttlOption: 'auto' as unknown, ctxWarn: 80, ctxWarnTokens: 200_000, standupMs: 60 * 60_000, bedtimeHour: 23 }

// What this module remembers between ticks; a reload starts it over.
// runningSince: when the main conversation's current turn began (0: idle); standup / standupReadAt:
// this session's copy of the shared clock and when it was read; samples: each window's readings for
// the recent pace, kept for the reset they belong to; nightChecked: the night whose shared flag was
// read; viewKey: the View last written; failures / lastError: the tick's failures in a row.
const fresh = () => ({
  memo: { ...EMPTY_MEMO } as Memo,
  runningSince: 0,
  standup: undefined as Standup | undefined,
  standupReadAt: 0,
  samples: {} as Record<string, { resetsAt: string; list: Sample[] }>,
  sampledAt: 0,
  nightChecked: '',
  viewKey: '',
  failures: 0,
  lastError: '',
})
let mem = fresh()

const isRunning = (now: number) => mem.runningSince > 0 && now - mem.runningSince < RUNNING_MAX_MS

// Keeps a reading of each window once a minute; a new reset starts its list over.
function sample(now: number, usage: SessionUsage) {
  if (now - mem.sampledAt < SAMPLE_EVERY_MS) return
  mem.sampledAt = now
  for (const r of usage.rateLimits) {
    const held = mem.samples[r.kind]
    const list = held && held.resetsAt === (r.resetsAt ?? '') ? held.list : []
    mem.samples[r.kind] = { resetsAt: r.resetsAt ?? '', list: [...list, { t: now, pct: r.percentUsed }].slice(-40) }
  }
}

function judge(now: number): Judge {
  const rates: Record<string, number | undefined> = {}
  for (const [kind, held] of Object.entries(mem.samples)) rates[kind] = recentRate(held.list, now)
  return { warnPercent: cfg.ctxWarn, warnCapTokens: cfg.ctxWarnTokens, rates }
}

// Read from $.store at most every 15 s: the band redraws every second, the clock moves by minutes.
async function loadStandup($: EngineInterface, now: number): Promise<Standup> {
  if (mem.standup && now - mem.standupReadAt < STORE_SYNC_MS) return mem.standup
  mem.standup = parse(await $.store.get(STANDUP_KEY).catch(() => undefined), now)
  mem.standupReadAt = now
  return mem.standup
}

async function saveStandup($: EngineInterface, s: Standup) {
  mem.standup = s
  await $.store.set(STANDUP_KEY, s).catch(() => {}) // the clock still runs in this session
}

// One second of the meter: the View the band draws, and the toasts now due.
async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const step = (await $.state.get(LAST)).value ?? null
  const usage = await $.session.usage()
  const ttl = step?.ttl ?? ttlMs('1h')
  sample(now, usage)
  const j = judge(now)

  const s = await loadStandup($, now)
  const p = cfg.standupMs > 0 ? phase(s, now, cfg.standupMs) : undefined
  const upChip = p ? standupChip(p) : undefined
  const isDue = p?.phase === 'due'

  const next: View = {
    chips: [...chips(step, now, ttl, usage, (await $.state.get(READINGS)).value ?? [], j), ...(upChip ? [upChip] : [])],
    ...(isDue && p ? { standup: { tips: advice(s, p.sat, now), frame: Math.floor(now / 1000) % 2 } } : {}),
  }
  const key = JSON.stringify(next)
  if (key !== mem.viewKey) {
    mem.viewKey = key
    await $.state.set(VIEW, next)
  }

  // The shared flags the toasts depend on: the sitting reminded, the night reminded.
  const night = lateNight(now, cfg.bedtimeHour)
  if (night && mem.nightChecked !== night) {
    mem.nightChecked = night
    const sent = await $.store.get(BEDTIME_KEY).catch(() => night) // unreadable: count it as sent
    mem.memo.night = typeof sent === 'string' ? sent : ''
  }
  mem.memo.nudged = s.nudged

  const snap: Snapshot = {
    running: isRunning(now),
    away: now - s.lastActiveAt >= IDLE_RESET_MS,
    cache: step ? { at: step.at, left: step.at + ttl - now, warnMs: WARN_MS } : undefined,
    context: { tokens: usage.context.tokens, percent: usage.context.percent, window: usage.context.window, warnAt: warnTokens(usage.context.window, cfg.ctxWarn, cfg.ctxWarnTokens) },
    pace: usage.rateLimits.flatMap(r => {
      const at = r.percentUsed >= 50 ? exhaustsAt(r, now, j.rates?.[r.kind]) : undefined
      return at === undefined ? [] : [{ key: `${r.kind}:${r.resetsAt ?? ''}`, label: WINDOW_LABEL[r.kind] ?? r.kind, at: hhmmAt(at, now) ?? '', reset: hhmm(r.resetsAt, now) ?? undefined }]
    }),
    standup: isDue && p ? { key: nudgeKey(s), sat: duration(p.sat) } : undefined,
    night: night ? { key: night, time: hhmmAt(now) ?? '' } : undefined,
  }
  const { toasts, memo } = decideToasts(snap, mem.memo)
  if (memo.nudged !== mem.memo.nudged) await saveStandup($, { ...s, nudged: memo.nudged })
  if (memo.night !== mem.memo.night) await $.store.set(BEDTIME_KEY, memo.night).catch(() => {})
  mem.memo = memo
  for (const t of toasts) $.ui.toast(t)
}

// The tick, with its failures counted rather than swallowed: after a few in a row the band says so
// (its figures may be stale) and /meter names the last error.
async function refresh($: EngineInterface) {
  try {
    await tick($)
    if (mem.failures >= FAILING_AFTER) await setFailing($, false)
    mem.failures = 0
  } catch (error) {
    mem.failures += 1
    mem.lastError = error instanceof Error ? error.message : String(error)
    if (mem.failures === FAILING_AFTER) await setFailing($, true).catch(() => {})
  }
}

async function setFailing($: EngineInterface, failing: boolean) {
  const v = (await $.state.get(VIEW)).value
  if (v) await $.state.set(VIEW, { ...v, failing })
}

// A press on the stand-up panel's buttons: done or snooze the shared clock, then redraw.
async function pressStandup($: EngineInterface, change: (s: Standup, t: number) => Standup) {
  const t = await $.clock.now()
  await saveStandup($, change(await loadStandup($, t), t))
  await refresh($)
}

const FAILING_CHIP = { key: 'failing', text: '⚠ meter 数据可能过期（/meter 看原因）', short: '⚠ meter', color: 'yellow', rank: 2 }

export const register: Register = (on, options) => {
  cfg.ttlOption = options.cacheTtl
  cfg.ctxWarn = typeof options.contextWarnPercent === 'number' ? options.contextWarnPercent : 80
  cfg.ctxWarnTokens = typeof options.contextWarnTokens === 'number' ? options.contextWarnTokens : 200_000
  cfg.standupMs = (typeof options.standupMinutes === 'number' ? options.standupMinutes : 60) * 60_000
  cfg.bedtimeHour = typeof options.bedtimeHour === 'number' ? options.bedtimeHour : 23
  mem = fresh()

  // Any prompt starts a main-thread turn; one the person sent is also the sign they are at the desk.
  // (turn.start cannot mark it: it does not say whose turn, and a subagent's would never be cleared.)
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    mem.runningSince = now
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      await saveStandup($, onActivity(await loadStandup($, now), now)).catch(() => {})
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    $.ui.status(undefined) // the band replaces the status line an older version wrote
    await $.command.register({ name: 'meter', description: '查看缓存、上下文、额度和费用明细' }).catch(() => {})
    $.clock.every(1000, () => void refresh($))
    await refresh($)
    return r
  })

  // Main-thread responses only: a subagent's requests keep a cache of their own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage) {
      const at = await $.clock.now()
      const hit = hitPercent(result.usage)
      const { rateLimits } = await $.session.usage()
      const { ttl, source } = ttlFor(cfg.ttlOption, rateLimits)
      await $.state.set(LAST, { at, hitPercent: hit, ttl, ttlSource: source })
      await refresh($)
    }
    return result
  })

  // The main conversation's turn is over; one reading of the context, for the turns left.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      mem.runningSince = 0
      const { context } = await $.session.usage()
      if (context.tokens !== undefined) {
        const held = (await $.state.get(READINGS)).value ?? []
        await $.state.set(READINGS, [...held, { tokens: context.tokens }].slice(-HISTORY))
      }
      await refresh($)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    await $.state.set(LAST, null) // /clear starts a fresh prefix
    await $.state.set(READINGS, [])
    mem.viewKey = ''
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const v = (await $.state.get(VIEW)).value ?? null
    if (e.props.hasSurvey || !v) return rest
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = v.failing ? [...v.chips, FAILING_CHIP] : v.chips
    const rows = layout(all, Math.max(10, e.props.bodyColumns - 2), Math.min(2, Math.max(1, e.props.maxRows)))

    return (
      <Box flexDirection="column">
        {v.standup && (
          <Box key="standup" flexDirection="row" columnGap={2} paddingX={1}>
            <Box flexDirection="column">
              {figure(v.standup.frame).map((r, i) => (
                <Text key={`px${i}`} color="green">{r}</Text>
              ))}
            </Box>
            <Box flexDirection="column">
              {v.standup.tips.map((t, i) => (
                <Text key={`tip${i}`} color={i === 0 ? 'yellow' : undefined} bold={i === 0}>{t}</Text>
              ))}
              <Box flexDirection="row" columnGap={1}>
                <Button key="moved" label="已活动" variant="primary" onPress={() => pressStandup($, done)} />
                <Button key="later" label="10 分钟后提醒" onPress={() => pressStandup($, snooze)} />
              </Box>
            </Box>
          </Box>
        )}
        {rows.map((row, i) => (
          <Box key={`row${i}`} flexDirection="row" paddingX={1}>
            {row.flatMap((it, j) => [
              j > 0 ? <Text key={`sep:${it.chip.key}`} dimColor>{SEP}</Text> : null,
              <Text key={it.chip.key} color={it.chip.color} dimColor={it.chip.dim} bold={it.chip.key === 'context'} wrap="truncate">
                {it.label}
              </Text>,
            ])}
          </Box>
        ))}
        {rest}
      </Box>
    )
  })

  on('command.run', { command: 'meter' }, async $ => {
    const now = await $.clock.now()
    const step = (await $.state.get(LAST)).value ?? null
    const usage = await $.session.usage({ breakdown: 'summary' })
    const { context, rateLimits, cost } = usage
    const ttl = step?.ttl ?? ttlMs('1h')
    const j = judge(now)
    const out: string[] = [chips(step, now, ttl, usage, (await $.state.get(READINGS)).value ?? [], j).map(c => c.text).join(SEP), '']
    out.push(cacheDetail(step, now))
    const warnAt = warnTokens(context.window, cfg.ctxWarn, cfg.ctxWarnTokens)
    out.push(`上下文：${context.tokens !== undefined ? kTokens(context.tokens) : '–'} / ${kTokens(context.window)}（${context.percent ?? '–'}%）${warnAt ? `，${kTokens(warnAt)} 时提醒` : ''}`)
    for (const c of context.breakdown?.categories ?? []) {
      if (c.tokens > 0) out.push(`  ${c.name}: ${kTokens(c.tokens)}${c.isDeferred ? '（按需加载）' : ''}`)
    }
    for (const r of rateLimits) {
      const runsOut = exhaustsAt(r, now, j.rates?.[r.kind])
      const reset = hhmm(r.resetsAt, now)
      out.push(`额度 ${WINDOW_LABEL[r.kind] ?? r.kind}：已用 ${r.percentUsed}%${reset ? `，${reset} 重置` : ''}${runsOut ? `；按当前速度约 ${hhmmAt(runsOut, now)} 用完` : ''}`)
    }
    if (cost) out.push(`本会话费用：$${cost.usd.toFixed(2)}`)
    if (cfg.standupMs > 0) {
      const p = phase(await loadStandup($, now), now, cfg.standupMs)
      out.push(p.phase === 'away' ? '久坐：超过 10 分钟没发消息，下次发消息时重新计时' : `久坐：已坐 ${duration(p.sat)}，每 ${cfg.standupMs / 60_000} 分钟提醒一次`)
    }
    if (mem.failures > 0) out.push(`刷新失败 ${mem.failures} 次，最后一次：${mem.lastError}`)
    return { text: out.join('\n') }
  })
}
