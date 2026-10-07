# claude-mods

Claude Code mods (function-hook plugins). The UI text is in Simplified Chinese.

Claude Code 的 mod 合集（function-hook 插件）。界面文字为简体中文。

## session-meter

A band above the prompt that answers "what should I do now?":

| Shows | Why |
|---|---|
| `☁ 多云 上下文 21% 210k/1M` | Context size, judged in tokens (default warning at 200k), not in share of a 1M window |
| `约 6 轮到 200k` | Turns left before the warning, from the recent growth per turn |
| `❄ 缓存 57:42` | Prompt cache countdown (1h / 5m, from the `cacheTtl` option, the cache environment variables, or your plan) |
| `5小时 ▰▰▰▱▱ 67% 预计14:20用完 15:10重置` | Rate-limit windows, with a run-out forecast from the last 30 minutes of use |
| `命中 40% 缓存可能失效` | Cache hit rate, only when it looks broken |
| `已坐 47m` | Stand-up reminder: a pixel figure, a rotating tip and two buttons after 60 minutes |

Toasts, each sent once: cache about to expire (only when the rewrite is costly and you are at the desk), context at 200k / 400k, a rate-limit window running out before its reset, time to stand up, and a late-night nudge from 23:00. Reminders about you never interrupt a running turn. `/meter` prints every figure in full (the command works in the terminal; the desktop app does not route mod commands).

### Install

Needs a Claude Code build with function-hook plugins (developed against 2.1.288–2.1.291).

```bash
claude plugin marketplace add feizaodemon/claude-mods
claude plugin install session-meter@feizao-mods
```

Or clone this repo and list the folder in `CLAUDE_CODE_PLUGIN_DIRS` (`;`-separated on Windows, `:` elsewhere) in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-mods/mods/session-meter" } }
```

### Options

| Option | Default | |
|---|---|---|
| `cacheTtl` | `auto` | `auto`, `1h` or `5m` |
| `contextWarnPercent` | 80 | Warn at this share of the window; 0 off |
| `contextWarnTokens` | 200000 | Warn at this many tokens, again at twice it; 0 off |
| `standupMinutes` | 60 | Stand-up reminder interval; 10 minutes without a prompt counts as a break; 0 off |
| `bedtimeHour` | 23 | Late-night reminder from this hour to 5 am; 0 off |

### What the hooks do

The mod only reads: it never changes what other code sends, and it sends nothing off the machine.

| Hook | What it does |
|---|---|
| `prompt.submit` | Notes the time: a turn has started (stand-up and late-night reminders wait for it to end), and a prompt you typed means you are at the desk. Passes the prompt on unchanged. |
| `turn.step` | After each main-thread response, records when it landed, its cache hit rate and the cache TTL it got. Passes the result on unchanged. |
| `turn.complete` | Marks the main turn over and records the context size, for the turns-left estimate. |
| `session.start` / `session.end` | Registers `/meter` and starts the once-a-second tick; clears the per-conversation figures on `/clear`. |
| `ui.render` (`AbovePrompt`) | Draws the band, and the stand-up panel while it is due. What others draw there is kept. |
| `command.run` (`meter`) | Prints every figure in full. |

It reads three environment variables that set the prompt cache TTL (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H`) so the countdown is right, and nothing else from the environment. Its sitting clock and late-night flag live in the plugin's own store.

### Develop

```bash
claude plugin validate mods/session-meter
claude plugin test mods/session-meter
```

Layout: `hooks/format.ts` (the band's figures), `hooks/alerts.ts` (every toast rule, pure), `hooks/standup.ts` (sitting clock, pixel figure), `hooks/register.tsx` (the once-a-second tick and the drawing).

## License

MIT
