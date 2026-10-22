// Warp an asciinema cast's time so a recorded run fits a short gif: the stretches where
// nothing a viewer needs happens run at 30x, and a window around the start, each park,
// the press that answers it, and the end runs at 1x. Every event is kept, so the
// terminal state stays whole; only the timestamps move.
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('usage: demo-warp.mjs <in.cast> <out.cast>')
  process.exit(2)
}

const FAST = 30
const LEAD = 20 // seconds at 1x from the start: the command, the fire rising, the first steps
const BEFORE = 4 // seconds at 1x before a marker
const AFTER = 14 // seconds at 1x after a marker: the park's findings, the press, the fixer starting
const TAIL = 12 // seconds at 1x before the last event
const MARKERS = [/Parked at /, /\/balrog-fix/, /\/balrog-approve/, /Run (passed|failed|aborted)/]

const lines = readFileSync(input, 'utf8').split('\n').filter(Boolean)
const header = lines[0]
const events = lines.slice(1).map(line => JSON.parse(line))
const last = events.at(-1)?.[0] ?? 0

const slow = [[0, LEAD], [Math.max(0, last - TAIL), last]]
for (const [time, kind, data] of events) {
  if (kind === 'o' && MARKERS.some(m => m.test(data))) slow.push([time - BEFORE, time + AFTER])
}
slow.sort((a, b) => a[0] - b[0])
const isSlow = t => slow.some(([from, to]) => t >= from && t <= to)

let prev = 0
let warped = 0
const out = [header]
for (const event of events) {
  const [time, kind, data] = event
  const delta = time - prev
  warped += isSlow(time) ? delta : delta / FAST
  prev = time
  out.push(JSON.stringify([Number(warped.toFixed(3)), kind, data]))
}
writeFileSync(output, out.join('\n') + '\n')
console.log(`warped ${last.toFixed(0)} s to ${warped.toFixed(0)} s across ${events.length} events, ${slow.length} slow windows`)
