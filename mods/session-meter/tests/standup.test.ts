import { expect, test } from 'claude-code/testing'

import { IDLE_RESET_MS, SNOOZE_MS, advice, breaksToday, dayOf, done, figure, fresh, halfBlocks, lateNight, onActivity, parse, phase, snooze, standupChip } from '../hooks/standup'

const MIN = 60_000
const HOUR = 60 * MIN
// A sitting with a prompt every five minutes from 0 to `until`.
function sitting(until: number) {
  let s = fresh(0)
  for (let t = 5 * MIN; t <= until; t += 5 * MIN) s = onActivity(s, t)
  return s
}

test('the clock runs while prompts keep coming, and is due after the interval', () => {
  const s = sitting(HOUR)
  expect(phase(s, 45 * MIN, HOUR).phase).toBe('ok')
  expect(phase(s, 52 * MIN, HOUR).phase).toBe('soon')
  expect(phase(s, HOUR, HOUR).phase).toBe('due')
  expect(standupChip(phase(s, HOUR, HOUR))?.text).toBe('起来活动下！已坐 1h00m')
})

test('ten minutes without a prompt is a break: away now, and the next prompt starts over', () => {
  const s = sitting(40 * MIN)
  expect(phase(s, 40 * MIN + IDLE_RESET_MS, HOUR).phase).toBe('away')
  expect(standupChip(phase(s, 40 * MIN + IDLE_RESET_MS, HOUR))).toBeUndefined()
  const back = onActivity(s, 40 * MIN + IDLE_RESET_MS)
  expect(back.since).toBe(40 * MIN + IDLE_RESET_MS)
  expect(onActivity(s, 45 * MIN).since).toBe(0) // a short pause keeps the clock
})

test('snooze holds the reminder ten minutes; done starts a new sitting', () => {
  const s = snooze(sitting(HOUR), HOUR)
  expect(phase(s, HOUR + 5 * MIN, HOUR).phase).toBe('soon') // snoozed: yellow, not due
  expect(phase(onActivity(s, HOUR + 5 * MIN), HOUR + SNOOZE_MS, HOUR).phase).toBe('due')
  expect(done(s, HOUR).since).toBe(HOUR)
})

test('a stored value of the wrong shape starts fresh', () => {
  expect(parse(undefined, 7).since).toBe(7)
  expect(parse({ since: 'x' }, 7).since).toBe(7)
  expect(parse({ since: 1, lastActiveAt: 2 }, 7)).toEqual({ since: 1, lastActiveAt: 2, snoozeUntil: 0, nudged: '', day: dayOf(7), breaks: 0 })
})

test('half blocks draw two pixel rows per text row', () => {
  expect(halfBlocks(['#.#.', '##..'])).toEqual(['█▄▀ '])
  expect(figure(0)).toHaveLength(3)
  expect(figure(1)).not.toEqual(figure(0))
})

test('breaks count toward today, and the tip changes with each sitting', () => {
  const s = sitting(HOUR)
  const after = onActivity(s, HOUR + IDLE_RESET_MS) // came back from a break
  expect(breaksToday(after, HOUR + IDLE_RESET_MS)).toBe(1)
  const twice = done(after, HOUR + IDLE_RESET_MS + 5 * MIN)
  expect(breaksToday(twice, HOUR + IDLE_RESET_MS + 5 * MIN)).toBe(2)
  expect(breaksToday(twice, HOUR + 2 * 24 * HOUR)).toBe(0) // another day
  expect(advice(twice, HOUR, HOUR + IDLE_RESET_MS + 5 * MIN)).toContain('今天已经活动了 2 次，继续保持。')
  expect(advice(s, HOUR, HOUR)).toHaveLength(2) // no breaks yet: no count line
  expect(advice(fresh(0), HOUR, 0)[1]).not.toBe(advice(fresh(MIN), HOUR, MIN)[1])
})

test('the late-night reminder covers bedtime to 5 am, as one night', () => {
  const at = (h: number, d = 7) => new Date(2026, 9, d, h, 30).getTime()
  expect(lateNight(at(22), 23)).toBeUndefined()
  expect(lateNight(at(23), 23)).toBe('2026-10-07')
  expect(lateNight(at(1, 8), 23)).toBe('2026-10-07') // after midnight: the same night
  expect(lateNight(at(6, 8), 23)).toBeUndefined()
  expect(lateNight(at(23), 0)).toBeUndefined() // off
})