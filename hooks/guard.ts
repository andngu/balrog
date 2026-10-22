import type { Commands } from '../types'

export type Stat = (path: string) => Promise<{ realPath?: string }>

// An entry that exists but resolves nowhere (a dangling link) cannot be placed: a Write through it lands wherever the link points.
async function placed(path: string, stat: Stat): Promise<string | undefined> {
  if (!path.startsWith('/')) return undefined
  const parts = path.split('/').slice(1)
  if (parts[parts.length - 1] === '') return undefined
  const tail: string[] = []
  for (let n = parts.length; n > 0; n--) {
    const own = await stat(`/${parts.slice(0, n).join('/')}`).catch(() => undefined)
    if (own) {
      if (own.realPath === undefined || tail.some(t => t === '' || t === '.' || t === '..')) return undefined
      return [own.realPath.replace(/\/$/, ''), ...tail].join('/')
    }
    tail.unshift(parts[n - 1]!)
  }
  return undefined
}

type Placement = { where: 'inside'; relative: string } | { where: 'git' } | { where: 'outside' }

async function placement(path: string, worktree: string, stat: Stat): Promise<Placement> {
  const root = (await stat(worktree).catch(() => undefined))?.realPath?.replace(/\/$/, '')
  const real = await placed(path, stat)
  if (root === undefined || real === undefined) return { where: 'outside' }
  if (real === root) return { where: 'inside', relative: '' }
  if (!real.startsWith(`${root}/`)) return { where: 'outside' }
  const relative = real.slice(root.length + 1)
  // A case-insensitive file system folds `.GIT` onto `.git`, so the match ignores case.
  return relative.split('/').some(part => part.toLowerCase() === '.git') ? { where: 'git' } : { where: 'inside', relative }
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

function pathOf(tool: string, input: Record<string, unknown>): string | undefined {
  const value = tool === 'NotebookEdit' ? input.notebook_path : tool === 'Grep' || tool === 'Glob' ? input.path : input.file_path
  return typeof value === 'string' ? value : undefined
}

// A Glob pattern that is absolute or climbs is searched from wherever it names, not under `path`.
const escapes = (pattern: unknown) => typeof pattern !== 'string' || /^[/~]/.test(pattern) || pattern.split(/[/\\]/).includes('..')

const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

export function allowedCommands(worktree: string, commands: Commands): string[] {
  return (['test', 'lint', 'format'] as const).flatMap(name => (commands[name] === undefined ? [] : [`cd ${quoted(worktree)} && ${commands[name]}`]))
}

export type Call = { tool: string; input: Record<string, unknown> }

export function asCall(e: { tool: string; input?: unknown; [k: string]: unknown }): Call {
  const input = typeof e.input === 'object' && e.input !== null ? (e.input as Record<string, unknown>) : e
  return { tool: e.tool, input }
}

async function fileVerdict({ tool, input }: Call, worktree: string, stat: Stat): Promise<{ deny: string } | { relative: string }> {
  const path = pathOf(tool, input)
  if (path === undefined) return { deny: `${tool} needs an absolute path under the worktree ${worktree}` }
  if (tool === 'Glob' && escapes(input.pattern)) return { deny: `the Glob pattern must be relative to the path and stay under it, without .. or a leading / or ~` }
  const at = await placement(path, worktree, stat)
  if (at.where === 'git') return { deny: `${path} is a .git entry of the worktree` }
  if (at.where === 'outside') return { deny: `${path} is outside the worktree ${worktree}` }
  return { relative: at.relative }
}

export async function isAllowed(call: Call, worktree: string, commands: Commands, stat: Stat): Promise<boolean> {
  if (call.tool !== 'Bash' && !WRITE_TOOLS.has(call.tool) && !READ_TOOLS.has(call.tool)) return false
  return (await judge(call, worktree, commands, stat)) === undefined
}

export async function judge(call: Call, worktree: string, commands: Commands, stat: Stat): Promise<string | undefined> {
  if (call.tool === 'Bash') {
    const command = typeof call.input.command === 'string' ? call.input.command.trim() : ''
    const allowed = allowedCommands(worktree, commands)
    if (allowed.includes(command)) return undefined
    return allowed.length === 0 ? 'no shell command is configured for this run; edit files with Edit and Write instead' : `the shell runs only the configured commands here: ${allowed.map(quoted).join(', ')}`
  }
  if (!WRITE_TOOLS.has(call.tool) && !READ_TOOLS.has(call.tool)) return undefined
  const verdict = await fileVerdict(call, worktree, stat)
  return 'deny' in verdict ? verdict.deny : undefined
}

export async function writtenPath(call: Call, worktree: string, stat: Stat): Promise<string | undefined> {
  if (!WRITE_TOOLS.has(call.tool)) return undefined
  const verdict = await fileVerdict(call, worktree, stat)
  return 'relative' in verdict && verdict.relative !== '' ? verdict.relative : undefined
}
