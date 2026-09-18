import * as L from 'leaflet'
import type { EffectHost, LatLng } from './types.js'
import { triggerBetrayalScreenEffect, triggerBuildNukeScreenEffect } from './screen.js'

// In-place effects for events that happen at one territory (no arc).
// Each spawns its elements on host.layer and registers a LocalEffect.

// Spawn the local effect for an event type, if it has one.
export function spawnLocalEffect(host: EffectHost, type: string, pos: LatLng, factionColor: string) {
switch (type) {
  case 'fortify': spawnFortifyEffect(host, pos, factionColor); break
  case 'recruit': spawnRecruitEffect(host, pos, factionColor); break
  case 'build_nuke': spawnBuildNukeEffect(host, pos); break
  case 'spy': spawnSpyEffect(host, pos); break
  case 'research': spawnResearchEffect(host, pos); break
  case 'hire_mercenary': spawnHireMercenaryEffect(host, pos); break
  case 'betrayal': spawnBetrayalEffect(host, pos); break
}
}

// 🛡️ Fortify - 3 concentric shield rings that solidify
export function spawnFortifyEffect(host: EffectHost, pos: LatLng, color: string) {
  const elements: L.CircleMarker[] = []
  const rings: L.CircleMarker[] = []
  for (let i = 0; i < 3; i++) {
    const ring = L.circleMarker(pos, {
      radius: 6 + i * 6,
      color,
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 2,
      opacity: 0,
      dashArray: '4, 4'
    }).addTo(host.layer)
    rings.push(ring)
    elements.push(ring)
  }

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 90,
    type: 'fortify',
    update: (t: number) => {
      for (let i = 0; i < rings.length; i++) {
        const delay = i * 0.15
        const localT = Math.max(0, Math.min(1, (t - delay) / (1 - delay)))
        const ease = 1 - Math.pow(1 - localT, 3)
        const targetRadius = 8 + i * 7
        const currentRadius = targetRadius * 0.5 + targetRadius * 0.5 * ease
        rings[i].setRadius(currentRadius)
        // Solidify: dashes fade to solid, opacity rises then holds
        const fadeOut = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1
        rings[i].setStyle({
          opacity: ease * 0.9 * fadeOut,
          weight: 1.5 + ease * 1.5,
          dashArray: localT > 0.6 ? undefined : '4, 4'
        })
      }
    }
  })
}

// ⚔️ Recruit - faction burst with particles assembling inward
export function spawnRecruitEffect(host: EffectHost, pos: LatLng, color: string) {
  const elements: (L.CircleMarker | L.Marker)[] = []

  // Central flash
  const flash = L.circleMarker(pos, {
    radius: 2,
    color: '#ffffff',
    fillColor: '#ffffff',
    fillOpacity: 0.9,
    weight: 0
  }).addTo(host.layer)
  elements.push(flash)

  // Outer ring burst
  const ring = L.circleMarker(pos, {
    radius: 3,
    color,
    fillColor: color,
    fillOpacity: 0.3,
    weight: 2,
    opacity: 0.8
  }).addTo(host.layer)
  elements.push(ring)

  // 4 particles that fly inward
  const particles: { marker: L.CircleMarker; startLat: number; startLng: number }[] = []
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2
    const dist = 4
    const startLat = pos[0] + Math.cos(angle) * dist
    const startLng = pos[1] + Math.sin(angle) * dist
    const p = L.circleMarker([startLat, startLng], {
      radius: 3,
      color,
      fillColor: color,
      fillOpacity: 0.8,
      weight: 0
    }).addTo(host.layer)
    particles.push({ marker: p, startLat, startLng })
    elements.push(p)
  }

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 60,
    type: 'recruit',
    update: (t: number) => {
      // Particles fly inward
      for (const p of particles) {
        const ease = 1 - Math.pow(1 - Math.min(t * 1.5, 1), 2)
        const lat = p.startLat + (pos[0] - p.startLat) * ease
        const lng = p.startLng + (pos[1] - p.startLng) * ease
        p.marker.setLatLng([lat, lng])
        p.marker.setStyle({ opacity: t < 0.7 ? 0.8 : 0.8 * (1 - (t - 0.7) / 0.3) })
      }
      // Central flash grows then fades
      const flashSize = t < 0.5 ? t * 2 * 12 : 12 * (1 - (t - 0.5) * 2)
      flash.setRadius(Math.max(1, flashSize))
      flash.setStyle({ fillOpacity: t < 0.6 ? 0.9 : 0.9 * (1 - (t - 0.6) / 0.4) })
      // Ring expands and fades
      ring.setRadius(3 + t * 15)
      ring.setStyle({ opacity: 0.8 * (1 - t), fillOpacity: 0.3 * (1 - t) })
    }
  })
}

// ☢️ Build Nuke - ominous radiation pulse
export function spawnBuildNukeEffect(host: EffectHost, pos: LatLng) {
  const elements: L.CircleMarker[] = []

  // Inner glow
  const innerGlow = L.circleMarker(pos, {
    radius: 8,
    color: '#ff8800',
    fillColor: '#ffaa00',
    fillOpacity: 0.4,
    weight: 2,
    opacity: 0.8
  }).addTo(host.layer)
  elements.push(innerGlow)

  // Outer radiation ring
  const outerRing = L.circleMarker(pos, {
    radius: 5,
    color: '#ff4400',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 2,
    opacity: 0.6
  }).addTo(host.layer)
  elements.push(outerRing)

  // Second pulse ring (delayed)
  const pulseRing = L.circleMarker(pos, {
    radius: 5,
    color: '#ffcc00',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 1.5,
    opacity: 0
  }).addTo(host.layer)
  elements.push(pulseRing)

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 100,
    type: 'build_nuke',
    update: (t: number) => {
      // Pulsing inner glow - oscillates 3 times
      const pulse = Math.sin(t * Math.PI * 3)
      const pulseAbs = Math.abs(pulse)
      innerGlow.setRadius(6 + pulseAbs * 6)
      const fadeOut = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1
      innerGlow.setStyle({
        fillOpacity: (0.2 + pulseAbs * 0.4) * fadeOut,
        opacity: (0.5 + pulseAbs * 0.4) * fadeOut
      })

      // Outer ring expands slowly
      outerRing.setRadius(5 + t * 20)
      outerRing.setStyle({ opacity: 0.6 * (1 - t) })

      // Delayed second pulse
      const t2 = Math.max(0, (t - 0.3) / 0.7)
      pulseRing.setRadius(5 + t2 * 15)
      pulseRing.setStyle({ opacity: t2 > 0 ? 0.4 * (1 - t2) : 0 })
    }
  })

  // Subtle screen tint
  triggerBuildNukeScreenEffect()
}


// 🕵️ Spy - subtle stealth ripple
export function spawnSpyEffect(host: EffectHost, pos: LatLng) {
  const elements: L.CircleMarker[] = []

  // Dark ripple ring 1
  const ripple1 = L.circleMarker(pos, {
    radius: 3,
    color: '#6633aa',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 1.5,
    opacity: 0
  }).addTo(host.layer)
  elements.push(ripple1)

  // Dark ripple ring 2 (delayed)
  const ripple2 = L.circleMarker(pos, {
    radius: 3,
    color: '#442277',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 1,
    opacity: 0
  }).addTo(host.layer)
  elements.push(ripple2)

  // Tiny center dot
  const dot = L.circleMarker(pos, {
    radius: 2,
    color: '#9966cc',
    fillColor: '#9966cc',
    fillOpacity: 0.6,
    weight: 0
  }).addTo(host.layer)
  elements.push(dot)

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 50,
    type: 'spy',
    update: (t: number) => {
      // First ripple
      ripple1.setRadius(3 + t * 12)
      const fade1 = t < 0.2 ? t * 5 : 1 - (t - 0.2) / 0.8
      ripple1.setStyle({ opacity: Math.max(0, fade1 * 0.35) })

      // Second ripple (delayed)
      const t2 = Math.max(0, (t - 0.25) / 0.75)
      ripple2.setRadius(3 + t2 * 10)
      const fade2 = t2 < 0.2 ? t2 * 5 : 1 - (t2 - 0.2) / 0.8
      ripple2.setStyle({ opacity: Math.max(0, fade2 * 0.25) })

      // Center dot fades
      dot.setStyle({ fillOpacity: 0.6 * (1 - t), radius: 2 + t })
    }
  })
}

// 🔬 Research - cyan/white sparkle particles radiating outward
export function spawnResearchEffect(host: EffectHost, pos: LatLng) {
  const elements: (L.CircleMarker | L.Marker)[] = []

  // Central flash
  const flash = L.circleMarker(pos, {
    radius: 5,
    color: '#00ddff',
    fillColor: '#ffffff',
    fillOpacity: 0.8,
    weight: 2,
    opacity: 0.9
  }).addTo(host.layer)
  elements.push(flash)

  // 6 sparkle particles radiating outward in a spiral
  const particles: { marker: L.CircleMarker; angle: number; speed: number }[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    const p = L.circleMarker(pos, {
      radius: 2,
      color: i % 2 === 0 ? '#00ddff' : '#ffffff',
      fillColor: i % 2 === 0 ? '#00ddff' : '#ffffff',
      fillOpacity: 0.9,
      weight: 0
    }).addTo(host.layer)
    particles.push({ marker: p, angle, speed: 3 + Math.random() * 2 })
    elements.push(p)
  }

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 70,
    type: 'research',
    update: (t: number) => {
      // Central flash pulses then fades
      const flashPulse = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7
      flash.setRadius(3 + flashPulse * 8)
      flash.setStyle({ fillOpacity: flashPulse * 0.8, opacity: flashPulse * 0.9 })

      // Particles spiral outward
      for (const p of particles) {
        const ease = 1 - Math.pow(1 - t, 2)
        const dist = ease * p.speed
        const spiralAngle = p.angle + t * 1.5 // slight spiral
        const lat = pos[0] + Math.cos(spiralAngle) * dist
        const lng = pos[1] + Math.sin(spiralAngle) * dist
        p.marker.setLatLng([lat, lng])
        const fadeOut = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1
        p.marker.setStyle({ fillOpacity: 0.9 * fadeOut, radius: 2 + (1 - fadeOut) })
      }
    }
  })
}

// 💰 Hire Mercenary - gold spawn effect
export function spawnHireMercenaryEffect(host: EffectHost, pos: LatLng) {
  const gold = '#ffd700'
  const elements: L.CircleMarker[] = []

  // Gold flash
  const flash = L.circleMarker(pos, {
    radius: 3,
    color: gold,
    fillColor: '#ffffff',
    fillOpacity: 0.8,
    weight: 2,
    opacity: 0.9
  }).addTo(host.layer)
  elements.push(flash)

  // Gold ring burst
  const ring = L.circleMarker(pos, {
    radius: 3,
    color: gold,
    fillColor: gold,
    fillOpacity: 0.2,
    weight: 2,
    opacity: 0.7
  }).addTo(host.layer)
  elements.push(ring)

  // 3 gold coin-like particles inward
  const particles: { marker: L.CircleMarker; startLat: number; startLng: number }[] = []
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 0.3
    const dist = 3.5
    const startLat = pos[0] + Math.cos(angle) * dist
    const startLng = pos[1] + Math.sin(angle) * dist
    const p = L.circleMarker([startLat, startLng], {
      radius: 3,
      color: gold,
      fillColor: gold,
      fillOpacity: 0.9,
      weight: 1
    }).addTo(host.layer)
    particles.push({ marker: p, startLat, startLng })
    elements.push(p)
  }

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 60,
    type: 'hire_mercenary',
    update: (t: number) => {
      // Particles converge inward
      for (const p of particles) {
        const ease = 1 - Math.pow(1 - Math.min(t * 1.5, 1), 2)
        const lat = p.startLat + (pos[0] - p.startLat) * ease
        const lng = p.startLng + (pos[1] - p.startLng) * ease
        p.marker.setLatLng([lat, lng])
        p.marker.setStyle({ fillOpacity: t < 0.7 ? 0.9 : 0.9 * (1 - (t - 0.7) / 0.3) })
      }
      // Flash
      const flashSize = t < 0.4 ? t * 2.5 * 10 : 10 * (1 - (t - 0.4) / 0.6)
      flash.setRadius(Math.max(1, flashSize))
      flash.setStyle({ fillOpacity: t < 0.5 ? 0.8 : 0.8 * (1 - (t - 0.5) / 0.5) })
      // Ring expands
      ring.setRadius(3 + t * 12)
      ring.setStyle({ opacity: 0.7 * (1 - t), fillOpacity: 0.2 * (1 - t) })
    }
  })
}

// 🗡️ Betrayal - dramatic red shockwave
export function spawnBetrayalEffect(host: EffectHost, pos: LatLng) {
  const elements: L.CircleMarker[] = []

  // Bright red flash
  const flash = L.circleMarker(pos, {
    radius: 15,
    color: '#ff0000',
    fillColor: '#ff0000',
    fillOpacity: 0.6,
    weight: 0
  }).addTo(host.layer)
  elements.push(flash)

  // Expanding red shockwave
  const ring = L.circleMarker(pos, {
    radius: 8,
    color: '#ff0000',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 3,
    opacity: 0.9
  }).addTo(host.layer)
  elements.push(ring)

  // Second darker ring
  const ring2 = L.circleMarker(pos, {
    radius: 5,
    color: '#cc0000',
    fillColor: 'transparent',
    fillOpacity: 0,
    weight: 2,
    opacity: 0
  }).addTo(host.layer)
  elements.push(ring2)

  host.addEffect({
    elements,
    startTime: host.frame(),
    duration: 80,
    type: 'betrayal',
    update: (t: number) => {
      // Flash shrinks and fades
      flash.setRadius(15 * (1 - t * 0.5))
      flash.setStyle({ fillOpacity: 0.6 * (1 - t) })

      // Primary shockwave
      ring.setRadius(8 + t * 25)
      ring.setStyle({ opacity: 0.9 * (1 - t), weight: 3 - t * 2 })

      // Delayed secondary ring
      const t2 = Math.max(0, (t - 0.2) / 0.8)
      ring2.setRadius(5 + t2 * 20)
      ring2.setStyle({ opacity: t2 > 0 ? 0.6 * (1 - t2) : 0 })
    }
  })

  // Red screen border flash
  triggerBetrayalScreenEffect()
}
