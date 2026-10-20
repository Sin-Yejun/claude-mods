export type FileChange = {
  path: string
  added: number
  removed: number
  edits: number
  // the last edit's changed lines, '+ ' / '- ' prefixed
  lastDiff: string[]
}

export type Job = {
  id: string
  kind: 'shell' | 'cron'
  label: string
  status: string
}

export type AgentRow = { id: string; label: string; status: string }

export type Mood = 'idle' | 'working' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'session-work': {
      cwd: string
      files: FileChange[]
      jobs: Job[]
      agents: AgentRow[]
      openPath: string
      notifyOn: boolean
      mood: Mood
    }
  }
}
