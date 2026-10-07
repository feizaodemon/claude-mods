import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Offer } from '../types'
import type { Candidate } from './core'
import { ASKS_FOR_IT, DIR_NAME, MAX_AGE_MS, MIN_TURNS, autoName, fileText, headline, mechanical, parseFile, pick, redact, samePath, wrapPrompt } from './core'

// One relay for every handoff of a folder: the handoff the model writes when the
// first /clear is held (as clear-guard did), the mechanical one this mod saves on
// /clear or exit when there is none, the file the /handoff skill writes to the
// same temp folder, and the repo's own HANDOFF.md. The newest one not yet
// dismissed is offered above the prompt and goes with the next prompt on Load
// (or when the prompt asks to continue).

const offer = atom({ plugin: 'handoff-relay', key: 'offer' } as const, null)
const willAttach = atom({ plugin: 'handoff-relay', key: 'willAttach' } as const, false)
const startedAt = atom({ plugin: 'handoff-relay', key: 'startedAt' } as const, 0)

const SEEN_KEY = 'seen'
const SEEN_MAX = 50

// Held /clears as `sessionId|turns`, kept in the store so a restart or /resume
// remembers them: a conversation is held again only after new turns past the
// one that wrote the handoff.
const HELD_KEY = 'held'

async function handoffDir($: EngineInterface): Promise<string> {
  const tmp = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
  return `${tmp.replace(/[\\/]+$/, '')}/${DIR_NAME}`
}

async function git($: EngineInterface, args: string[]): Promise<string> {
  const r = await $.process.run(['git', ...args]).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout.trim() : ''
}

/** The temp-folder handoffs for `cwd` saved in the last three days, newest first. */
async function tempCandidates($: EngineInterface, cwd: string, now: number): Promise<Candidate[]> {
  const dir = await handoffDir($)
  const entries = await $.fs.list(dir).catch(() => [])
  const fresh = entries
    .filter(f => f.kind === 'file' && f.name.endsWith('.md') && now - f.mtimeMs < MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
  const out: Candidate[] = []
  for (const f of fresh) {
    const path = `${dir}/${f.name}`
    const text = await $.fs.read(path).catch(() => undefined)
    if (typeof text !== 'string') continue
    const meta = parseFile(text)
    if (meta.cwd === undefined || !samePath(meta.cwd, cwd)) continue
    out.push({ path, mtimeMs: f.mtimeMs, source: meta.source === 'auto' ? 'auto' : 'skill', body: meta.body })
  }
  return out
}

async function repoCandidate($: EngineInterface): Promise<Candidate | undefined> {
  const root = await git($, ['rev-parse', '--show-toplevel'])
  if (!root) return undefined
  const path = `${root}/HANDOFF.md`
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined
  const body = await $.fs.read(path).catch(() => undefined)
  return typeof body === 'string' && body.trim() !== '' ? { path, mtimeMs: stat.mtimeMs, source: 'repo', body } : undefined
}

async function seen($: EngineInterface, key = SEEN_KEY): Promise<string[]> {
  const list = await $.store.get(key)
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []
}

/** The turn count at which this conversation's /clear was last held, if ever. */
async function heldAt($: EngineInterface, id: string): Promise<number | undefined> {
  const entry = (await seen($, HELD_KEY)).findLast(s => s.startsWith(`${id}|`))
  return entry === undefined ? undefined : Number(entry.slice(id.length + 1))
}

async function markHeld($: EngineInterface, id: string, turns: number): Promise<void> {
  const list = (await seen($, HELD_KEY)).filter(s => !s.startsWith(`${id}|`))
  await $.store.set(HELD_KEY, [...list, `${id}|${turns}`].slice(-SEEN_MAX))
}

async function markSeen($: EngineInterface, o: Offer): Promise<void> {
  const list = (await seen($)).filter(s => s !== `${o.path}|${o.mtimeMs}`)
  await $.store.set(SEEN_KEY, [...list, `${o.path}|${o.mtimeMs}`].slice(-SEEN_MAX))
}

async function refreshOffer($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const repo = await repoCandidate($)
  const all = [...(await tempCandidates($, cwd, now)), ...(repo ? [repo] : [])]
  const best = pick(all, await seen($))
  await update($, willAttach, () => false)
  await update($, offer, () => (best ? { path: best.path, mtimeMs: best.mtimeMs, source: best.source, headline: headline(best.body) } : null))
}

const LABEL: Record<Offer['source'], string> = { auto: '自动交接', skill: '/handoff 交接', repo: 'HANDOFF.md' }

/** The offered file as context for the model, or undefined when it is gone. */
async function contextOf($: EngineInterface, o: Offer): Promise<string | undefined> {
  const text = await $.fs.read(o.path).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  return `[handoff-relay] 上一个会话的${LABEL[o.source]}（${o.path}）：\n\n${parseFile(text).body.trim()}`
}

async function consume($: EngineInterface, o: Offer): Promise<void> {
  await markSeen($, o)
  await update($, offer, () => null)
  await update($, willAttach, () => false)
}

/** Writes the mechanical auto handoff, unless this session already left one (the model's, say). */
async function save($: EngineInterface): Promise<boolean> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const since = await read($, startedAt)
  if ((await tempCandidates($, cwd, now)).some(c => c.mtimeMs >= since)) return false

  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length < 2) return false
  const branch = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const body = redact(mechanical(messages, branch))
  await $.fs.write(`${await handoffDir($)}/${autoName(cwd, now)}`, fileText(cwd, 'auto', new Date(now).toISOString(), body))
  return true
}

export const register: Register = on => {
  // /clear ends the conversation without a turn of the model's. The first /clear
  // of a working conversation is held and the model writes the handoff; the next
  // /clear goes through, so a second /clear straight away skips it.
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const id = await $.session.id().catch(() => '')
    const turns = await $.session.turns().catch(() => 0)
    if (!id || turns < MIN_TURNS) return next(e)
    // The handoff turn itself adds one; only work after it earns a new hold.
    const held = await heldAt($, id)
    if (held !== undefined && turns <= held + 1) return next(e)
    await markHeld($, id, turns)
    const cwd = await $.session.cwd()
    const now = await $.clock.now()
    const ask = wrapPrompt(`${await handoffDir($)}/${autoName(cwd, now)}`, cwd, new Date(now).toISOString())
    // Not from inside this hook (the engine refuses: it would wait on the turn the
    // hook holds); a timer submits it once the hook has answered.
    $.clock.after(0, () => void $.prompt.submit({ text: ask }).catch(() => {}))
    return { text: 'handoff-relay：先收尾，已让 Claude 写交接摘要；写完后再 /clear 一次。（马上再 /clear 一次可跳过）' }
  })

  on('session.start', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, startedAt, () => at)
    // The desktop app does not route a mod's commands; the terminal does. A
    // refusal (a skill of the same name) must not cost the offer below.
    await $.command
      .register({ name: 'handoff-load', description: 'Load the newest handoff for this folder into the next prompt' })
      .catch(() => undefined)
    await refreshOffer($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'prompt_input_exit') return next(e)
    // The whole session.end chain shares one ~1.5 s bound: no model call here,
    // only the mechanical fallback when the model wrote no handoff.
    const isSaved = await save($).catch(err => {
      $.ui.log(`handoff-relay: save failed: ${String(err)}`, { to: 'debug' })
      return false
    })
    // After /clear the process goes on: this is a new session from here.
    const at = await $.clock.now()
    await update($, startedAt, () => at)
    await refreshOffer($).catch(() => undefined)
    if (isSaved) $.ui.toast('交接已保存，下次提问时可载入')
    return next(e)
  })

  on('command.run', { command: 'handoff-load' }, async $ => {
    await refreshOffer($)
    const o = await read($, offer)
    if (!o) return { text: '这个目录没有可载入的交接。' }
    await update($, willAttach, () => true)
    return { text: `${LABEL[o.source]}会随下一条消息发送：${o.headline}` }
  })

  on('prompt.submit', async ($, e, next) => {
    const o = await read($, offer)
    if (!o || e.origin.kind !== 'composer') return next(e)
    if (!(await read($, willAttach)) && !ASKS_FOR_IT.test(e.text)) {
      // A first prompt that goes without it says this conversation is new work:
      // hide the offer, unmarked, so the next session offers it again.
      await update($, offer, () => null)
      return next(e)
    }
    const ctx = await contextOf($, o)
    await consume($, o)
    return ctx ? next({ ...e, context: [...(e.context ?? []), ctx] }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const o = await read($, offer)
    if (!o || e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
    const isQueued = await read($, willAttach)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" columnGap={1} width={e.props.bodyColumns}>
        <Text color="cyan">↺</Text>
        <Text dimColor wrap="truncate">
          {isQueued ? `${LABEL[o.source]}将随下一条消息发送：` : `${LABEL[o.source]}：`}
          {o.headline}
        </Text>
        {/* Digits: a bare digit in an empty composer presses a band Button; a letter needs ctrl+x tab first. */}
        {!isQueued && <Button key="load" label="Load" hotkey="1" plain variant="primary" onPress={() => update($, willAttach, () => true)} />}
        <Button key="dismiss" label="Dismiss" hotkey="2" plain role="dismiss" onPress={() => consume($, o)} />
      </Box>
    )
  })
}
