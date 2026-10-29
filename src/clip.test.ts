import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipRingAtLng, splitUnitedStates, type Ring } from './clip.js'

const area = (ring: Ring) => {
  let a = 0
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  return Math.abs(a / 2)
}
const square: Ring = [[-1, 0], [1, 0], [1, 2], [-1, 2], [-1, 0]]

describe('clipRingAtLng', () => {
  it('cuts a square at x=0 into two halves of equal area', () => {
    const { west, east } = clipRingAtLng(square, 0)
    expect(area(west)).toBeCloseTo(2)
    expect(area(east)).toBeCloseTo(2)
    expect(Math.max(...west.map(p => p[0]))).toBe(0)
    expect(Math.min(...east.map(p => p[0]))).toBe(0)
  })
  it('cuts off-centre and returns closed rings', () => {
    const { west, east } = clipRingAtLng(square, 0.5)
    expect(area(west)).toBeCloseTo(3)
    expect(area(east)).toBeCloseTo(1)
    expect(west[0]).toEqual(west[west.length - 1])
  })
  it('gives an empty side when the ring does not reach the line', () => {
    expect(clipRingAtLng(square, 5).east).toEqual([])
    expect(area(clipRingAtLng(square, 5).west)).toBeCloseTo(4)
  })
})

describe('splitUnitedStates', () => {
  const geo = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'countryborders.json'), 'utf8'))
  const us = geo.features.find((f: { properties: { name: string } }) => f.properties.name === 'United States of America')
  const parts = splitUnitedStates(us.geometry)
  const lngs = (polys: number[][][][]) => polys.flatMap(p => p[0].map(c => c[0]))
  const lats = (polys: number[][][][]) => polys.flatMap(p => p[0].map(c => c[1]))

  it('identifies the four Alaska polygons (mainland and islands) and nothing else', () => {
    expect(parts.alaska).toHaveLength(4)
    expect(Math.min(...lats(parts.alaska))).toBeGreaterThan(51)
    expect(Math.max(...lats(parts.alaska))).toBeGreaterThan(70)
  })
  it('splits the lower 48 at -98, with Hawaii on the west side', () => {
    expect(Math.max(...lngs(parts.western))).toBeLessThanOrEqual(-98)
    expect(Math.min(...lngs(parts.eastern))).toBeGreaterThanOrEqual(-98)
    expect(Math.min(...lats(parts.western))).toBeLessThan(20) // Hawaii
    expect(parts.western.length).toBeGreaterThan(5) // 5 Hawaiian islands + the west half
    expect(parts.eastern).toHaveLength(1)
  })
  it('loses and invents no polygons: every input polygon lands in one place, the lower 48 in two', () => {
    expect(us.geometry.coordinates).toHaveLength(10)
    expect(parts.alaska.length + parts.western.length + parts.eastern.length).toBe(4 + 5 + 2)
  })
})
