export type StepName = 'rebase' | 'review' | 'test' | 'document' | 'lint' | 'push' | 'pr' | 'ci'

export type Severity = 'error' | 'warning' | 'info'

export type FindingAction = 'auto-fix' | 'ask-user' | 'no-op'

export type Finding = {
  id: string
  severity: Severity
  action: FindingAction
  file?: string
  line?: number
  description: string
}

// `starting`, and `fixing` without an agentId, are claims: one actor owns the
// step's start effect and nobody else may start it or settle it.
export type StepState =
  | { status: 'pending' }
  | { status: 'starting'; startedAt: number }
  // `reasked`: the agent's answer was unreadable and it was asked once more.
  | { status: 'running'; agentId?: string; startedAt: number; reasked?: true }
  | { status: 'fixing'; agentId?: string; round: number; startedAt: number }
  | { status: 'parked'; findings: Finding[] }
  | { status: 'passed'; note?: string; findings: Finding[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export type Verdict = 'fix' | 'approve' | 'skip'

export type Decision = { step: StepName; findingIds: string[]; verdict: Verdict; isAuto?: true }

export type Outcome = 'passed' | 'failed' | 'aborted'

// `commands.*` of .no-mistakes.yaml as read from origin/<base>: the repository's
// own shell commands, run by the mod inside the worktree.
export type CommandName = 'prepare' | 'test' | 'lint' | 'format'

export type Commands = Partial<Record<CommandName, string>>

export type Run = {
  id: string
  repo: string
  branch: string
  base: string
  worktree: string
  // What `<worktree>/.git` held when the mod created it, and where the
  // repository's common git dir really lives: the mod runs git in the worktree
  // only while both still hold.
  gitFile: string
  commonDir: string
  intent: string
  localHead: string
  head: string
  remoteHead: string
  commands: Commands
  prepared?: true
  // Worktree-relative paths a run agent wrote: the only untracked files the
  // mod commits, so what a command leaves behind stays out.
  written?: string[]
  // The mod's own commits beyond the rebased head, subject and stat, as the
  // push step found them.
  commits?: string
  agents: string[]
  // Agents whose step has moved on: their answers are ignored and every tool
  // call they make is refused, as is every run agent's once the run ends.
  retired?: string[]
  steps: Record<StepName, StepState>
  decisions: Decision[]
  prUrl?: string
  prNumber?: number
  // Abort pressed while a step's start effect (push, PR, spawn) was in
  // flight; the owner of that effect honours it once the effect settles.
  abortRequested?: true
  outcome?: Outcome
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'no-mistakes': { run: Run | null; selected: string[] }
  }
}
