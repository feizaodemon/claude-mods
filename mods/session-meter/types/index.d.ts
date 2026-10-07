// The last main-thread response: when it finished, how much of its prompt the cache served,
// and the TTL its cache write got (fixed at that moment: a later overage does not shorten it).
// `ttl` / `ttlSource` are absent on a step stored by an older version and kept across a reload.
export type LastStep = { at: number; hitPercent: number | null; ttl?: number; ttlSource?: string }
// Context tokens after each main-thread turn, newest last, for the turns-left estimate.
export type Reading = { tokens: number }

// One piece of the band. `short` is what it says when room runs out; `rank` 1 is kept longest.
export type Chip = { key: string; text: string; short: string; color?: string; dim?: boolean; rank: number }

// What the band shows, worked out once a second by the tick and only read while drawing.
// `standup`: the reminder panel while it is due, with the figure's frame; `failing`: the tick has
// failed several times in a row, so the figures may be stale.
export type View = { chips: Chip[]; standup?: { tips: string[]; frame: number }; failing?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'session-meter': { last: LastStep | null; readings: Reading[]; view: View | null }
  }
}
