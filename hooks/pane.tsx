import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { Finding, StepName, StepState } from '../types'
import { press, toggle } from './engine'
import { currentStep, PANE, STEP_ORDER } from './run'

const GLYPH: Record<StepState['status'], string> = {
  pending: ' ',
  starting: '~',
  running: '~',
  fixing: '~',
  parked: '!',
  passed: 'x',
  skipped: '-',
  failed: 'X',
}

const COLOR: Partial<Record<StepState['status'], string>> = {
  starting: 'claude',
  running: 'claude',
  fixing: 'claude',
  parked: 'warning',
  passed: 'success',
  failed: 'error',
}

function detail(state: StepState): string {
  switch (state.status) {
    case 'passed':
      return state.note ?? ''
    case 'skipped':
      return state.reason
    case 'failed':
      return state.reason.split('\n')[0] ?? ''
    case 'parked':
      return `${state.findings.length} finding(s) await your call`
    case 'fixing':
      return `fix round ${state.round}`
    default:
      return ''
  }
}

const SEVERITY_COLOR: Record<Finding['severity'], string> = { error: 'error', warning: 'warning', info: 'subtle' }

const runAtom = atom({ plugin: 'no-mistakes', key: 'run' } as const, null)
const selectedAtom = atom({ plugin: 'no-mistakes', key: 'selected' } as const, [])

export function registerPane(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run = await read($, runAtom)
    const selected = await read($, selectedAtom)
    if (!run) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No run yet. Start one with /no-mistakes [intent].</Text>
        </Box>
      )
    }
    const current = currentStep(run)
    const parked = current && run.steps[current].status === 'parked' ? run.steps[current] : undefined
    const findings = parked && parked.status === 'parked' ? parked.findings : []
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>
            {run.branch} → {run.base} <Text dimColor>({run.id})</Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {run.intent.split('\n')[0]}
          </Text>
        </Box>
        <Box flexDirection="column">
          {STEP_ORDER.map((name: StepName) => {
            const state = run.steps[name]
            return (
              <Text key={name} color={COLOR[state.status]} dimColor={state.status === 'pending' || state.status === 'skipped'}>
                [{GLYPH[state.status]}] {name.padEnd(8)} {detail(state)}
              </Text>
            )
          })}
        </Box>
        {run.commits && (
          <Box flexDirection="column">
            <Text bold>Commits no-mistakes added</Text>
            <Text dimColor>{run.commits}</Text>
          </Box>
        )}
        {parked && current && (
          <Box flexDirection="column">
            <Text bold>Parked at {current}. Toggle findings, then choose:</Text>
            {findings.map(f => (
              <Button key={`toggle:${f.id}`} plain onPress={() => void toggle(f.id)}>
                {selected.includes(f.id) ? '[x]' : '[ ]'} {f.id} <Text color={SEVERITY_COLOR[f.severity]}>{f.severity}</Text>
                {f.action === 'ask-user' ? ' (your call)' : ''} {f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}
                {f.description}
              </Button>
            ))}
            <Box gap={1}>
              <Button key="fix" hotkey="f" variant="primary" label="Fix selected" onPress={() => void press('fix')} />
              <Button key="approve" hotkey="a" label="Approve and continue" onPress={() => void press('approve')} />
              <Button key="skip" hotkey="s" label="Skip step" onPress={() => void press('skip')} />
            </Box>
          </Box>
        )}
        {!run.outcome && (
          <Box>
            <Button key="abort" hotkey="x" label="Abort" onPress={() => void press('abort')} />
          </Box>
        )}
        {run.outcome && (
          <Text color={run.outcome === 'passed' ? 'success' : run.outcome === 'failed' ? 'error' : 'warning'}>
            Run {run.outcome}: {run.note}
          </Text>
        )}
        {run.prUrl && <Text>PR: {run.prUrl}</Text>}
      </Box>
    )
  })
}
