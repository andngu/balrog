// The pane's fire: a balrog rising out of flame, packed as a Raster's cells.
// Every cell is two pixels, the upper half block's foreground over its
// background, so a six-row Raster is twelve pixels tall.

export type Fire = { frame: number | 'embers'; columns: number; rows: number }

export const FIRE_ROWS = 6
export const BANKED_ROWS = 2
export const FIRE_MS = 100
const MIN_COLUMNS = 30
// The widest Raster the host draws.
const MAX_COLUMNS = 512
const ENTRANCE = 10

export const fireColumns = (bodyColumns: number): number | undefined => (bodyColumns < MIN_COLUMNS ? undefined : Math.min(bodyColumns, MAX_COLUMNS))

// `#` body, `o` eye, `w` the whip.
const BALROG = [
  '#.............#.......#.............#',
  '##.............#.....#.............##',
  '###.............#...#.............###',
  '.####...........#####...........####.',
  '..#####.........#o#o#.........#####..',
  '..########......#####......########..',
  '...##########..#######..##########...',
  '...#..#..###.###########.###..#..#...',
  '.........#....#########....#w........',
  '...............#######......w........',
  '..............###...###......w.......',
  '.............####...####.....wwwww...',
]

const NONE = 0x01000000
const BODY = 0x140c0a
const EYE = 0xffd27a
const WHIP = 0x6b1a0a
const HEAT = [0x7c2d12, 0x9a3412, 0xc2410c, 0xea580c, 0xf97316, 0xfdba4d, 0xfde68a, 0xfff1b8]
const EMBER = [0x3b1308, 0x5a1d0c, 0x7c2d12]
const SPARK = 0xfdba4d
const UPPER_HALF = 0x2580
const LOWER_HALF = 0x2584
const SPACE = 0x20

const hash = (a: number, b: number, c: number): number => {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000
}

// Smooth over three columns and two frames, so the tongues sway rather than strobe.
const sway = (x: number, frame: number): number => {
  const at = (cx: number, cf: number) => hash(cx, cf, 7)
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const cx = Math.floor(x / 3)
  const tx = (x % 3) / 3
  const cf = Math.floor(frame / 2)
  const tf = (frame % 2) / 2
  return lerp(lerp(at(cx, cf), at(cx + 1, cf), tx), lerp(at(cx, cf + 1), at(cx + 1, cf + 1), tx), tf)
}

function flames(pixels: number[][], frame: number, center: number, tall: boolean): void {
  const height = pixels.length
  const width = pixels[0]!.length
  const grown = Math.min(1, (frame + 1) / ENTRANCE)
  const half = (BALROG[0]!.length >> 1) + 10
  for (let x = 0; x < width; x++) {
    const near = tall ? Math.max(0, 1 - Math.abs(x - center) / half) : 0
    const tongue = grown * height * (0.3 + 0.45 * sway(x, frame) + 1.6 * near)
    for (let y = 0; y < height; y++) {
      const depth = height - 1 - y
      if (depth < tongue) {
        const heat = 1 - depth / tongue + (hash(x, y, frame) - 0.5) * 0.3
        pixels[y]![x] = HEAT[Math.max(0, Math.min(HEAT.length - 1, Math.floor(heat * HEAT.length)))]!
      } else if (hash(x, y + frame, 3) < 0.025) {
        pixels[y]![x] = SPARK
      }
    }
  }
}

function figure(pixels: number[][], frame: number, center: number): void {
  const height = pixels.length
  const left = center - (BALROG[0]!.length >> 1)
  const sunk = Math.max(0, Math.round(height * (1 - frame / ENTRANCE)))
  const top = height - BALROG.length + sunk
  BALROG.forEach((line, row) => {
    const y = top + row
    if (y < 0 || y >= height) return
    for (let col = 0; col < line.length; col++) {
      const x = left + col
      const color = { '#': BODY, o: EYE, w: WHIP }[line[col]!]
      if (color !== undefined && x >= 0 && x < pixels[y]!.length) pixels[y]![x] = color
    }
  })
}

function embers(pixels: number[][]): void {
  const height = pixels.length
  pixels.forEach((line, y) =>
    line.forEach((_, x) => {
      const depth = height - 1 - y
      const roll = hash(x, y, 11)
      if (depth === 0 ? roll < 0.45 : depth === 1 && roll < 0.12) line[x] = EMBER[Math.floor(hash(x, y, 13) * EMBER.length)]!
    }),
  )
}

function picture(fire: Fire): number[][] {
  const pixels = Array.from({ length: fire.rows * 2 }, () => new Array<number>(fire.columns).fill(NONE))
  const center = fire.columns >> 1
  if (fire.frame === 'embers') {
    embers(pixels)
    return pixels
  }
  const tall = fire.rows * 2 >= BALROG.length
  flames(pixels, fire.frame, center, tall)
  if (tall) figure(pixels, fire.frame, center)
  return pixels
}

export function cells(fire: Fire): string {
  const pixels = picture(fire)
  const words = new Uint32Array(fire.columns * fire.rows * 3)
  for (let row = 0; row < fire.rows; row++) {
    for (let x = 0; x < fire.columns; x++) {
      const top = pixels[row * 2]![x]!
      const bottom = pixels[row * 2 + 1]![x]!
      const at = (row * fire.columns + x) * 3
      if (top === NONE && bottom === NONE) words.set([SPACE, NONE, NONE], at)
      else if (top === NONE) words.set([LOWER_HALF, bottom, NONE], at)
      else words.set([UPPER_HALF, top, bottom], at)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
