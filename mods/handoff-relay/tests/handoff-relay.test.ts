import type { Register } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ASKS_FOR_IT, headline, parseFile, pick, redact, samePath } from '../hooks/core'

type On = Parameters<Register>[0]
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const DIR = 'C:/tmp/claude-handoff'
// The engine hands hooks Windows spellings; the fake disk keys on one form.
const key = (p: string) => p.replace(/\\/g, '/')

/** A fake disk: TEMP is C:/tmp, git says the repo has no root, files live in `disk`. */
function world(on: On, disk: Map<string, { text: string; mtimeMs: number }>) {
  const clk = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.render', () => null as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', () => ({ value: 'C:\\repo' }))
  on('env.get', ($, e) => ({ value: e.name === 'TEMP' ? 'C:/tmp' : undefined }) as never)
  on('process.run', ($, e) => (e.argv.includes('--show-toplevel') ? { value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : ok('main\n')) as never)
  on('fs.list', () => ({ value: [...disk].map(([p, f]) => ({ name: p.slice(p.lastIndexOf('/') + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })) }) as never)
  on('fs.read', ($, e) => {
    const f = disk.get(key(e.path))
    return (f ? { value: f.text } : { deny: `ENOENT ${e.path}` }) as never
  })
  on('fs.write', ($, e) => {
    disk.set(key(e.path), { text: e.text, mtimeMs: 1_000_000 })
    return { value: undefined } as never
  })
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '帮我修 PR #642 的测试，token=ghp_abcdefghijklmnopqrstuvwxyz123456', toolUses: [] },
      { role: 'assistant', text: '测试已修好，下一步是合并 PR #642。', toolUses: [] },
    ],
  }))
  on('session.id', () => ({ value: 's1' }) as never)
  return clk
}

test('/clear saves a redacted handoff and a 继续 prompt gets it as context', async ($, on) => {
  const disk = new Map<string, { text: string; mtimeMs: number }>()
  world(on, disk)
  let seen: readonly string[] = []
  on('prompt.submit', ($, e) => {
    seen = e.context ?? []
    return { text: e.text, context: e.context }
  })

  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  const saved = [...disk.values()][0]?.text ?? ''
  expect(saved).toContain('cwd: C:\\repo')
  expect(saved).toContain('合并 PR #642')
  expect(saved).not.toContain('ghp_abcdefghij')

  await $.prompt.submit({ text: '继续上次的工作', origin: { kind: 'composer' }, wait: false })
  const text = seen.join('\n')
  expect(text).toContain('[handoff-relay]')
  expect(text).toContain('合并 PR #642')
})

test('a /handoff skill file from this session stops the auto save', async ($, on) => {
  const disk = new Map<string, { text: string; mtimeMs: number }>()
  world(on, disk)
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  disk.set(`${DIR}/repo-skill.md`, { text: '---\ncwd: c:/repo/\nsource: skill\n---\n\n# 交接\n下一步：部署', mtimeMs: 9_000_000 })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } } as never)
  expect(disk.size).toBe(1)
})

/** A working conversation of `turns` turns: /clear runs count in `cleared`, prompts in `submitted`. */
function clearWorld(on: On, turns: number) {
  const seen = { turns, cleared: 0, submitted: [] as string[] }
  const clk = world(on, new Map())
  on('session.turns', () => ({ value: seen.turns }) as never)
  on('prompt.submit', ($, e) => (seen.submitted.push(e.text), { text: e.text }) as never)
  on('command.run', () => (seen.cleared++, { text: '' }) as never)
  return { seen, clk }
}

test('the first /clear of a working conversation asks for a handoff; the next goes through', async ($, on) => {
  const { seen, clk } = clearWorld(on, 5)
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  const held = await $.command.run({ command: 'clear', args: '' } as never)
  await clk.advance(0)
  expect(held.text).toContain('handoff-relay')
  expect(seen.cleared).toBe(0)
  expect(seen.submitted).toHaveLength(1)
  expect(seen.submitted[0]).toStartWith('收尾：我要 /clear 了')
  expect(seen.submitted[0]).toContain(`${DIR}/repo-1000000.md`)
  expect(seen.submitted[0]).toContain('cwd: C:\\repo')
  await $.command.run({ command: 'clear', args: '' } as never)
  await clk.advance(0)
  expect(seen.cleared).toBe(1)
  expect(seen.submitted).toHaveLength(1)
})

test('a /resume back to a handed-off conversation clears at once; new work there is held again', async ($, on) => {
  const { seen, clk } = clearWorld(on, 5)
  const clear = async () => (await $.command.run({ command: 'clear', args: '' } as never), await clk.advance(0))
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  await clear()
  seen.turns = 6 // the handoff turn
  await clear()
  await clear() // back again with /resume: same id, no new turns
  expect(seen.cleared).toBe(2)
  expect(seen.submitted).toHaveLength(1)
  seen.turns = 9
  await clear()
  expect(seen.cleared).toBe(2)
  expect(seen.submitted).toHaveLength(2)
})

test('a first prompt without the handoff hides the offer, unmarked', async ($, on) => {
  const disk = new Map<string, { text: string; mtimeMs: number }>()
  world(on, disk)
  let seen: readonly string[] = []
  on('prompt.submit', ($, e) => ((seen = e.context ?? []), { text: e.text, context: e.context }))
  disk.set(`${DIR}/repo-old.md`, { text: '---\ncwd: C:\\repo\nsource: auto\n---\n\n## 目标\n部署', mtimeMs: 900_000 })
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  await $.prompt.submit({ text: '看一下日志', origin: { kind: 'composer' }, wait: false })
  await $.prompt.submit({ text: '继续上次的工作', origin: { kind: 'composer' }, wait: false })
  expect(seen).toEqual([])
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  await $.prompt.submit({ text: '继续上次的工作', origin: { kind: 'composer' }, wait: false })
  expect(seen.join('\n')).toContain('部署')
})

test('a short conversation clears at once', async ($, on) => {
  const { seen, clk } = clearWorld(on, 2)
  await $.session.start({ cwd: 'C:\\repo', surface: null, isInteractive: true })
  await $.command.run({ command: 'clear', args: '' } as never)
  await clk.advance(0)
  expect(seen.cleared).toBe(1)
  expect(seen.submitted).toEqual([])
})

test('helpers', () => {
  expect(redact('Authorization: Bearer abcdefghijklmnopqrstu')).toBe('Authorization: Bearer [REDACTED]')
  expect(redact('密码: hunter2 and sk-ant-abcdefghijklmnopqrst')).toBe('密码: [REDACTED] and [REDACTED]')
  expect(headline('# 交接\n\n下一步：部署')).toBe('下一步：部署')
  expect(headline('## 目标\nStage B 真人试采\n## 已完成')).toBe('Stage B 真人试采')
  expect(samePath('C:\\Repo\\', 'c:/repo')).toBe(true)
  expect(ASKS_FOR_IT.test('我们做到哪了')).toBe(true)
  expect(ASKS_FOR_IT.test('看一下日志')).toBe(false)
  expect(parseFile('---\ncwd: /a\nsource: skill\n---\nbody').cwd).toBe('/a')
  const a = { path: 'a', mtimeMs: 1, source: 'auto' as const, body: '' }
  const b = { path: 'b', mtimeMs: 2, source: 'repo' as const, body: '' }
  expect(pick([a, b], [])?.path).toBe('b')
  expect(pick([a, b], ['b|2'])?.path).toBe('a')
})
