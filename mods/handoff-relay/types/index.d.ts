/** A handoff found on disk and offered to the person. */
export type Offer = {
  /** Absolute path of the handoff file. */
  path: string
  /** The file's mtime when it was offered; with `path`, what Dismiss remembers. */
  mtimeMs: number
  /** Where it came from: Claude's at a held /clear, the /handoff skill, or the repo's HANDOFF.md. */
  source: 'auto' | 'skill' | 'repo'
  /** One line for the band. */
  headline: string
}

declare module 'claude-code' {
  interface PluginState {
    'handoff-relay': {
      offer: Offer | null
      willAttach: boolean
    }
  }
}
