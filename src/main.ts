import { FlatMap } from './flatmap.js'
import { WarRoom } from './warroom.js'
import type { GameState, ChatMessage, GameEvent, GameControl, UsageSnapshot, SaveSummary, Scorecard } from './types.js'
import 'leaflet/dist/leaflet.css'
import './style.css'

const FACTION_COLORS: Record<string, string> = {
  nato: '#3498db',      // Blue - NATO
  russia: '#e74c3c',    // Red - Russia
  china: '#f1c40f'      // Yellow - China
}

const EVENT_ICONS: Record<string, string> = {
  move: '\u2794',
  attack: '\u2694',
  combat: '\u2694',
  fortify: '\u26E8',
  recruit: '\u2795',
  trade: '\uD83D\uDCB0',
  spy: '\uD83D\uDD75',
  research: '\uD83D\uDD2C',
  diplomacy: '\uD83E\uDD1D',
  capture: '\uD83C\uDFF4',
  victory: '\uD83C\uDFC6',
  nuke: '\u2622',
  build_nuke: '\u2622',
  betrayal: '\uD83D\uDDE1',
  forfeit: '\u274C',
  invalid: '\u26A0',
  message: '\uD83D\uDCE8',
  hire_mercenary: '\uD83D\uDCB5',
  attrition: '\uD83C\uDF5E'
}

class WarGamesApp {
  private map: FlatMap
  private state: GameState | null = null
  private chatMessages: ChatMessage[] = []
  private chatIndex = 0
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private timerInterval: ReturnType<typeof setInterval> | null = null
  private startTime: number = 0
  private lastDisplayedTurn = 0
  private gameEndShown = false
  private control: GameControl = { running: false, paused: false, turnExecuting: false, intervalMs: 15000 }
  private speedSynced = false
  private warRoom: WarRoom

  constructor() {
    const container = document.getElementById('globe-container')!
    this.map = new FlatMap(container)
    this.warRoom = new WarRoom(document.getElementById('warroom-modal')!, document.getElementById('warroom-body')!, FACTION_COLORS)

    document.getElementById('btn-start')!.addEventListener('click', () => this.startGame())
    document.getElementById('btn-pause')!.addEventListener('click', () => this.pauseGame())
    document.getElementById('btn-resume')!.addEventListener('click', () => this.resumeGame())
    document.getElementById('btn-step')!.addEventListener('click', () => this.stepGame())
    document.getElementById('btn-stop')!.addEventListener('click', () => this.stopGame())
    document.getElementById('btn-reset')!.addEventListener('click', () => this.resetGame())
    const scenarioSelect = document.getElementById('scenario-select') as HTMLSelectElement
    scenarioSelect.addEventListener('change', async () => {
      await this.post('/api/reset', { scenario: scenarioSelect.value })
      this.clearLocal()
      await this.fetchState()
    })
    void this.loadScenarios()
    const loadSelect = document.getElementById('load-select') as HTMLSelectElement
    loadSelect.addEventListener('mousedown', () => void this.refreshSaves())
    loadSelect.addEventListener('focus', () => void this.refreshSaves())
    loadSelect.addEventListener('change', () => {
      const id = loadSelect.value
      loadSelect.value = ''
      if (id) void this.loadGame(id)
    })
    document.getElementById('btn-warroom')!.addEventListener('click', () => {
      if (this.state) this.warRoom.open(this.chatMessages, this.state)
    })

    const speed = document.getElementById('speed') as HTMLInputElement
    speed.addEventListener('input', () => {
      document.getElementById('speed-value')!.textContent = `${speed.value}s`
    })
    // Applies at once to a running game; a stopped one just remembers it
    speed.addEventListener('change', () => this.post('/api/interval', { intervalMs: this.speedMs() }))

    // Dismiss game summary modal on backdrop click
    document.getElementById('game-summary-modal')!.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'game-summary-modal') {
        document.getElementById('game-summary-modal')!.classList.add('hidden')
      }
    })

    this.fetchState()
    this.fetchChat()
  }

  private updateElapsed() {
    if (this.startTime > 0) {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
      const min = Math.floor(elapsed / 60)
      const sec = elapsed % 60
      document.getElementById('elapsed')!.textContent = `${min}:${sec.toString().padStart(2, '0')}`
    }
  }

  private speedMs(): number {
    return Number((document.getElementById('speed') as HTMLInputElement).value) * 1000
  }

  private post(path: string, body?: unknown): Promise<Response> {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  private stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval)
      this.timerInterval = null
    }
  }

  /** A new game is about to begin on the server: drop everything shown from the last one. */
  private clearLocal() {
    this.stopPolling()
    this.stopTimer()
    this.startTime = 0
    this.chatMessages = []
    this.chatIndex = 0
    this.lastDisplayedTurn = 0
    this.gameEndShown = false
    this.map.reset()
    this.warRoom.reset()
    document.getElementById('game-summary-modal')!.classList.add('hidden')
    document.getElementById('capture-toasts')!.innerHTML = ''
    document.getElementById('elapsed')!.textContent = '0:00'
    this.renderChat()
  }

  private async startGame() {
    if (!this.control.running) this.clearLocal()
    await this.post('/api/start', { intervalMs: this.speedMs() })
    await this.fetchState()
  }

  private async pauseGame() {
    await this.post('/api/pause')
    await this.fetchState()
  }

  private async resumeGame() {
    await this.post('/api/resume')
    await this.fetchState()
  }

  /** Play one turn and stay paused; starts a fresh game if none is running. */
  private async stepGame() {
    if (!this.control.running) this.clearLocal()
    const res = await this.post('/api/step')
    if (res.ok) await this.fetchState()
  }

  private async stopGame() {
    await this.post('/api/stop')
    this.stopPolling()
    this.stopTimer()
    await this.fetchState()
  }

  /** Scenario names come from the server; the picker only works between games. */
  private async loadScenarios() {
    try {
      const { scenarios, current }: { scenarios: string[]; current: string } = await (await fetch('/api/scenarios')).json()
      const select = document.getElementById('scenario-select') as HTMLSelectElement
      select.replaceChildren(...scenarios.map(n => new Option(`Scenario: ${n}`, n)))
      select.value = current
    } catch (err) {
      console.error('Failed to list scenarios:', err)
    }
  }

  /** Fill the Load dropdown from the server's saved games (text nodes only: ids come from disk). */
  private async refreshSaves() {
    const select = document.getElementById('load-select') as HTMLSelectElement
    try {
      const saves: SaveSummary[] = await (await fetch('/api/games')).json()
      if (!saves.length && select.options.length > 1) return
      select.length = 1
      for (const g of saves) {
        const who = g.status === 'finished' ? (g.victor ? `${g.victor} won` : 'draw') : 'in progress'
        const opt = new Option(`T${g.turn}/${g.maxTurns} ${who} · seed ${g.seed} · ${g.savedAt.slice(0, 16).replace('T', ' ')}`, g.id)
        opt.title = Object.entries(g.models).map(([f, m]) => `${f}: ${m}`).join('\n')
        select.add(opt)
      }
    } catch (err) {
      console.error('Failed to list saved games:', err)
    }
  }

  /** Replace the current game with a saved one; an unfinished game comes back paused. */
  private async loadGame(id: string) {
    this.clearLocal()
    const res = await this.post('/api/load', { id })
    if (!res.ok) console.error('Load failed:', await res.text())
    await this.fetchState()
    await this.fetchChat()
    void this.loadScenarios()
  }

  private async resetGame() {
    await this.post('/api/reset')
    this.clearLocal()
    await this.fetchState()
  }

  private startPolling() {
    if (this.pollInterval) return
    this.pollInterval = setInterval(() => {
      this.fetchState()
      this.fetchChat()
    }, 2000)
  }

  private stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  private toggle(id: string, visible: boolean) {
    document.getElementById(id)!.classList.toggle('hidden', !visible)
  }

  /** Buttons, speed slider and polling all follow what the server says it is doing. */
  private syncControls() {
    const { running, paused, turnExecuting, intervalMs } = this.control
    this.toggle('btn-start', !running)
    this.toggle('btn-pause', running && !paused)
    this.toggle('btn-resume', running && paused)
    this.toggle('btn-stop', running)
    ;(document.getElementById('scenario-select') as HTMLSelectElement).disabled = running
    ;(document.getElementById('btn-step') as HTMLButtonElement).disabled = turnExecuting
    if (!this.speedSynced) {
      this.speedSynced = true
      ;(document.getElementById('speed') as HTMLInputElement).value = String(Math.round(intervalMs / 1000))
      document.getElementById('speed-value')!.textContent = `${Math.round(intervalMs / 1000)}s`
    }
    if (running) {
      this.startPolling()
      if (!this.timerInterval) {
        this.startTime = Date.parse(this.state?.game.startedAt ?? '') || Date.now()
        this.timerInterval = setInterval(() => this.updateElapsed(), 1000)
      }
    }
  }

  private formatCost(usd: number, complete: boolean): string {
    const text = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
    return complete ? text : `\u2265${text}`
  }

  private formatTokens(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
  }

  private renderUsage(usage: UsageSnapshot | undefined) {
    const costEl = document.getElementById('cost-total')!
    if (!usage || usage.total.calls === 0) {
      costEl.textContent = '-'
      document.getElementById('cost-stat')!.title = 'Estimated API spend this game'
    } else {
      const t = usage.total
      costEl.textContent = t.costUsd > 0 || t.costComplete ? this.formatCost(t.costUsd, t.costComplete) : 'n/a'
      const n = usage.roles.narrator
      document.getElementById('cost-stat')!.title =
        `${t.calls} AI calls, ${this.formatTokens(t.inputTokens)} in / ${this.formatTokens(t.outputTokens)} out tokens` +
        (t.costComplete ? '' : ' (some models have no known price: this is a lower bound)') +
        (n ? `\nNarrator: ${n.provider} ${n.model}, ${this.formatCost(n.costUsd, n.costComplete)}` : '')
    }
    for (const fid of ['nato', 'russia', 'china']) {
      const panel = document.getElementById(`faction-${fid}`)
      if (!panel) continue
      const r = usage?.roles[fid]
      if (!r) {
        panel.querySelector('.f-ai')!.textContent = '-'
        panel.querySelector('.f-cost')!.textContent = ''
        continue
      }
      panel.querySelector('.f-ai')!.textContent = `${r.provider} \u00b7 ${r.model}`
      panel.querySelector('.f-cost')!.textContent =
        `${r.costUsd > 0 || r.costComplete ? this.formatCost(r.costUsd, r.costComplete) : 'n/a'} \u00b7 ${this.formatTokens(r.inputTokens + r.outputTokens)} tok`
    }
  }

  private async fetchState() {
    try {
      const res = await fetch('/api/state')
      this.state = await res.json()
      this.render()
    } catch (err) {
      console.error('Failed to fetch state:', err)
    }
  }

  private async fetchChat() {
    try {
      const res = await fetch(`/api/chat?since=${this.chatIndex}`)
      const json = await res.json()
      // Handle both formats: { messages, total } or flat array
      const messages: ChatMessage[] = Array.isArray(json) ? json : (json.messages || [])
      const total: number = Array.isArray(json) ? (this.chatIndex + messages.length) : json.total
      if (messages.length > 0) {
        this.chatMessages.push(...messages)
        if (this.chatMessages.length > 200) this.chatMessages = this.chatMessages.slice(-200)
        this.chatIndex = total
        this.renderChat()
        // Flash the intel feed to signal new messages
        const feedEl = document.getElementById('intel-feed')!
        feedEl.classList.remove('new-intel')
        void feedEl.offsetWidth
        feedEl.classList.add('new-intel')
        setTimeout(() => feedEl.classList.remove('new-intel'), 2000)
      }
    } catch (err) {
      console.error('Failed to fetch chat:', err)
    }
  }

  private render() {
    if (!this.state) return

    // Render map
    this.map.render(this.state)

    this.control = this.state.control ?? this.control
    this.syncControls()
    this.renderUsage(this.state.usage)

    // Update turn counter
    const turnEl = document.getElementById('turn-counter')!
    turnEl.textContent = `TURN ${this.state.game.turn} / ${this.state.game.maxTurns}`

    // Update status
    const statusEl = document.getElementById('game-status')!
    if (this.state.game.status === 'finished') {
      const victorName = this.state.game.victor ? this.state.factions[this.state.game.victor]?.name : null
      statusEl.textContent = victorName ? `VICTORY: ${victorName}` : 'DRAW'
      statusEl.style.color = this.state.game.victor ? FACTION_COLORS[this.state.game.victor] : '#fff'
      this.stopPolling()
      this.stopTimer()
      this.map.stopCamera()
      if (!this.gameEndShown) {
        this.gameEndShown = true
        // Fetch all remaining chat, then wait for animations to finish before showing summary
        this.fetchChat().then(() => {
          const waitForEffects = () => {
            if (this.map.hasActiveAnimations()) {
              setTimeout(waitForEffects, 300)
            } else {
              setTimeout(() => this.showGameSummary(), 2000)
            }
          }
          waitForEffects()
        })
      }
    } else {
      const paused = this.control.running && this.control.paused
      statusEl.textContent = paused ? 'PAUSED' : this.state.game.status === 'active' ? 'ACTIVE' : 'WAITING'
      statusEl.style.color = paused ? '#f39c12' : '#4caf50'
    }

    this.updateElapsed()

    // Show turn briefing overlay on new turn
    if (this.state.game.turn > this.lastDisplayedTurn && this.state.game.turn > 0) {
      this.lastDisplayedTurn = this.state.game.turn
      this.showTurnBriefing(this.state)
      if (this.warRoom.isOpen) this.warRoom.refresh(this.chatMessages, this.state)
    }

    // Update faction panels
    for (const [factionId, faction] of Object.entries(this.state.factions)) {
      const panel = document.getElementById(`faction-${factionId}`)
      if (!panel) continue

      const res = faction.resources
      const tech = faction.tech

      panel.querySelector('.f-territories')!.textContent = `${faction.territoryCount}`
      panel.querySelector('.f-units')!.textContent = `${faction.units.length}`
      panel.querySelector('.f-gold')!.textContent = `${res.gold}`
      panel.querySelector('.f-food')!.textContent = `${res.food}`
      panel.querySelector('.f-iron')!.textContent = `${res.iron}`
      panel.querySelector('.f-influence')!.textContent = `${res.influence}`
      panel.querySelector('.f-knowledge')!.textContent = `${res.knowledge}`
      panel.querySelector('.f-score')!.textContent = `${faction.score}`
      panel.querySelector('.f-uranium')!.textContent = `${res.uranium || 0}`
      panel.querySelector('.f-nukes')!.textContent = (faction.nukes || 0).toLocaleString()
      panel.querySelector('.f-tech-mil')!.textContent = `${tech.military}`
      panel.querySelector('.f-tech-eco')!.textContent = `${tech.economic}`
      panel.querySelector('.f-tech-int')!.textContent = `${tech.intelligence}`
      panel.querySelector('.f-tech-nuc')!.textContent = `${tech.nuclear || 0}`

      const allyEl = panel.querySelector('.f-allies')!
      allyEl.textContent = faction.alliances.length > 0
        ? faction.alliances.map(a => this.state!.factions[a]?.name || a).join(', ')
        : 'None'
    }
  }

  private showTurnBriefing(state: GameState & { recentEvents?: GameEvent[] }) {
    const events = (state.recentEvents || []).filter(e => e.type !== 'invalid' && e.type !== 'forfeit')

    // Spawn toasts one-by-one with staggered timing
    const toastContainer = document.getElementById('capture-toasts')!
    for (let i = 0; i < events.length; i++) {
      const evt = events[i]
      const icon = EVENT_ICONS[evt.type] || '\uD83C\uDFF4'
      const color = evt.faction ? (FACTION_COLORS[evt.faction] || '#888') : '#888'
      setTimeout(() => {
        const toast = document.createElement('div')
        toast.className = `capture-toast ${evt.type} ${evt.faction || ''}`
        toast.style.borderLeftColor = color
        toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-text">${renderMarkdown(evt.description)}</span>`
        toastContainer.appendChild(toast)
        // Trigger exit animation then remove
        setTimeout(() => {
          toast.classList.add('exiting')
          setTimeout(() => toast.remove(), 400)
        }, 4000)
      }, i * 500)
    }
  }

  private renderChat() {
    const feedEl = document.getElementById('intel-feed')!

    // All channels in one feed
    const messages = this.chatMessages.filter(m =>
      m.channel === 'command' || m.channel === 'observer' || m.channel === 'diplomacy'
    )

    let html = ''
    for (const msg of messages.slice(-60)) {
      const isDiplo = msg.channel === 'diplomacy'
      const isNews = msg.agent === 'narrator'
      const color = isDiplo ? (FACTION_COLORS[msg.agent] || '#888') : msg.agent === 'gm' ? '#9b59b6' : isNews ? '#1abc9c' : '#888'
      const sourceTag = isDiplo ? '<span class="feed-source diplo">DIPLO</span>' : isNews ? '<span class="feed-source news">NEWS</span>' : ''
      html += `<div class="chat-msg">${sourceTag}<span class="chat-agent" style="color:${color}">[${msg.agentName}]</span> <span class="chat-text">${renderMarkdown(msg.message)}</span></div>`
    }
    if (this.warRoom.isOpen) this.warRoom.update(this.chatMessages)
    feedEl.innerHTML = html || '<div class="chat-msg chat-empty">Awaiting intelligence...</div>'
    feedEl.scrollTop = feedEl.scrollHeight

    // Combined command feed in sidebar
    const combinedEl = document.getElementById('chat-combined')
    if (combinedEl) {
      const factionMsgs = this.chatMessages.filter(m => m.channel === 'nato' || m.channel === 'russia' || m.channel === 'china')
      let combinedHtml = ''
      for (const msg of factionMsgs.slice(-30)) {
        const color = FACTION_COLORS[msg.agent] || '#888'
        combinedHtml += `<div class="chat-msg"><span class="chat-agent" style="color:${color}">[${msg.agentName}]</span> <span class="chat-text">${renderMarkdown(msg.message)}</span></div>`
      }
      combinedEl.innerHTML = combinedHtml || '<div class="chat-msg chat-empty">Awaiting orders...</div>'
      combinedEl.scrollTop = combinedEl.scrollHeight
    }
  }

  private showGameSummary() {
    if (!this.state) return

    const modal = document.getElementById('game-summary-modal')!
    const body = document.getElementById('summary-modal-body')!

    // Victor info
    const victor = this.state.game.victor
    const victorName = victor ? (this.state.factions[victor]?.name || victor) : 'Draw'
    const victorColor = victor ? (FACTION_COLORS[victor] || '#fff') : '#888'

    // Final scores
    let scoresHtml = ''
    const sortedFactions = Object.entries(this.state.factions).sort((a, b) => b[1].score - a[1].score)
    for (const [fId, faction] of sortedFactions) {
      const color = FACTION_COLORS[fId] || '#888'
      const isVictor = fId === victor
      scoresHtml += `<div class="summary-faction ${isVictor ? 'victor' : ''}">
        <span class="summary-faction-name" style="color:${color}">${faction.name}</span>
        <span class="summary-faction-stats">${faction.territoryCount} territories - ${faction.units.length} units</span>
        <span class="summary-faction-score" style="color:${color}">${faction.score} pts</span>
      </div>`
    }

    // Key events from narrator recaps (one per turn)
    const narrations = this.chatMessages
      .filter(m => m.channel === 'observer')
      .slice(-10) // last 10 turns of recaps

    let timelineHtml = ''
    for (const msg of narrations) {
      timelineHtml += `<div class="summary-timeline-entry">
        <span class="summary-timeline-turn">T${msg.turn}</span>
        <span class="summary-timeline-text">${renderMarkdown(msg.message)}</span>
      </div>`
    }

    body.innerHTML = `
      <div class="summary-header">
        <div class="summary-title">GAME OVER</div>
        <div class="summary-victor" style="color:${victorColor}">${victor ? `${victorName} wins` : 'Draw'}</div>
        <div class="summary-subtitle">Turn ${this.state.game.turn} / ${this.state.game.maxTurns}${this.state.game.seed !== undefined ? ` &middot; seed ${this.state.game.seed}` : ''}${this.state.game.scenario ? ` &middot; ${this.state.game.scenario}` : ''}${this.state.game.structuredOutput ? ' &middot; structured output' : ''}${this.state.usage?.total.calls ? ` &middot; ${this.formatCost(this.state.usage.total.costUsd, this.state.usage.total.costComplete)}` : ''}</div>
      </div>
      <div class="summary-section">
        <div class="summary-section-title">FINAL STANDINGS</div>
        ${scoresHtml}
      </div>
      <div class="summary-section">
        <div class="summary-section-title">SCORECARD</div>
        <div id="summary-scorecard" style="color:var(--text-muted)">Loading...</div>
      </div>
      <div class="summary-section">
        <div class="summary-section-title">KEY MOMENTS</div>
        <div class="summary-timeline">${timelineHtml || '<div style="color:var(--text-muted)">No recaps recorded.</div>'}</div>
      </div>
      <div class="summary-actions">
        <button class="btn summary-btn-details" id="btn-full-details">FULL DETAILS</button>
        <button class="btn summary-btn-close" id="btn-close-summary">CLOSE</button>
      </div>
    `

    // Wire up buttons
    document.getElementById('btn-full-details')!.addEventListener('click', () => {
      this.showFullDetails(body)
    })
    document.getElementById('btn-close-summary')!.addEventListener('click', () => {
      modal.classList.add('hidden')
    })

    modal.classList.remove('hidden')
    void this.fillScorecard(document.getElementById('summary-scorecard')!)
  }

  /** Per-seat results: which model played each seat, how it did and what it cost. Text nodes only. */
  private async fillScorecard(host: HTMLElement) {
    try {
      const card: Scorecard = await (await fetch('/api/scorecard')).json()
      const table = document.createElement('table')
      table.className = 'scorecard'
      const head = table.createTHead().insertRow()
      for (const h of ['Seat / model', 'Rank', 'Score', 'Valid orders', 'Latency', 'Cost']) {
        const th = document.createElement('th')
        th.textContent = h
        head.appendChild(th)
      }
      const body = table.createTBody()
      for (const r of card.rows) {
        const tr = body.insertRow()
        const first = tr.insertCell()
        first.textContent = `${this.state?.factions[r.faction]?.name ?? r.faction}${r.provider ? ` - ${r.provider} ${r.model}` : ''}`
        first.style.color = FACTION_COLORS[r.faction] ?? ''
        tr.insertCell().textContent = `${r.rank}${r.won ? ' (won)' : ''}`
        tr.insertCell().textContent = String(r.score)
        tr.insertCell().textContent = r.validRate === null ? '-' : `${Math.round(r.validRate * 100)}% (${r.invalid} bad / ${r.orders})`
        tr.insertCell().textContent = r.avgLatencyMs === null ? '-' : `${(r.avgLatencyMs / 1000).toFixed(1)}s`
        tr.insertCell().textContent = r.calls ? this.formatCost(r.costUsd, r.costComplete) : '-'
      }
      host.replaceChildren(table)
    } catch {
      host.textContent = 'Scorecard unavailable.'
    }
  }

  private showFullDetails(container: HTMLElement) {
    // Replace modal content with full chat log
    const allMessages = this.chatMessages

    let html = `
      <div class="summary-header">
        <div class="summary-title">FULL INTELLIGENCE LOG</div>
        <div class="summary-subtitle">${allMessages.length} messages across ${this.state?.game.turn || 0} turns</div>
      </div>
      <div class="summary-full-log">
    `

    for (const msg of allMessages) {
      const isDiplo = msg.channel === 'diplomacy'
      const isNews = msg.agent === 'narrator'
      const color = isDiplo ? (FACTION_COLORS[msg.agent] || '#888') : msg.agent === 'gm' ? '#9b59b6' : isNews ? '#1abc9c' : '#888'
      const sourceTag = isDiplo ? '<span class="feed-source diplo">DIPLO</span>' : isNews ? '<span class="feed-source news">NEWS</span>' : ''
      html += `<div class="chat-msg">${sourceTag}<span class="chat-agent" style="color:${color}">[T${msg.turn} ${msg.agentName}]</span> <span class="chat-text">${renderMarkdown(msg.message)}</span></div>`
    }

    html += `</div>
      <div class="summary-actions">
        <button class="btn summary-btn-close" id="btn-back-summary">BACK</button>
        <button class="btn summary-btn-close" id="btn-close-summary-2">CLOSE</button>
      </div>
    `

    container.innerHTML = html

    document.getElementById('btn-back-summary')!.addEventListener('click', () => {
      this.showGameSummary()
    })
    document.getElementById('btn-close-summary-2')!.addEventListener('click', () => {
      document.getElementById('game-summary-modal')!.classList.add('hidden')
    })
  }
}

function renderMarkdown(str: string): string {
  // Escape HTML first
  let out = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // **bold**
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // *italic*
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>')
  // __bold__
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>')
  // _italic_
  out = out.replace(/\b_(.+?)_\b/g, '<em>$1</em>')
  // `code`
  out = out.replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:2px;font-size:10px;">$1</code>')
  return out
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  new WarGamesApp()
})
