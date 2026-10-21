import type { Commands } from '../types'

export type Stat = (path: string) => Promise<{ realPath?: string }>

// Where a path lands once every link and `..` is resolved, or undefined when
// it cannot be placed. A path whose tail does not exist yet (Write creates
// parents) is placed by its first existing ancestor plus the plain tail. An
// entry that exists but resolves nowhere (a dangling link) cannot be placed:
// a Write through it lands wherever the link points.
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

// `inside` carries the path relative to the worktree. `git`: at or under a
// `.git` entry of the worktree, in any letter case (a case-insensitive file
// system folds `.GIT` onto it), the one place inside it an agent must never
// touch (a rewritten gitdir redirects the mod's own git).
type Placement = { where: 'inside'; relative: string } | { where: 'git' } | { where: 'outside' }

async function placement(path: string, worktree: string, stat: Stat): Promise<Placement> {
  const root = (await stat(worktree).catch(() => undefined))?.realPath?.replace(/\/$/, '')
  const real = await placed(path, stat)
  if (root === undefined || real === undefined) return { where: 'outside' }
  if (real === root) return { where: 'inside', relative: '' }
  if (!real.startsWith(`${root}/`)) return { where: 'outside' }
  const relative = real.slice(root.length + 1)
  return relative.split('/').some(part => part.toLowerCase() === '.git') ? { where: 'git' } : { where: 'inside', relative }
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])

function pathOf(tool: string, input: Record<string, unknown>): string | undefined {
  const value = tool === 'NotebookEdit' ? input.notebook_path : tool === 'Grep' || tool === 'Glob' ? input.path : input.file_path
  return typeof value === 'string' ? value : undefined
}

// A Glob pattern that is absolute or climbs is a path of its own, searched
// from wherever it names rather than under `path`.
const escapes = (pattern: unknown) => typeof pattern !== 'string' || /^[/~]/.test(pattern) || pattern.split(/[/\\]/).includes('..')

const quoted = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

// The whole shell an agent gets: each configured command, spelled exactly so,
// from the worktree. `prepare` is the mod's alone.
export function allowedCommands(worktree: string, commands: Commands): string[] {
  return (['test', 'lint', 'format'] as const).flatMap(name => (commands[name] === undefined ? [] : [`cd ${quoted(worktree)} && ${commands[name]}`]))
}

export type Call = { tool: string; input: Record<string, unknown> }

export function asCall(e: { tool: string; input?: unknown; [k: string]: unknown }): Call {
  const input = typeof e.input === 'object' && e.input !== null ? (e.input as Record<string, unknown>) : e
  return { tool: e.tool, input }
}

// What a run agent's file call reaches: every read and every write stays
// inside the worktree, never at its .git.
async function fileVerdict({ tool, input }: Call, worktree: string, stat: Stat): Promise<{ deny: string } | { relative: string }> {
  const path = pathOf(tool, input)
  if (path === undefined) return { deny: `${tool} needs an absolute path under the worktree ${worktree}` }
  if (tool === 'Glob' && escapes(input.pattern)) return { deny: `the Glob pattern must be relative to the path and stay under it, without .. or a leading / or ~` }
  const at = await placement(path, worktree, stat)
  if (at.where === 'git') return { deny: `${path} is a .git entry of the worktree` }
  if (at.where === 'outside') return { deny: `${path} is outside the worktree ${worktree}` }
  return { relative: at.relative }
}

// The allow half, at tool.check: what a run agent may do without a permission
// ask. Everything else keeps the engine's own verdict.
export async function isAllowed(call: Call, worktree: string, commands: Commands, stat: Stat): Promise<boolean> {
  if (call.tool !== 'Bash' && !WRITE_TOOLS.has(call.tool) && !READ_TOOLS.has(call.tool)) return false
  return (await judge(call, worktree, commands, stat)) === undefined
}

// The deny half, at tool.call: what no rule of the user's may let a run agent
// do. Any file call outside the worktree or at its `.git`, any shell command
// that is not one of the configured ones.
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

// The worktree-relative path a run agent's allowed write creates or changes:
// the mod commits untracked files only when an agent wrote them, so residue
// a command leaves (node_modules, coverage) never lands in a commit.
export async function writtenPath(call: Call, worktree: string, stat: Stat): Promise<string | undefined> {
  if (!WRITE_TOOLS.has(call.tool)) return undefined
  const verdict = await fileVerdict(call, worktree, stat)
  return 'relative' in verdict && verdict.relative !== '' ? verdict.relative : undefined
}
