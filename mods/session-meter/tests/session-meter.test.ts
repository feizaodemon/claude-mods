import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { cacheDetail, cells, chips, clock, exhaustsAt, forecastPercent, hitPercent, kTokens, layout, line, recentRate, ttlFor, turnsLeft, warnTokens } from '../hooks/format'

const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, model: 'm' }

// Stands for the engine: a usage reading, one model request per step, toasts captured.
async function start($: Engine, on: On, percent = 46) {
  const seen = { toasts: [] as string[] }
  const clk = mock.clock(on, { now: 1_000_000 })
  const reading = { percent, limit: 31, env: undefined as string | undefined, settings: {} as Record<string, unknown> }
  on('session.start', (_$, e) => ({ sessionId: 's', cwd: e.cwd }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [{ kind: 'five_hour', percentUsed: reading.limit }],
      context: { tokens: reading.percent * 2000, window: 200_000, percent: reading.percent },
      cost: { usd: 4.2 },
    },
  }) as any)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE } as any
  })
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.invalidate', () => ({ value: undefined }) as any)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as any)
  on('ui.toast', (_$, e) => (seen.toasts.push(e.text), { value: undefined }) as any)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as any)
  on('env.get', (_$, e: any) => ({ value: String(e.name ?? e) === 'CLAUDE_CODE_PROMPT_CACHE_TTL' ? reading.env : undefined }) as any)
  on('settings.read', () => ({ value: reading.settings }) as any)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
  return { clk, seen, reading }
}

async function request($: Engine, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream) {
    // drain
  }
  await stream.result
}

// The band as drawn on the desktop at `columns` cells: its rows, each row's text.
async function band($: Engine, columns = 200) {
  const ui = await $.ui.mount({
    plugin: 'session-meter', surface: 'desktop', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 } },
  } as never)
  const rows = await ui.findAll({ type: 'Box' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  await ui.unmount()
  return { text: texts.join(''), rows: rows.length - 1 }
}
const lastStatus = async ($: Engine) => (await band($)).text

describe('session-meter', () => {
  test('helpers', () => {
    expect(clock(3_600_000)).toBe('1:00:00')
    expect(clock(59_001)).toBe('1:00')
    expect(hitPercent(USAGE)).toBe(90)
    expect(kTokens(950)).toBe('950')
    expect(kTokens(21_400)).toBe('21k')
    expect(kTokens(1_000_000)).toBe('1M')
    expect(hitPercent({ ...USAGE, input_tokens: 0, cache_read_input_tokens: 0 })).toBeNull()
    const usage = { startedAt: 0, rateLimits: [], context: { window: 200_000 } } as any
    expect(line(null, 0, 3_600_000, usage)).toBe('❄ 缓存 –')
  })

  test('shows every part, counts the 1h cache down, warns once, then goes cold', async ($, on) => {
    const { clk, seen } = await start($, on)
    expect(await lastStatus($)).toBe('☁ 多云 上下文 46% 92k/200k │ ❄ 缓存 – │ 5小时 ▰▰▱▱▱ 31% │ $4.20 │ 已坐 0m')

    await request($, 0)
    expect(await lastStatus($)).toBe('☁ 多云 上下文 46% 92k/200k │ ❄ 缓存 1:00:00 │ 5小时 ▰▰▱▱▱ 31% │ $4.20 │ 已坐 0m') // a 90% hit rate needs no action: not shown

    await clk.advance(59 * 60_000 + 1_000) // 59 s left
    expect(await lastStatus($)).toContain('❄ 缓存 0:59 快过期')
    const cacheToasts = seen.toasts.filter(t => t.startsWith('提示缓存'))
    expect(cacheToasts).toHaveLength(1)
    expect(cacheToasts[0]).toContain('否则要重新写入约 92k token')

    await clk.advance(5_000)
    expect(seen.toasts.filter(t => t.startsWith('提示缓存'))).toHaveLength(1)

    await clk.advance(60_000)
    expect(await lastStatus($)).toContain('❄ 缓存已过期')
  })

  test('a small context is cheap to rewrite: no cache toast', async ($, on) => {
    const { clk, seen } = await start($, on, 5) // 10k tokens
    await request($, 0)
    await clk.advance(59 * 60_000 + 1_000)
    expect(seen.toasts.filter(t => t.startsWith('提示缓存'))).toHaveLength(0)
  })

  test('nobody at the desk (10 min without a prompt): no cache toast', async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }) as any)
    const { clk, seen } = await start($, on)
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false } as any)
    await request($, 0)
    await clk.advance(59 * 60_000 + 1_000)
    expect(seen.toasts.filter(t => t.startsWith('提示缓存'))).toHaveLength(0)
  })

  test('the stand-up reminder waits for the main turn to end', { options: { standupMinutes: 5 } }, async ($, on) => {
    mock.store(on)
    on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }) as any)
    on('turn.complete', () => ({ text: '' }) as any)
    const { clk, seen } = await start($, on)
    // The clock starts at the first prompt; two more, four minutes apart, make eight minutes sat.
    for (let i = 0; i < 3; i++) {
      await clk.advance(4 * 60_000)
      await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false } as any) // a turn begins
    }
    await clk.advance(1_000)
    expect(seen.toasts.filter(t => t.startsWith('已经连续坐了'))).toHaveLength(0) // due, but mid-turn
    await $.turn.complete({ turnId: 't1', durationMs: 1, reason: 'answer', answer: '', isAborted: false } as any)
    await clk.advance(1_000)
    expect(seen.toasts.filter(t => t.startsWith('已经连续坐了'))).toHaveLength(1)
  })

  test('a 1M window warns at the token cap, not at 80%', () => {
    expect(warnTokens(1_000_000, 80, 200_000)).toBe(200_000)
    expect(warnTokens(200_000, 80, 200_000)).toBe(160_000) // the share comes first
    expect(warnTokens(1_000_000, 0, 0)).toBeUndefined()
    expect(forecastPercent(79_000, 200_000)).toBe(32) // 79k of 1M reads as cloudy, not sunny 8%
    const usage = { startedAt: 0, rateLimits: [], context: { tokens: 210_000, window: 1_000_000, percent: 21 } } as any
    expect(chips(null, 0, 3_600_000, usage)[0]?.text).toContain('⛈ 雷雨 上下文 21% 210k/1M') // past the 200k warning
  })

  test('the recent pace wins over the window average', () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    const r = { kind: 'five_hour', percentUsed: 60, resetsAt: '2026-10-07T14:00:00Z' }
    // 3 h in at 60%: the average reaches 100% at 14:00, not before the reset.
    expect(exhaustsAt(r, now)).toBeUndefined()
    // But 20 points in the last 20 minutes: 40 more take 40 minutes.
    const rate = recentRate([{ t: now - 20 * 60_000, pct: 40 }, { t: now, pct: 60 }], now)
    expect(exhaustsAt(r, now, rate)).toBe(now + 40 * 60_000)
    expect(recentRate([{ t: now - 5 * 60_000, pct: 50 }, { t: now, pct: 60 }], now)).toBeUndefined() // too short
    expect(exhaustsAt(r, now, recentRate([{ t: now - 20 * 60_000, pct: 60 }, { t: now, pct: 60 }], now))).toBeUndefined() // idle
  })

  test('turns left, quota pace and a low hit rate', () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    // 3 h into a 5 h window at 75%: 100% comes 1 h later, an hour before the reset.
    const r = { kind: 'five_hour', percentUsed: 75, resetsAt: '2026-10-07T14:00:00Z' }
    expect(exhaustsAt(r, now)).toBe(Date.parse('2026-10-07T13:00:00Z'))
    expect(exhaustsAt({ ...r, percentUsed: 30 }, now)).toBeUndefined() // reaches the reset first
    expect(exhaustsAt({ ...r, resetsAt: '2026-10-07T16:50:00Z' }, now)).toBeUndefined() // too early to judge
    expect(exhaustsAt({ kind: 'spend_limit', percentUsed: 75 }, now)).toBeUndefined()

    // +10k a turn, a /compact's drop ignored: from 50k to 80% of 200k is 11 turns.
    expect(turnsLeft([{ tokens: 70_000 }, { tokens: 80_000 }, { tokens: 30_000 }, { tokens: 40_000 }, { tokens: 50_000 }], 160_000)).toBe(11)
    // From 100k: 6 turns.
    expect(turnsLeft([{ tokens: 80_000 }, { tokens: 90_000 }, { tokens: 100_000 }], 160_000)).toBe(6)
    expect(turnsLeft([{ tokens: 170_000 }, { tokens: 180_000 }], 160_000)).toBeUndefined()

    const usage = { startedAt: 0, rateLimits: [r], context: { tokens: 100_000, window: 200_000, percent: 50 }, cost: { usd: 1 } } as any
    const all = chips({ at: now, hitPercent: 40, ttl: 3_600_000 }, now, 3_600_000, usage, [{ tokens: 90_000 }, { tokens: 100_000 }])
    const text = all.map(c => c.text).join(' │ ')
    expect(text).toContain('预计')
    expect(text).toContain('约 6 轮到 160k')
    expect(text).toContain('命中 40% 缓存可能失效')
  })

  test("a subagent's request leaves the main cache countdown alone", async ($, on) => {
    const { clk, seen } = await start($, on)
    await request($, 0)
    await clk.advance(10 * 60_000)
    await request($, 0, 'agent-1')
    expect(await lastStatus($)).toContain('❄ 缓存 50:00')
  })

  test('toasts once when the context passes the warning, again after it drops', async ($, on) => {
    const { clk, seen, reading } = await start($, on, 85)
    await clk.advance(3_000)
    expect(seen.toasts.filter(t => t.startsWith('上下文'))).toEqual(['上下文已到 170k（85%）：找个合适的节点手动 /compact'])
    reading.percent = 30
    await clk.advance(1_000)
    reading.percent = 82
    await clk.advance(1_000)
    expect(seen.toasts.filter(t => t.startsWith('上下文'))).toHaveLength(2)
  })

  test('the 5m option shortens the countdown', { options: { cacheTtl: '5m' } }, async ($, on) => {
    const { seen } = await start($, on)
    await request($, 0)
    expect(await lastStatus($)).toContain('❄ 缓存 5:00')
  })

  test('/meter prints the details', async ($, on) => {
    await start($, on)
    await request($, 0)
    const r = await $.command.run({ command: 'meter', args: '' } as any)
    expect(r.text).toContain('TTL 60 分钟（推断：额度内 1 小时）')
    expect(r.text).toContain('额度 5小时：已用 31%')
    expect(r.text).toContain('本会话费用：$4.20')
  })

  test('the TTL: the cacheTtl option, else inferred from the plan', () => {
    const ttl = (option: unknown, pct = 31) => ttlFor(option, [{ percentUsed: pct }])
    expect(ttl('auto')).toEqual({ ttl: 3_600_000, source: '推断：额度内 1 小时' })
    expect(ttl('auto', 100).ttl).toBe(300_000)
    expect(ttl('bogus', 100).ttl).toBe(300_000) // anything else counts as auto
    expect(ttl('5m')).toEqual({ ttl: 300_000, source: '插件设置' })
    expect(ttl('1h', 100)).toEqual({ ttl: 3_600_000, source: '插件设置' })
  })

  test('in overage a new write counts down 5m; the write made before keeps its 1h', async ($, on) => {
    const { clk, seen, reading } = await start($, on)
    await request($, 0)
    reading.limit = 100
    await clk.advance(10 * 60_000)
    expect(await lastStatus($)).toContain('❄ 缓存 50:00')
    await request($, 1)
    expect(await lastStatus($)).toContain('❄ 缓存 5:00')
  })

  test('a narrow band keeps the context and the cache, in at most two rows', () => {
    const usage = { startedAt: 0, rateLimits: [{ kind: 'five_hour', percentUsed: 31 }, { kind: 'seven_day', percentUsed: 92 }], context: { tokens: 92_000, window: 200_000, percent: 46 }, cost: { usd: 4.2 } } as any
    const all = chips({ at: 0, hitPercent: 90, ttl: 3_600_000 }, 0, 3_600_000, usage, [{ tokens: 50_000 }, { tokens: 92_000 }])
    for (const columns of [120, 60, 30]) {
      const rows = layout(all, columns)
      expect(rows.length).toBeLessThanOrEqual(2)
      const labels = rows.flat().map(r => r.chip.key)
      expect(labels).toContain('context')
      expect(labels).toContain('cache')
      for (const row of rows) if (row.length > 1) expect(cells(row.map(r => r.label).join(' │ '))).toBeLessThanOrEqual(columns)
    }
    expect(layout(all, 30).flat().map(r => r.chip.key)).not.toContain('hit')
  })

  test('a step stored by an older version (no TTL, no source) prints no "undefined"', () => {
    const text = cacheDetail({ at: 1_000_000, hitPercent: 100 }, 1_060_000)
    expect(text).toBe('提示缓存：上次主线程响应在 1:00 前，TTL 60 分钟，还剩 59:00；命中率 100%')
    expect(cacheDetail({ at: 0, hitPercent: 90, ttl: 300_000, ttlSource: 'promptCacheTtl' }, 0)).toContain('TTL 5 分钟（promptCacheTtl）')
  })
})
