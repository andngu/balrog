import type { AgentInfo, AgentSpawnArgs, AgentSpawnResult, FsStat, ModelCompleteRequest, ModelCompleteResult, ModelForkResult, ProcessRunInit, ProcessRunResult, SessionSendResult, Timer, UiNotifyResult, UiOpenResult } from 'claude-code'

import type { Run } from '../types'

// Every `$` call must be spelled `$.noun.event(...)` where `$` is a hook's own
// parameter, so the engine is reached through closures a hook binds here.
export type Io = {
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  spawn: (args: AgentSpawnArgs) => Promise<AgentSpawnResult>
  agents: () => Promise<AgentInfo[]>
  stop: (agentId: string) => Promise<unknown>
  send: (agentId: string, text: string) => Promise<SessionSendResult>
  home: () => Promise<string | undefined>
  cacheHome: () => Promise<string | undefined>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  stat: (path: string) => Promise<FsStat>
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  fork: (prompt: string) => Promise<ModelForkResult>
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  cwd: () => Promise<string>
  openPane: () => Promise<UiOpenResult>
  status: (text: string | undefined) => void
  toast: (text: string) => void
  notify: (text: string) => Promise<UiNotifyResult>
  invalidate: () => void
  readRun: () => Promise<Run | null>
  writeRun: (change: (run: Run | null) => Run | null) => Promise<Run | null>
  readSelected: () => Promise<string[]>
  writeSelected: (change: (ids: string[]) => string[]) => Promise<string[]>
}

let bound: Io | undefined

export function bind(next: Io): void {
  bound = next
}

export function io(): Io {
  if (!bound) throw new Error('no-mistakes: session.start has not bound the engine yet')
  return bound
}
