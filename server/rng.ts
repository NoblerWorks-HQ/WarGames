/** Seeded random numbers, so a game's dice can be replayed exactly. */

/** A die source whose position can be saved and restored, so a loaded game keeps rolling the same stream. */
export type SeededRng = (() => number) & { getState(): number; setState(s: number): void }

/** mulberry32: a tiny, fast PRNG with a 32-bit state. Returns floats in [0, 1) like Math.random. */
export function mulberry32(seed: number): SeededRng {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return Object.assign(next, {
    getState: () => a,
    setState: (s: number) => {
      a = s >>> 0
    },
  })
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 4294967296) >>> 0
}

/** Parse a SEED env value. Integers are used as-is; any other text is hashed (FNV-1a), so SEED=banana works. */
export function parseSeed(value: string | undefined): number | undefined {
  const v = value?.trim()
  if (!v) return undefined
  if (/^\d+$/.test(v) && Number(v) < 4294967296) return Number(v)
  let h = 2166136261
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
