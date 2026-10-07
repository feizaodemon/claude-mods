import { expect, test } from 'claude-code/testing'

import type { Snapshot } from '../hooks/alerts'
import { EMPTY_MEMO, decideToasts } from '../hooks/alerts'
import { hhmm } from '../hooks/format'

const calm: Snapshot = { running: false, away: false, context: { tokens: 50_000, percent: 25, window: 200_000, warnAt: 160_000 }, pace: [] }

test('nothing to say on a calm snapshot', () => {
  expect(decideToasts(calm, EMPTY_MEMO).toasts).toEqual([])
})

test('the person is reminded only between turns, once per sitting and once per night', () => {
  const due: Snapshot = { ...calm, standup: { key: 's1', sat: '1h00m' }, night: { key: '2026-10-07', time: '23:05' } }
  expect(decideToasts({ ...due, running: true }, EMPTY_MEMO).toasts).toEqual([])
  const first = decideToasts(due, EMPTY_MEMO)
  expect(first.toasts).toEqual(['已经连续坐了 1h00m，起来活动 3 分钟吧', '已经 23:05 了：收个尾，早点休息'])
  expect(decideToasts(due, first.memo).toasts).toEqual([])
  expect(decideToasts({ ...due, standup: { key: 's2', sat: '1h10m' } }, first.memo).toasts).toHaveLength(1) // after a snooze
})

test('the cache warning needs a costly context and someone at the desk', () => {
  const soon: Snapshot = { ...calm, cache: { at: 1, left: 30_000, warnMs: 60_000 } }
  expect(decideToasts(soon, EMPTY_MEMO).toasts[0]).toContain('重新写入约 50k token')
  expect(decideToasts({ ...soon, away: true }, EMPTY_MEMO).toasts).toEqual([])
  expect(decideToasts({ ...soon, context: { ...soon.context, tokens: 10_000 } }, EMPTY_MEMO).toasts).toEqual([])
  expect(decideToasts({ ...soon, running: true }, EMPTY_MEMO).toasts).toHaveLength(1) // the session's, not the person's
})

test('context warnings: once at the size, once at twice it, again after a drop', () => {
  const ctx = (tokens: number): Snapshot => ({ ...calm, context: { tokens, percent: tokens / 10_000, window: 1_000_000, warnAt: 200_000 } })
  const a = decideToasts(ctx(210_000), EMPTY_MEMO)
  expect(a.toasts).toHaveLength(1)
  const b = decideToasts(ctx(410_000), a.memo)
  expect(b.toasts[0]).toContain('建议现在 /compact')
  const dropped = decideToasts(ctx(50_000), b.memo)
  expect(decideToasts(ctx(210_000), dropped.memo).toasts).toHaveLength(1)
})

test('a window running out is told once per reset', () => {
  const pace: Snapshot = { ...calm, pace: [{ key: 'five_hour:A', label: '5小时', at: '13:00', reset: '14:00' }] }
  const a = decideToasts(pace, EMPTY_MEMO)
  expect(a.toasts).toEqual(['5小时额度按当前速度约 13:00 用完（14:00 重置）：可以降低 effort 或换小一点的模型'])
  expect(decideToasts(pace, a.memo).toasts).toEqual([])
  expect(decideToasts({ ...calm, pace: [{ ...pace.pace[0]!, key: 'five_hour:B' }] }, a.memo).toasts).toHaveLength(1)
})

test('a time on another day names the day', () => {
  const now = new Date(2026, 9, 7, 12, 0).getTime() // a Wednesday
  expect(hhmm(new Date(2026, 9, 7, 17, 0).toISOString(), now)).toBe('17:00')
  expect(hhmm(new Date(2026, 9, 9, 17, 0).toISOString(), now)).toBe('周五17:00')
  expect(hhmm(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe('10/14 09:05')
  expect(hhmm(new Date(2026, 9, 9, 17, 0).toISOString())).toBe('17:00')
})
