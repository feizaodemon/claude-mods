// Pure helpers: no `$`, so the tests call them directly.

export const MAX_AGE_MS = 3 * 24 * 3600_000
export const DIR_NAME = 'claude-handoff'

/** Prompts that ask for the previous session back, in English or Chinese. */
export const ASKS_FOR_IT =
  /prompt to (restart|continue|complete|resume)|lost (you|your)|redisplay|pull up|where were we|carry on|继续上次|接着(上次|做)|上次(做到|的进度)|(做|进行)到哪|交接|恢复上下文/i

/** A conversation shorter than this many turns clears at once, with no wrap-up. */
export const MIN_TURNS = 3

/**
 * What the held /clear asks the model: wrap up, then write the handoff to `path`.
 * It keeps clear-guard's 收尾 prefix, which session-namer leaves out of its naming input.
 */
export function wrapPrompt(path: string, cwd: string, savedAt: string): string {
  return [
    '收尾：我要 /clear 了。',
    '1. 如果 ~/.claude/CLAUDE.md 有收尾规则，先按它把本会话结论写到对的地方。',
    `2. 再用简体中文写一份交接，存到 \`${path}\`（目录不存在就建）。文件开头必须是这段 front matter：`,
    '',
    '```',
    `---\ncwd: ${cwd}\nsource: auto\nsaved: ${savedAt}\n---`,
    '```',
    '',
    '交接不超过 250 字，纯 markdown，不要开场白。包含：目标；已完成的事（PR 号、commit、文件路径）；确切的下一步；已做的决定和坑；Git 状态。',
    '已有产物（规格、计划、ADR、issue、commit、diff）只用路径或 URL 引用，不复述。最后加一节 "suggested skills"。不要写入 API key、密码、token 或个人身份信息。',
    '3. 最后列出写了什么、写在哪。',
  ].join('\n')
}

const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|pk|rk)-(ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]
// These keep their label (group 1) and mask only the value.
const LABELLED: readonly RegExp[] = [
  /(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|密码)\s*[:=：]\s*)\S+/gi,
]

/** Masks the secrets a handoff must never carry. */
export function redact(text: string): string {
  const bare = SECRETS.reduce((out, re) => out.replace(re, '[REDACTED]'), text)
  return LABELLED.reduce((out, re) => out.replace(re, '$1[REDACTED]'), bare)
}

/** Paths compare without case and with one kind of slash, the way Windows treats them. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export type Meta = { cwd?: string; source?: string; body: string }

/** Reads the `---` front matter a handoff file opens with; a file without one is all body. */
export function parseFile(text: string): Meta {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { body: text }
  const meta: Meta = { body: text.slice(m[0].length) }
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim())
    if (kv?.[1] === 'cwd') meta.cwd = kv[2]?.trim()
    if (kv?.[1] === 'source') meta.source = kv[2]?.trim()
  }
  return meta
}

export function fileText(cwd: string, source: string, savedAt: string, body: string): string {
  return `---\ncwd: ${cwd}\nsource: ${source}\nsaved: ${savedAt}\n---\n\n${body.trim()}\n`
}

/** A file name for an auto save: the folder's last part plus the time, safe on every OS. */
export function autoName(cwd: string, now: number): string {
  const leaf = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'root'
  return `${leaf.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${now}.md`
}

export function headline(body: string): string {
  // A section title such as "## 目标" says nothing about which handoff it is: take the first line of text.
  const lines = body.split('\n').filter(l => l.trim() !== '')
  const line = lines.find(l => !/^#/.test(l.trim())) ?? lines[0] ?? ''
  return line.replace(/^[#*>\-\s]+/, '').slice(0, 90)
}

export type Candidate = { path: string; mtimeMs: number; source: 'auto' | 'skill' | 'repo'; body: string }

/** The newest candidate the person has not dismissed in its current version. */
export function pick(candidates: readonly Candidate[], seen: readonly string[]): Candidate | undefined {
  return [...candidates]
    .filter(c => !seen.includes(`${c.path}|${c.mtimeMs}`))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
}

export type Message = { role: string; text?: string }

/** The mechanical part of an auto handoff, built from the transcript alone. */
export function mechanical(messages: readonly Message[], branch: string): string {
  const recent = messages.slice(-60)
  const all = recent.map(m => m.text ?? '').join('\n')
  const lastAnswer = [...recent].reverse().find(m => m.role === 'assistant' && (m.text ?? '').trim() !== '')?.text ?? ''
  const asks = recent
    .filter(m => m.role === 'user' && (m.text ?? '').trim() !== '' && !(m.text ?? '').startsWith('<'))
    .map(m => (m.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200))
    .slice(-6)
  const links = [...new Set(all.match(/https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+/g) ?? [])].slice(-5)
  const prs = [...new Set((all.match(/\/pull\/\d+|\bPR\s*#\d{1,5}\b/g) ?? []).map(p => `#${p.replace(/\D/g, '')}`))].slice(-10)

  const parts: string[] = []
  if (branch) parts.push(`分支：${branch}`)
  if (prs.length) parts.push(`提到的 PR：${prs.join(', ')}`)
  if (links.length) parts.push(`Artifacts：${links.join(' ')}`)
  if (asks.length) parts.push(`## 最近的提问\n${asks.map(a => `- ${a}`).join('\n')}`)
  if (lastAnswer) parts.push(`## 最后一条回答\n${lastAnswer.slice(0, 4000)}`)
  return parts.join('\n\n')
}
