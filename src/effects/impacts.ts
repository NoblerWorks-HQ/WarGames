import * as L from 'leaflet'
import type { EffectHost, LatLng } from './types.js'
import { triggerCombatScreenEffects, triggerNukeScreenEffects } from './screen.js'

// Anything with a movable position (L.Marker, L.CircleMarker)
interface Positioned {
  getLatLng(): L.LatLng
  setLatLng(latlng: L.LatLngExpression): unknown
}

// Animate marker smoothly to new position
function animateMarker(marker: Positioned, targetLat: number, targetLon: number, duration: number) {
  const start = marker.getLatLng()
  const startTime = performance.now()
  const dlat = targetLat - start.lat
  const dlon = targetLon - start.lng
  if (Math.abs(dlat) < 0.001 && Math.abs(dlon) < 0.001) return

  function step(now: number) {
    const t = Math.min((now - startTime) / duration, 1)
    const ease = 1 - Math.pow(1 - t, 3)
    marker.setLatLng([start.lat + dlat * ease, start.lng + dlon * ease])
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ☢️ Nuke impact - shockwave rings, flash and screen effects
export function spawnNukeBlast(host: EffectHost, pos: LatLng) {
  // Expanding shockwave ring
  const ring = L.circleMarker(pos, {
    radius: 20,
    color: '#ff4400',
    fillColor: '#ff8800',
    fillOpacity: 0.4,
    weight: 3,
    opacity: 1
  }).addTo(host.layer)

  // Bright flash
  const flash = L.circleMarker(pos, {
    radius: 40,
    color: '#ffffff',
    fillColor: '#ffffff',
    fillOpacity: 0.8,
    weight: 0
  }).addTo(host.layer)

  // Second shockwave ring (delayed, larger)
  const ring2 = L.circleMarker(pos, {
    radius: 10,
    color: '#ffaa00',
    fillColor: '#ff4400',
    fillOpacity: 0.2,
    weight: 2,
    opacity: 0.8
  }).addTo(host.layer)

  host.addBlast({
    ring,
    flash,
    startTime: host.frame()
  })

  // Delayed second ring
  setTimeout(() => {
    host.addBlast({
      ring: ring2,
      flash: L.circleMarker(pos, { radius: 0, opacity: 0, fillOpacity: 0 }).addTo(host.layer),
      startTime: host.frame()
    })
  }, 200)

  // Trigger screen-level effects
  triggerNukeScreenEffects()
}

// ⚔️ Combat impact - smaller shockwave, sparks, subtle screen flash and shake
export function spawnCombatImpact(host: EffectHost, pos: LatLng, color: string) {
  // Expanding shockwave ring - smaller than nuke
  const ring = L.circleMarker(pos, {
    radius: 10,
    color,
    fillColor: color,
    fillOpacity: 0.3,
    weight: 2,
    opacity: 1
  }).addTo(host.layer)

  // Brief bright flash
  const flash = L.circleMarker(pos, {
    radius: 20,
    color: '#ffffff',
    fillColor: '#ffffff',
    fillOpacity: 0.6,
    weight: 0
  }).addTo(host.layer)

  host.addBlast({
    ring,
    flash,
    startTime: host.frame()
  })

  triggerCombatScreenEffects()

  // Spark particles - small dots that fly outward
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.random() * 0.5
    const spark = L.circleMarker(pos, {
      radius: 3,
      color,
      fillColor: color,
      fillOpacity: 0.9,
      weight: 0
    }).addTo(host.layer)

    const dist = 3 + Math.random() * 2
    const targetLat = pos[0] + Math.cos(angle) * dist
    const targetLng = pos[1] + Math.sin(angle) * dist
    animateMarker(spark, targetLat, targetLng, 400)
    setTimeout(() => {
      try { host.layer.removeLayer(spark) } catch { /* already removed */ }
    }, 500)
  }
}

// 🚩 Capture impact - faction-colored double ring pulse
export function spawnCaptureImpact(host: EffectHost, pos: LatLng, color: string) {
  // Faction-colored expanding ring pulse
  const ring = L.circleMarker(pos, {
    radius: 8,
    color,
    fillColor: color,
    fillOpacity: 0.2,
    weight: 2,
    opacity: 0.9
  }).addTo(host.layer)

  // Second ring, slightly delayed
  const ring2 = L.circleMarker(pos, {
    radius: 5,
    color,
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 1.5,
    opacity: 0.6
  }).addTo(host.layer)

  host.addBlast({
    ring,
    flash: ring2,
    startTime: host.frame()
  })
}
