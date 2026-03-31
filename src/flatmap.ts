import * as L from 'leaflet'
import type { GameState, GameEvent } from './types.js'

// Faction colors
const FACTION_COLORS: Record<string, string> = {
  nato: '#3498db',     // Blue
  russia: '#e74c3c',   // Red
  china: '#f1c40f'     // Yellow
}

const NEUTRAL_COLOR = '#555555'

// Map game territories to GeoJSON country names
const TERRITORY_COUNTRIES: Record<string, string[]> = {
  alaska: ['United States of America'],
  western_na: ['Canada'],
  eastern_na: ['Greenland'],
  central_america: ['Mexico', 'Guatemala', 'Belize', 'Honduras', 'El Salvador', 'Nicaragua', 'Costa Rica', 'Panama', 'Cuba', 'Jamaica', 'Haiti', 'Dominican Republic', 'Puerto Rico', 'The Bahamas'],
  amazonia: ['Brazil', 'Venezuela', 'Colombia', 'Guyana', 'Suriname', 'French Guiana', 'Ecuador'],
  andes: ['Peru', 'Bolivia', 'Chile'],
  patagonia: ['Argentina', 'Paraguay', 'Uruguay', 'Falkland Islands'],
  scandinavia: ['Norway', 'Sweden', 'Finland', 'Iceland', 'Denmark'],
  western_europe: ['France', 'Germany', 'United Kingdom', 'Ireland', 'Belgium', 'Netherlands', 'Luxembourg', 'Switzerland', 'Austria'],
  eastern_europe: ['Poland', 'Ukraine', 'Belarus', 'Czech Republic', 'Slovakia', 'Hungary', 'Romania', 'Moldova', 'Lithuania', 'Latvia', 'Estonia'],
  mediterranean: ['Italy', 'Spain', 'Portugal', 'Greece', 'Croatia', 'Albania', 'Montenegro', 'Bosnia and Herzegovina', 'Republic of Serbia', 'Macedonia', 'Slovenia', 'Bulgaria', 'Cyprus', 'Malta'],
  north_africa: ['Morocco', 'Algeria', 'Tunisia', 'Libya', 'Egypt', 'Western Sahara', 'Mauritania'],
  central_africa: ['Nigeria', 'Cameroon', 'Chad', 'Central African Republic', 'Democratic Republic of the Congo', 'Republic of the Congo', 'Gabon', 'Equatorial Guinea', 'Niger', 'Mali', 'Burkina Faso', 'Senegal', 'Gambia', 'Guinea', 'Guinea Bissau', 'Sierra Leone', 'Liberia', 'Ivory Coast', 'Ghana', 'Togo', 'Benin', 'Eritrea', 'Djibouti', 'Somalia', 'Somaliland', 'Ethiopia', 'South Sudan', 'Sudan', 'Kenya', 'Uganda', 'Rwanda', 'Burundi', 'United Republic of Tanzania'],
  south_africa: ['South Africa', 'Namibia', 'Botswana', 'Zimbabwe', 'Mozambique', 'Madagascar', 'Zambia', 'Malawi', 'Angola', 'Swaziland', 'Lesotho'],
  siberia: ['Russia'],
  central_asia: ['Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan', 'Afghanistan', 'Iran', 'Iraq', 'Syria', 'Turkey', 'Georgia', 'Armenia', 'Azerbaijan', 'Saudi Arabia', 'Yemen', 'Oman', 'United Arab Emirates', 'Qatar', 'Kuwait', 'Jordan', 'Israel', 'Lebanon', 'West Bank', 'Northern Cyprus'],
  east_asia: ['China', 'Japan', 'South Korea', 'North Korea', 'Mongolia', 'Taiwan'],
  south_asia: ['India', 'Pakistan', 'Bangladesh', 'Nepal', 'Bhutan', 'Sri Lanka', 'Myanmar', 'Thailand', 'Laos', 'Cambodia', 'Vietnam'],
  indonesia: ['Indonesia', 'Malaysia', 'Philippines', 'Papua New Guinea', 'Brunei', 'East Timor', 'Solomon Islands', 'New Caledonia', 'Vanuatu', 'Fiji'],
  australia: ['Australia', 'New Zealand']
}

// Reverse lookup: country name -> territory ID
const COUNTRY_TO_TERRITORY: Record<string, string> = {}
for (const [tId, countries] of Object.entries(TERRITORY_COUNTRIES)) {
  for (const country of countries) {
    COUNTRY_TO_TERRITORY[country] = tId
  }
}

interface AnimatedArc {
  trail: L.Polyline
  head: L.CircleMarker
  points: [number, number][]
  currentStep: number
  type: string
  cancelled: boolean
}

interface NukeBlast {
  ring: L.CircleMarker
  flash: L.CircleMarker
  startTime: number
}

interface LocalEffect {
  elements: (L.CircleMarker | L.Marker)[]
  startTime: number
  duration: number  // frames
  type: string
  update: (t: number) => void  // 0-1 progress
}

// Animate marker smoothly to new position
function animateMarker(marker: L.Marker, targetLat: number, targetLon: number, duration: number) {
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

export class FlatMap {
  private map: L.Map
  private geojsonData: any = null
  private countryLayers: Map<string, L.GeoJSON> = new Map()
  private territoryMarkers: Map<string, L.CircleMarker> = new Map()
  private unitMarkers: Map<string, L.Marker> = new Map()
  private arcLayer: L.LayerGroup
  private activeArcs: AnimatedArc[] = []
  private activeBlasts: NukeBlast[] = []
  private activeEffects: LocalEffect[] = []
  private pendingImpacts = 0
  private lastTurn = -1
  private animFrame = 0
  private pendingState: GameState | null = null

  constructor(container: HTMLElement) {
    this.map = L.map(container, {
      center: [20, 10],
      zoom: 2,
      zoomSnap: 0.1,
      maxZoom: 6,
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false
    })

    // Dark tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      noWrap: true
    }).addTo(this.map)

    // Fill container edge-to-edge
    this.fitMapToContainer()

    new ResizeObserver(() => {
      this.map.invalidateSize()
      this.fitMapToContainer()
    }).observe(container)

    // Create layer for arcs and effects
    this.arcLayer = L.layerGroup().addTo(this.map)

    // Load GeoJSON for country borders
    this.loadGeoJSON()

    // Start animation loop
    this.animate()
  }

  private fitMapToContainer() {
    const size = this.map.getSize()
    if (size.x === 0 || size.y === 0) return

    // Fit the full world bounds into the container (contain mode)
    const bounds = L.latLngBounds([[-55, -165], [75, 180]])
    const zoom = this.map.getBoundsZoom(bounds, false)

    this.map.setView(bounds.getCenter(), zoom, { animate: false })
  }

  // Fix polygons that cross the antimeridian (e.g. Russia's far east)
  // by shifting far-west polygons (+360 lng) so they appear on the right side
  private fixAntimeridian(geojson: any) {
    const shiftRing = (ring: number[][]) => {
      for (const coord of ring) {
        coord[0] += 360
      }
    }

    for (const feature of geojson.features) {
      if (!feature.geometry || !feature.geometry.coordinates) continue

      const type = feature.geometry.type
      if (type === 'MultiPolygon') {
        for (const polygon of feature.geometry.coordinates) {
          const ring = polygon[0]
          if (!ring || ring.length === 0) continue
          const avgLng = ring.reduce((sum: number, c: number[]) => sum + c[0], 0) / ring.length
          if (avgLng < -160) {
            for (const r of polygon) shiftRing(r)
          }
        }
      } else if (type === 'Polygon') {
        const ring = feature.geometry.coordinates[0]
        if (ring && ring.length > 0) {
          const avgLng = ring.reduce((sum: number, c: number[]) => sum + c[0], 0) / ring.length
          if (avgLng < -160) {
            for (const r of feature.geometry.coordinates) shiftRing(r)
          }
        }
      }
    }
  }

  private async loadGeoJSON() {
    try {
      const res = await fetch('/countryborders.json')
      this.geojsonData = await res.json()
      this.fixAntimeridian(this.geojsonData)
      // Re-render if state arrived before GeoJSON loaded
      if (this.pendingState) {
        this.render(this.pendingState)
        this.pendingState = null
      }
    } catch (err) {
      console.warn('Could not load country borders:', err)
    }
  }

  private animate() {
    requestAnimationFrame(() => this.animate())
    this.animFrame++

    // Animate active arcs
    const arcsToRemove: number[] = []
    for (let i = 0; i < this.activeArcs.length; i++) {
      const arc = this.activeArcs[i]
      if (arc.cancelled) continue

      if (arc.currentStep < arc.points.length) {
        // Update trail and head position
        arc.trail.setLatLngs(arc.points.slice(0, arc.currentStep + 1))
        arc.head.setLatLng(arc.points[arc.currentStep])
        // Move nuke glow with head
        const glow = (arc.head as any)._nukeGlow as L.CircleMarker | undefined
        if (glow) glow.setLatLng(arc.points[arc.currentStep])
        arc.currentStep++
      } else {
        // Arc complete - hold full arc visible, then spawn impact
        const target = arc.points[arc.points.length - 1]
        const impactDelay = arc.type === 'nuke' ? 1200 : 600
        this.pendingImpacts++
        setTimeout(() => {
          this.pendingImpacts = Math.max(0, this.pendingImpacts - 1)
          if (arc.cancelled) return
          if (arc.type === 'nuke') {
            this.spawnNukeBlast(target)
          } else if (arc.type === 'combat' || arc.type === 'attack') {
            this.spawnCombatImpact(target, (arc as any)._factionColor || '#ff3366')
          } else if (arc.type === 'capture') {
            this.spawnCaptureImpact(target, (arc as any)._factionColor || '#ffffff')
          }
        }, impactDelay)
        // Remove arc trail after impact has had time to show
        setTimeout(() => {
          try {
            this.arcLayer.removeLayer(arc.trail)
            this.arcLayer.removeLayer(arc.head)
            const glow = (arc.head as any)._nukeGlow as L.CircleMarker | undefined
            if (glow) this.arcLayer.removeLayer(glow)
          } catch {}
        }, impactDelay + 1500)
        arcsToRemove.push(i)
      }
    }

    // Remove completed arcs (reverse order)
    for (let i = arcsToRemove.length - 1; i >= 0; i--) {
      this.activeArcs.splice(arcsToRemove[i], 1)
    }

    // Animate nuke blasts
    const blastsToRemove: number[] = []
    for (let i = 0; i < this.activeBlasts.length; i++) {
      const blast = this.activeBlasts[i]
      const age = this.animFrame - blast.startTime
      const duration = 180 // frames

      const t = age / duration
      const scale = 1 + t * 15

      // Expand ring
      blast.ring.setRadius(scale * 50000)
      blast.ring.setStyle({ opacity: Math.max(0, 1 - t), fillOpacity: Math.max(0, 0.3 - t * 0.3) })

      // Flash fades
      blast.flash.setRadius(Math.max(10000, 80000 * (1 - t)))
      blast.flash.setStyle({ opacity: Math.max(0, 1 - t * 1.5) })

      if (age > duration) {
        try {
          this.arcLayer.removeLayer(blast.ring)
          this.arcLayer.removeLayer(blast.flash)
        } catch {}
        blastsToRemove.push(i)
      }
    }
    for (let i = blastsToRemove.length - 1; i >= 0; i--) {
      this.activeBlasts.splice(blastsToRemove[i], 1)
    }

    // Animate local effects
    const effectsToRemove: number[] = []
    for (let i = 0; i < this.activeEffects.length; i++) {
      const effect = this.activeEffects[i]
      const age = this.animFrame - effect.startTime
      const t = Math.min(age / effect.duration, 1)
      effect.update(t)
      if (age > effect.duration) {
        for (const el of effect.elements) {
          try { this.arcLayer.removeLayer(el) } catch {}
        }
        effectsToRemove.push(i)
      }
    }
    for (let i = effectsToRemove.length - 1; i >= 0; i--) {
      this.activeEffects.splice(effectsToRemove[i], 1)
    }

  }

  private spawnNukeBlast(pos: [number, number]) {
    // Expanding shockwave ring
    const ring = L.circleMarker(pos, {
      radius: 20,
      color: '#ff4400',
      fillColor: '#ff8800',
      fillOpacity: 0.4,
      weight: 3,
      opacity: 1
    }).addTo(this.arcLayer)

    // Bright flash
    const flash = L.circleMarker(pos, {
      radius: 40,
      color: '#ffffff',
      fillColor: '#ffffff',
      fillOpacity: 0.8,
      weight: 0
    }).addTo(this.arcLayer)

    // Second shockwave ring (delayed, larger)
    const ring2 = L.circleMarker(pos, {
      radius: 10,
      color: '#ffaa00',
      fillColor: '#ff4400',
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.8
    }).addTo(this.arcLayer)

    this.activeBlasts.push({
      ring,
      flash,
      startTime: this.animFrame
    })

    // Delayed second ring
    setTimeout(() => {
      this.activeBlasts.push({
        ring: ring2,
        flash: L.circleMarker(pos, { radius: 0, opacity: 0, fillOpacity: 0 }).addTo(this.arcLayer),
        startTime: this.animFrame
      })
    }, 200)

    // Trigger screen-level effects
    this.triggerNukeScreenEffects()
  }

  private triggerNukeScreenEffects() {
    // Screen flash
    const flashEl = document.getElementById('nuke-screen-flash')
    if (flashEl) {
      flashEl.classList.remove('active')
      void flashEl.offsetWidth // force reflow
      flashEl.classList.add('active')
      setTimeout(() => flashEl.classList.remove('active'), 3000)
    }

    // Warning border
    const borderEl = document.getElementById('nuke-warning-border')
    if (borderEl) {
      borderEl.classList.remove('active')
      void borderEl.offsetWidth
      borderEl.classList.add('active')
      setTimeout(() => borderEl.classList.remove('active'), 5000)
    }

    // Screen shake
    const globe = document.getElementById('globe-container')
    if (globe) {
      globe.classList.remove('nuke-shake')
      void globe.offsetWidth
      globe.classList.add('nuke-shake')
      setTimeout(() => globe.classList.remove('nuke-shake'), 1300)
    }
  }

  private spawnCombatImpact(pos: [number, number], color: string) {
    // Expanding shockwave ring - smaller than nuke
    const ring = L.circleMarker(pos, {
      radius: 10,
      color,
      fillColor: color,
      fillOpacity: 0.3,
      weight: 2,
      opacity: 1
    }).addTo(this.arcLayer)

    // Brief bright flash
    const flash = L.circleMarker(pos, {
      radius: 20,
      color: '#ffffff',
      fillColor: '#ffffff',
      fillOpacity: 0.6,
      weight: 0
    }).addTo(this.arcLayer)

    this.activeBlasts.push({
      ring,
      flash,
      startTime: this.animFrame
    })

    // Subtle screen flash
    const flashEl = document.getElementById('nuke-screen-flash')
    if (flashEl) {
      flashEl.classList.remove('active', 'combat-flash')
      void flashEl.offsetWidth
      flashEl.classList.add('combat-flash')
      setTimeout(() => flashEl.classList.remove('combat-flash'), 600)
    }

    // Subtle screen shake
    const globe = document.getElementById('globe-container')
    if (globe) {
      globe.classList.remove('combat-shake')
      void globe.offsetWidth
      globe.classList.add('combat-shake')
      setTimeout(() => globe.classList.remove('combat-shake'), 500)
    }

    // Spark particles - small dots that fly outward
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.random() * 0.5
      const spark = L.circleMarker(pos, {
        radius: 3,
        color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 0
      }).addTo(this.arcLayer)

      const dist = 3 + Math.random() * 2
      const targetLat = pos[0] + Math.cos(angle) * dist
      const targetLng = pos[1] + Math.sin(angle) * dist
      animateMarker(spark as any, targetLat, targetLng, 400)
      setTimeout(() => {
        try { this.arcLayer.removeLayer(spark) } catch {}
      }, 500)
    }
  }

  private spawnCaptureImpact(pos: [number, number], color: string) {
    // Faction-colored expanding ring pulse
    const ring = L.circleMarker(pos, {
      radius: 8,
      color,
      fillColor: color,
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.9
    }).addTo(this.arcLayer)

    // Second ring, slightly delayed
    const ring2 = L.circleMarker(pos, {
      radius: 5,
      color,
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 1.5,
      opacity: 0.6
    }).addTo(this.arcLayer)

    this.activeBlasts.push({
      ring,
      flash: ring2,
      startTime: this.animFrame
    })
  }

  stopCamera() {}

  reset() {

    // Clear all animations
    this.activeArcs.forEach(arc => {
      try {
        this.arcLayer.removeLayer(arc.trail)
        this.arcLayer.removeLayer(arc.head)
        const glow = (arc.head as any)._nukeGlow as L.CircleMarker | undefined
        if (glow) this.arcLayer.removeLayer(glow)
      } catch {}
    })
    this.activeArcs = []
    this.activeBlasts.forEach(b => {
      try { this.arcLayer.removeLayer(b.ring); this.arcLayer.removeLayer(b.flash) } catch {}
    })
    this.activeBlasts = []
    this.activeEffects.forEach(e => {
      for (const el of e.elements) { try { this.arcLayer.removeLayer(el) } catch {} }
    })
    this.activeEffects = []

    // Clear map layers
    this.countryLayers.forEach(layer => this.map.removeLayer(layer))
    this.countryLayers.clear()
    this.territoryMarkers.forEach(marker => this.map.removeLayer(marker))
    this.territoryMarkers.clear()

    // Reset state
    this.lastTurn = -1
    this.pendingRender = null
    this.pendingImpacts = 0

    // Return to overview
    this.fitMapToContainer()
  }

  private spawnEventArcs(events: GameEvent[], state: GameState) {
    for (const event of events) {
      if (!event.from || !event.to) continue
      const fromTerritory = state.map.territories[event.from]
      const toTerritory = state.map.territories[event.to]
      if (!fromTerritory || !toTerritory) continue

      // Build arc path - subtle curve perpendicular to the travel direction
      const points: [number, number][] = []
      const steps = 80
      const dlat = toTerritory.lat - fromTerritory.lat
      const dlng = toTerritory.lng - fromTerritory.lng
      const dist = Math.sqrt(dlat * dlat + dlng * dlng)
      // Perpendicular direction for the curve (rotated 90 degrees)
      const perpLat = -dlng / (dist || 1)
      const perpLng = dlat / (dist || 1)
      // Arc height scales with distance but stays subtle
      const arcHeight = Math.min(dist * 0.08, 3)
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const lat = fromTerritory.lat + dlat * t
        const lng = fromTerritory.lng + dlng * t
        const offset = Math.sin(t * Math.PI) * arcHeight
        points.push([lat + perpLat * offset, lng + perpLng * offset])
      }

      // Determine head color based on event type (trail is always white for visibility)
      let headColor: string
      let weight = 2
      if (event.type === 'nuke') {
        headColor = '#ff8800'
        weight = 4
      } else if (event.type === 'combat' || event.type === 'attack') {
        headColor = '#ff3366'
        weight = 3
      } else if (event.type === 'capture') {
        headColor = FACTION_COLORS[event.faction] || '#ffaa00'
        weight = 3
      } else if (event.type === 'trade') {
        headColor = '#00ff88'
      } else if (event.type === 'diplomacy') {
        headColor = '#aa66ff'
      } else {
        headColor = FACTION_COLORS[event.faction] || '#ffffff'
      }

      const isNuke = event.type === 'nuke'

      // Nuke warning - full screen overlay
      if (isNuke) {
        const overlay = document.createElement('div')
        overlay.className = 'nuke-warning-overlay'
        overlay.innerHTML = '<div class="nuke-warning-content">&#9762;<div class="nuke-warning-text">NUCLEAR LAUNCH DETECTED</div></div>'
        document.body.appendChild(overlay)
        setTimeout(() => overlay.remove(), 2500)
      }

      // Create trail polyline - WHITE for visibility against all territory colors
      const trail = L.polyline([], {
        color: isNuke ? '#ff4400' : '#ffffff',
        weight: isNuke ? 5 : weight,
        opacity: isNuke ? 0.9 : 0.8,
        dashArray: isNuke ? undefined : '8, 4'
      }).addTo(this.arcLayer)

      // Create moving head (colored by event type)
      const head = L.circleMarker(points[0], {
        radius: isNuke ? 14 : 6,
        color: isNuke ? '#ffffff' : headColor,
        fillColor: isNuke ? '#ffaa00' : headColor,
        fillOpacity: 1,
        weight: isNuke ? 3 : 2
      }).addTo(this.arcLayer)

      // Nuke gets a glow ring around the head
      if (isNuke) {
        const glow = L.circleMarker(points[0], {
          radius: 22,
          color: '#ff4400',
          fillColor: '#ff8800',
          fillOpacity: 0.15,
          weight: 1,
          opacity: 0.5
        }).addTo(this.arcLayer)
        // Animate glow with head in the arc loop
        const origAnimate = this.activeArcs
        // Track the glow to move with head
        ;(head as any)._nukeGlow = glow
      }

      const arcObj: AnimatedArc = {
        trail,
        head,
        points,
        currentStep: 0,
        type: event.type,
        cancelled: false
      }
      ;(arcObj as any)._factionColor = FACTION_COLORS[event.faction] || headColor
      this.activeArcs.push(arcObj)
    }
  }

  // ── In-place animation spawners ──

  private spawnLocalEffects(events: GameEvent[], state: GameState) {
    for (const event of events) {
      if (event.from || !event.to) continue // skip arc events and events with no territory
      const territory = state.map.territories[event.to]
      if (!territory) continue
      const pos: [number, number] = [territory.lat, territory.lng]
      const factionColor = FACTION_COLORS[event.faction] || '#ffffff'

      switch (event.type) {
        case 'fortify': this.spawnFortifyEffect(pos, factionColor); break
        case 'recruit': this.spawnRecruitEffect(pos, factionColor); break
        case 'build_nuke': this.spawnBuildNukeEffect(pos); break
        case 'spy': this.spawnSpyEffect(pos); break
        case 'research': this.spawnResearchEffect(pos, factionColor); break
        case 'hire_mercenary': this.spawnHireMercenaryEffect(pos); break
        case 'betrayal': this.spawnBetrayalEffect(pos); break
      }
    }
  }

  // 🛡️ Fortify - 3 concentric shield rings that solidify
  private spawnFortifyEffect(pos: [number, number], color: string) {
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
      }).addTo(this.arcLayer)
      rings.push(ring)
      elements.push(ring)
    }

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
  private spawnRecruitEffect(pos: [number, number], color: string) {
    const elements: (L.CircleMarker | L.Marker)[] = []

    // Central flash
    const flash = L.circleMarker(pos, {
      radius: 2,
      color: '#ffffff',
      fillColor: '#ffffff',
      fillOpacity: 0.9,
      weight: 0
    }).addTo(this.arcLayer)
    elements.push(flash)

    // Outer ring burst
    const ring = L.circleMarker(pos, {
      radius: 3,
      color,
      fillColor: color,
      fillOpacity: 0.3,
      weight: 2,
      opacity: 0.8
    }).addTo(this.arcLayer)
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
      }).addTo(this.arcLayer)
      particles.push({ marker: p, startLat, startLng })
      elements.push(p)
    }

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
  private spawnBuildNukeEffect(pos: [number, number]) {
    const elements: L.CircleMarker[] = []

    // Inner glow
    const innerGlow = L.circleMarker(pos, {
      radius: 8,
      color: '#ff8800',
      fillColor: '#ffaa00',
      fillOpacity: 0.4,
      weight: 2,
      opacity: 0.8
    }).addTo(this.arcLayer)
    elements.push(innerGlow)

    // Outer radiation ring
    const outerRing = L.circleMarker(pos, {
      radius: 5,
      color: '#ff4400',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 2,
      opacity: 0.6
    }).addTo(this.arcLayer)
    elements.push(outerRing)

    // Second pulse ring (delayed)
    const pulseRing = L.circleMarker(pos, {
      radius: 5,
      color: '#ffcc00',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 1.5,
      opacity: 0
    }).addTo(this.arcLayer)
    elements.push(pulseRing)

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
    this.triggerBuildNukeScreenEffect()
  }

  private triggerBuildNukeScreenEffect() {
    const flashEl = document.getElementById('nuke-screen-flash')
    if (flashEl) {
      flashEl.classList.remove('active', 'combat-flash', 'radiation-flash')
      void flashEl.offsetWidth
      flashEl.classList.add('radiation-flash')
      setTimeout(() => flashEl.classList.remove('radiation-flash'), 1500)
    }
  }

  // 🕵️ Spy - subtle stealth ripple
  private spawnSpyEffect(pos: [number, number]) {
    const elements: L.CircleMarker[] = []

    // Dark ripple ring 1
    const ripple1 = L.circleMarker(pos, {
      radius: 3,
      color: '#6633aa',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 1.5,
      opacity: 0
    }).addTo(this.arcLayer)
    elements.push(ripple1)

    // Dark ripple ring 2 (delayed)
    const ripple2 = L.circleMarker(pos, {
      radius: 3,
      color: '#442277',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 1,
      opacity: 0
    }).addTo(this.arcLayer)
    elements.push(ripple2)

    // Tiny center dot
    const dot = L.circleMarker(pos, {
      radius: 2,
      color: '#9966cc',
      fillColor: '#9966cc',
      fillOpacity: 0.6,
      weight: 0
    }).addTo(this.arcLayer)
    elements.push(dot)

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
  private spawnResearchEffect(pos: [number, number], factionColor: string) {
    const elements: (L.CircleMarker | L.Marker)[] = []

    // Central flash
    const flash = L.circleMarker(pos, {
      radius: 5,
      color: '#00ddff',
      fillColor: '#ffffff',
      fillOpacity: 0.8,
      weight: 2,
      opacity: 0.9
    }).addTo(this.arcLayer)
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
      }).addTo(this.arcLayer)
      particles.push({ marker: p, angle, speed: 3 + Math.random() * 2 })
      elements.push(p)
    }

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
  private spawnHireMercenaryEffect(pos: [number, number]) {
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
    }).addTo(this.arcLayer)
    elements.push(flash)

    // Gold ring burst
    const ring = L.circleMarker(pos, {
      radius: 3,
      color: gold,
      fillColor: gold,
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.7
    }).addTo(this.arcLayer)
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
      }).addTo(this.arcLayer)
      particles.push({ marker: p, startLat, startLng })
      elements.push(p)
    }

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
  private spawnBetrayalEffect(pos: [number, number]) {
    const elements: L.CircleMarker[] = []

    // Bright red flash
    const flash = L.circleMarker(pos, {
      radius: 15,
      color: '#ff0000',
      fillColor: '#ff0000',
      fillOpacity: 0.6,
      weight: 0
    }).addTo(this.arcLayer)
    elements.push(flash)

    // Expanding red shockwave
    const ring = L.circleMarker(pos, {
      radius: 8,
      color: '#ff0000',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 3,
      opacity: 0.9
    }).addTo(this.arcLayer)
    elements.push(ring)

    // Second darker ring
    const ring2 = L.circleMarker(pos, {
      radius: 5,
      color: '#cc0000',
      fillColor: 'transparent',
      fillOpacity: 0,
      weight: 2,
      opacity: 0
    }).addTo(this.arcLayer)
    elements.push(ring2)

    this.activeEffects.push({
      elements,
      startTime: this.animFrame,
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
    this.triggerBetrayalScreenEffect()
  }

  private triggerBetrayalScreenEffect() {
    const borderEl = document.getElementById('nuke-warning-border')
    if (borderEl) {
      borderEl.classList.remove('active', 'betrayal-flash')
      void borderEl.offsetWidth
      borderEl.classList.add('betrayal-flash')
      setTimeout(() => borderEl.classList.remove('betrayal-flash'), 2000)
    }
  }

  private isAnimating(): boolean {
    return this.activeArcs.length > 0 || this.activeBlasts.length > 0 || this.activeEffects.length > 0 || this.pendingImpacts > 0
  }

  hasActiveAnimations(): boolean {
    return this.isAnimating()
  }

  private pendingRender: GameState | null = null

  render(state: GameState) {
    if (!this.geojsonData) {
      this.pendingState = state
      return
    }


    // Build territory ownership map
    const territoryOwners: Record<string, string | null> = {}
    for (const [tId, territory] of Object.entries(state.map.territories)) {
      territoryOwners[tId] = territory.owner
    }

    // Update existing country layers in-place or create new ones
    for (const feature of this.geojsonData.features) {
      const countryName = feature.properties.name
      const territoryId = COUNTRY_TO_TERRITORY[countryName]
      if (!territoryId) continue

      const owner = territoryOwners[territoryId]
      const color = owner ? FACTION_COLORS[owner] : NEUTRAL_COLOR
      const newStyle = {
        fillColor: color,
        fillOpacity: owner ? 0.35 : 0.1,
        color: owner ? color : '#444444',
        weight: owner ? 1.5 : 0.5,
        opacity: owner ? 0.8 : 0.3
      }

      const existing = this.countryLayers.get(countryName)
      if (existing) {
        // Update style in-place - no remove/re-add flicker
        existing.setStyle(newStyle)
      } else {
        const layer = L.geoJSON(feature, { style: newStyle }).addTo(this.map)
        this.countryLayers.set(countryName, layer)
      }
    }

    // Build unit count per territory
    const unitMap: Record<string, { owner: string; count: number }[]> = {}
    for (const [factionId, faction] of Object.entries(state.factions)) {
      for (const unit of faction.units) {
        if (!unitMap[unit.territory]) unitMap[unit.territory] = []
        const existing = unitMap[unit.territory].find(u => u.owner === factionId)
        if (existing) existing.count++
        else unitMap[unit.territory].push({ owner: factionId, count: 1 })
      }
    }

    // Territory center markers - update in-place or create
    for (const [tId, territory] of Object.entries(state.map.territories)) {
      const color = territory.owner ? FACTION_COLORS[territory.owner] : NEUTRAL_COLOR

      const existingMarker = this.territoryMarkers.get(tId)
      if (existingMarker) {
        // Update existing marker
        existingMarker.setRadius(territory.owner ? 5 : 4)
        // Update tooltip
        const units = unitMap[tId]
        const unitCount = units ? units.reduce((sum, u) => sum + u.count, 0) : 0
        existingMarker.unbindTooltip()
        existingMarker.bindTooltip(`
          <div class="territory-tooltip">
            <strong>${territory.name}</strong><br/>
            ${territory.owner ? `Owner: ${state.factions[territory.owner]?.name || territory.owner}` : 'Neutral'}<br/>
            Terrain: ${territory.terrain}<br/>
            Units: ${unitCount}${territory.fortified ? ' (Fortified)' : ''}
            ${territory.mercenaries ? `<br/>Mercenaries: ${territory.mercenaries}` : ''}
          </div>
        `, { direction: 'top', offset: [0, -10], className: 'map-tooltip' })

        // Update fortification indicator
        const existingFort = this.territoryMarkers.get(`${tId}-fort`)
        if (territory.fortified && !existingFort) {
          const fort = L.circleMarker([territory.lat, territory.lng], {
            radius: 12, color: '#ffffff', fillColor: 'transparent', fillOpacity: 0,
            weight: 2, dashArray: '4, 4'
          }).addTo(this.map)
          this.territoryMarkers.set(`${tId}-fort`, fort)
        } else if (!territory.fortified && existingFort) {
          this.map.removeLayer(existingFort)
          this.territoryMarkers.delete(`${tId}-fort`)
        }
      } else {
        // Create new marker
        const marker = L.circleMarker([territory.lat, territory.lng], {
          radius: territory.owner ? 5 : 4,
          color: '#ffffff', fillColor: '#ffffff', fillOpacity: 0.8, weight: 1
        }).addTo(this.map)

        if (territory.fortified) {
          const fort = L.circleMarker([territory.lat, territory.lng], {
            radius: 12, color: '#ffffff', fillColor: 'transparent', fillOpacity: 0,
            weight: 2, dashArray: '4, 4'
          }).addTo(this.map)
          this.territoryMarkers.set(`${tId}-fort`, fort)
        }

        const units = unitMap[tId]
        const unitCount = units ? units.reduce((sum, u) => sum + u.count, 0) : 0
        marker.bindTooltip(`
          <div class="territory-tooltip">
            <strong>${territory.name}</strong><br/>
            ${territory.owner ? `Owner: ${state.factions[territory.owner]?.name || territory.owner}` : 'Neutral'}<br/>
            Terrain: ${territory.terrain}<br/>
            Units: ${unitCount}${territory.fortified ? ' (Fortified)' : ''}
            ${territory.mercenaries ? `<br/>Mercenaries: ${territory.mercenaries}` : ''}
          </div>
        `, { direction: 'top', offset: [0, -10], className: 'map-tooltip' })

        // Territory name label (only created once)
        const label = L.marker([territory.lat + 3, territory.lng], {
          icon: L.divIcon({
            className: 'territory-label',
            html: `<div style="color:#ffffff;font-family:Orbitron,monospace;font-size:8px;font-weight:700;letter-spacing:1px;text-transform:uppercase;white-space:nowrap;text-shadow:0 0 4px rgba(0,0,0,0.9),0 1px 2px rgba(0,0,0,0.9);text-align:center;">${territory.name}</div>`,
            iconSize: [120, 14],
            iconAnchor: [60, 7]
          })
        }).addTo(this.map)
        this.territoryMarkers.set(`${tId}-label`, label as any)

        this.territoryMarkers.set(tId, marker)
      }
    }

    // Spawn event arcs and local effects for new turn
    if (state.recentEvents && state.game.turn !== this.lastTurn && state.game.turn > 0) {
      this.lastTurn = state.game.turn
      const events = state.recentEvents.filter(e => e.type !== 'invalid' && e.type !== 'forfeit')
      this.spawnEventArcs(events, state)
      this.spawnLocalEffects(events, state)
    }
  }
}
