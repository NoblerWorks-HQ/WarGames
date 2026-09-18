import type * as L from 'leaflet'

export type LatLng = [number, number]

// An expanding ring + flash pair, animated by FlatMap's blast loop.
export interface NukeBlast {
  ring: L.CircleMarker
  flash: L.CircleMarker
  startTime: number
}

// A self-contained in-place animation. FlatMap calls update(t) every frame
// with t in 0..1, then removes `elements` from the layer once it has run.
export interface LocalEffect {
  elements: (L.CircleMarker | L.Marker)[]
  startTime: number
  duration: number  // frames
  type: string
  update: (t: number) => void  // 0-1 progress
}

// What an effect needs from the map that hosts it. FlatMap implements this;
// effects never reach into FlatMap itself.
export interface EffectHost {
  // Layer every effect element is added to
  readonly layer: L.LayerGroup
  // Current animation frame, read when an effect starts
  frame(): number
  addBlast(blast: NukeBlast): void
  addEffect(effect: LocalEffect): void
}
