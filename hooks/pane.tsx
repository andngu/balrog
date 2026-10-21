import { atom, read } from 'claude-code'
import type { Color, On } from 'claude-code'

import type { Finding, FollowUp, Run, StepName, StepState, Verdict } from '../types'
import { press, toggle } from './engine'
import { io } from './io'
import { AGENT_TIMEOUT_MS, commitLines, currentStep, fixRounds, isAutoRound, isBlocking, MAX_FIX_ROUNDS, PANE, STEP_ORDER } from './run'

type Status = StepState['status']
type Context = { run: Run; name: StepName; now: number }

const MINUTE = 60_000
const LIMIT = AGENT_TIMEOUT_MS / MINUTE
const WARN_AT = 25
const TAIL = 4

const minutes = (state: StepState, now: number) => ('startedAt' in state ? Math.floor((now - state.startedAt) / MINUTE) : 0)

const clock = (state: StepState, now: number) => {
  const m = minutes(state, now)
  return ` · ${m < 1 ? '<1m' : `${m}m`} of ${LIMIT}m${m >= WARN_AT ? `, times out in ${Math.max(0, LIMIT - m)}m` : ''}`
}

const count = (n: number) => `${n} finding${n === 1 ? '' : 's'}`

const STATUS: Record<Status, { glyph: string; color?: Color }> = {
  pending: { glyph: '·' },
  starting: { glyph: '▸', color: 'claude' },
  running: { glyph: '▸', color: 'claude' },
  fixing: { glyph: '▸', color: 'claude' },
  parked: { glyph: '!', color: 'warning' },
  passed: { glyph: '✓', color: 'success' },
  skipped: { glyph: '-' },
  failed: { glyph: '✗', color: 'error' },
}

function detail(state: StepState, { run, name, now }: Context): string {
  switch (state.status) {
    case 'pending':
      return ''
    case 'starting': {
      const command = name === 'test' || name === 'lint' ? run.commands[name] : undefined
      return (command === undefined ? 'starting' : `running ${command}`) + clock(state, now)
    }
    case 'running':
      return `${name === 'review' ? 'reviewer working' : name === 'ci' ? 'waiting on checks' : 'fixer working'}${state.reasked ? ', asked again for findings' : ''}${clock(state, now)}`
    case 'fixing':
      return `${isAutoRound(run, name) ? `auto-fixing (fix round ${state.round})` : `fix round ${state.round}`}${clock(state, now)}`
    case 'parked':
      return `${count(state.findings.length)}, ${state.findings.filter(isBlocking).length} blocking`
    case 'passed':
      return state.note ?? (state.findings.length === 0 ? 'no findings' : `${count(state.findings.length)}, none blocking`)
    case 'skipped':
      return state.reason
    case 'failed':
      return (state.reason.split('\n')[0] ?? '').replace(new RegExp(`^${name}: `), '').replace(/:$/, '')
  }
}

const ACTION: Record<Finding['action'], string> = { 'auto-fix': 'fixable', 'ask-user': 'your call', 'no-op': 'no action' }
const SEVERITY_COLOR: Record<Finding['severity'], Color> = { error: 'error', warning: 'warning', info: 'subtle' }
const OUTCOME_COLOR = { passed: 'success', failed: 'error', aborted: 'warning' } as const

type Row = { name: StepName; glyph: string; color?: Color; isCurrent: boolean; detail: string; more: string[]; href?: string }

type Choice = { id: string; hotkey?: string; isSelected: boolean; isBlocking: boolean; severity: Finding['severity']; action: string; where?: string; description: string }

type Board = {
  title: string
  intent: string
  worktree?: string
  rows: Row[]
  commits: string[]
  call?: { headline: string; choices: Choice[]; selected: number; roundsLeft: number }
  end?: { headline: string; color: Color; followUps: FollowUp[] }
}

function row(run: Run, name: StepName, now: number): Row {
  const state = run.steps[name]
  const prev = STEP_ORDER[STEP_ORDER.indexOf(name) - 1]
  const above = prev === undefined ? undefined : run.steps[prev]
  const base = { name, isCurrent: name === currentStep(run), more: [] as string[] }
  // A step still in flight has no last fact once the run ends; a parked one keeps its findings.
  if (run.outcome && (state.status === 'starting' || state.status === 'running' || state.status === 'fixing')) return { ...base, glyph: '-', detail: 'stopped' }
  const { glyph, color } = STATUS[state.status]
  const text = detail(state, { run, name, now })
  const isLate = 'startedAt' in state && minutes(state, now) >= WARN_AT
  const rest = state.status === 'failed' ? state.reason.split('\n').slice(1) : []
  const href = name === 'pr' && state.status === 'passed' ? run.prUrl : undefined
  return {
    ...base,
    glyph,
    color: isLate ? 'warning' : color,
    detail: state.status === 'skipped' && above?.status === 'skipped' && above.reason === state.reason ? '' : href === undefined ? text : text.replace(href, ''),
    more: rest.length > TAIL ? ['…', ...rest.slice(-TAIL)] : rest,
    href,
  }
}

function board(run: Run, selected: string[], now: number): Board {
  const current = currentStep(run)
  const state = current && !run.outcome ? run.steps[current] : undefined
  const choices = (findings: Finding[]): Choice[] =>
    findings.map((f, i) => ({
      id: f.id,
      hotkey: i < 9 ? String(i + 1) : undefined,
      isSelected: selected.includes(f.id),
      isBlocking: isBlocking(f),
      severity: f.severity,
      action: ACTION[f.action],
      where: f.file === undefined ? undefined : f.line === undefined ? f.file : `${f.file}:${f.line}`,
      description: f.description.split('\n')[0] ?? '',
    }))
  let call: Board['call']
  if (current && state?.status === 'parked') {
    const list = choices(state.findings)
    const roundsLeft = MAX_FIX_ROUNDS - fixRounds(run, current)
    call = {
      headline: `Parked at ${current} · ${roundsLeft > 0 ? `${roundsLeft} of ${MAX_FIX_ROUNDS} fix rounds left` : 'no fix rounds left'}`,
      choices: list,
      selected: list.filter(c => c.isSelected).length,
      roundsLeft,
    }
  }
  return {
    title: `${run.branch} → ${run.base}`,
    intent: run.intent.split('\n')[0] ?? '',
    worktree: run.outcome ? undefined : run.worktree,
    rows: STEP_ORDER.map(name => row(run, name, now)),
    commits: run.commits ? commitLines(run.commits) : [],
    call,
    end: run.outcome && { headline: `Run ${run.outcome}${current ? ` at ${current}` : ''}`, color: OUTCOME_COLOR[run.outcome], followUps: run.followUps ?? [] },
  }
}

const pressAndToast = (verdict: Verdict | 'abort') => () =>
  void press(verdict).then(pressed => {
    if (pressed.kind !== 'done') io().toast(pressed.kind === 'refused' ? pressed.reason : pressed.text)
  })

const runAtom = atom({ plugin: 'no-mistakes', key: 'run' } as const, null)
const selectedAtom = atom({ plugin: 'no-mistakes', key: 'selected' } as const, [])

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const run = await read($, runAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No run yet. Start one with /no-mistakes [intent].</Text>
        </Box>
      )
    }
    const b = board(run, await read($, selectedAtom), await $.clock.now())
    const { call, end } = b
    const showHint = e.surface === 'terminal' && !e.props.isFocused
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">{b.title}</Text>
          <Text dimColor wrap="truncate-end">
            {b.intent}
          </Text>
          {b.worktree && (
            <Text dimColor wrap="truncate-middle">
              {b.worktree}
            </Text>
          )}
        </Box>
        <Box flexDirection="column">
          {b.rows.map(r => (
            <Box key={r.name} flexDirection="column">
              <Box>
                <Text color={r.color} dimColor={r.color === undefined} weight={r.isCurrent ? 'semibold' : undefined} wrap="truncate-end">
                  {r.glyph} {r.name.padEnd(8)} {r.detail}
                </Text>
                {r.href !== undefined && <Link href={r.href} label={r.href} />}
              </Box>
              {r.more.length > 0 && (
                <Box flexDirection="column" paddingLeft={11}>
                  {r.more.map((line, i) => (
                    <Text key={`${i}`} dimColor>
                      {line}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          ))}
        </Box>
        {b.commits.length > 0 && (
          <Box flexDirection="column">
            <Text weight="semibold">Commits no-mistakes added</Text>
            {b.commits.map(line => (
              <Text key={line} dimColor wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        )}
        {call && (
          <Box flexDirection="column">
            <Text color="warning">{call.headline}</Text>
            {call.choices.map(c => (
              <Button key={`toggle:${c.id}`} plain hotkey={c.hotkey} dimColor={!c.isBlocking} onPress={() => void toggle(c.id)}>
                {c.isSelected ? '[x]' : '[ ]'} <Text color={SEVERITY_COLOR[c.severity]}>{c.severity.padEnd(7)}</Text> <Text dimColor>{c.action}</Text>
                {c.where !== undefined && <Text color="subtle"> {c.where}</Text>} {c.description}
              </Button>
            ))}
          </Box>
        )}
        {!end && (
          <Box flexDirection="column">
            <Box gap={2} flexWrap="wrap">
              {call && (
                <>
                  <Button key="fix" plain hotkey="f" variant="primary" dimColor={call.selected === 0 || call.roundsLeft === 0} label={call.roundsLeft === 0 ? 'Fix selected (no rounds left)' : `Fix selected (${call.selected})`} onPress={pressAndToast('fix')} />
                  <Button key="approve" plain hotkey="a" label="Approve" onPress={pressAndToast('approve')} />
                  <Button key="skip" plain hotkey="s" label="Skip step" onPress={pressAndToast('skip')} />
                </>
              )}
              <Button key="abort" plain hotkey="x" label="Abort" onPress={pressAndToast('abort')} />
            </Box>
            {showHint && <Text dimColor>Keys work after ctrl+x tab focuses the pane.</Text>}
          </Box>
        )}
        {end && (
          <Box flexDirection="column">
            <Text color={end.color}>{end.headline}</Text>
            {end.followUps.map(f => (
              <Box key={f.text} flexDirection="column">
                <Text>{f.text}</Text>
                {f.command !== undefined && (
                  <Box paddingLeft={2}>
                    <Text color="claude">{f.command}</Text>
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
