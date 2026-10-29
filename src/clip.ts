// Splitting the GeoJSON "United States of America" feature into the game's three US territories:
// Alaska, US West and US East. Dependency-free; Sutherland-Hodgman against a vertical line.

export type Ring = number[][] // [lng, lat] points, first == last
type Polygon = Ring[] // outer ring, then holes

/** Where the lower 48 splits: the longitude between the game's US (West) point (-120) and US (East) point (-80). */
export const US_SPLIT_LNG = -98

/** Keep the part of an open vertex list on one side of x = lng (inclusive). */
function clipSide(pts: number[][], lng: number, keepWest: boolean): number[][] {
  const inside = (p: number[]) => (keepWest ? p[0] <= lng : p[0] >= lng)
  const out: number[][] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    if (inside(a)) out.push(a)
    if (inside(a) !== inside(b)) out.push([lng, a[1] + ((lng - a[0]) / (b[0] - a[0])) * (b[1] - a[1])])
  }
  return out
}

/** Cut a closed ring at x = lng. A side the ring never reaches comes back as []. */
export function clipRingAtLng(ring: Ring, lng: number): { west: Ring; east: Ring } {
  const pts = ring.slice(0, -1)
  const close = (p: number[][]): Ring => (p.length < 3 ? [] : [...p, p[0]])
  return { west: close(clipSide(pts, lng, true)), east: close(clipSide(pts, lng, false)) }
}

function clipPolygon(poly: Polygon, lng: number): { west: Polygon | null; east: Polygon | null } {
  const rings = poly.map(r => clipRingAtLng(r, lng))
  const pick = (side: 'west' | 'east') => (rings[0][side].length ? rings.map(r => r[side]).filter(r => r.length) : null)
  return { west: pick('west'), east: pick('east') }
}

/** Alaska's polygons (mainland and islands) sit north of every lower-48 and Hawaiian point. */
function isAlaska(poly: Polygon): boolean {
  const outer = poly[0]
  return outer.reduce((s, c) => s + c[1], 0) / outer.length > 51
}

export function splitUnitedStates(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): { alaska: Polygon[]; western: Polygon[]; eastern: Polygon[] } {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
  const parts = { alaska: [] as Polygon[], western: [] as Polygon[], eastern: [] as Polygon[] }
  for (const poly of polys) {
    if (isAlaska(poly)) {
      parts.alaska.push(poly)
      continue
    }
    const { west, east } = clipPolygon(poly, US_SPLIT_LNG)
    if (west) parts.western.push(west)
    if (east) parts.eastern.push(east)
  }
  return parts
}
