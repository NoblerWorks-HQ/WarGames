import type { ChatMessage, GameState, TurnResult } from './types.js'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

/** "move nato-inf-1 → ukraine", built from whichever fields the order has. */
function describeOrder(o: { action: string; [k: string]: unknown }): string {
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const dest = text(o.to) ?? text(o.target) ?? text(o.territory)
  const extra = [text(o.type), text(o.tech), text(o.proposal)]
  return [o.action, text(o.unit), dest && `→ ${dest}`, ...extra, o.offer ? JSON.stringify(o.offer) : undefined]
    .filter(Boolean)
    .join(' ')
}

/**
 * The war room: for one turn, side by side per leader, what they said in public,
 * what they were privately thinking, and what they actually ordered. All text
 * comes from models, so it is only ever inserted as text, never as HTML.
 */
export class WarRoom {
  private turns: TurnResult[] = []
  private chat: ChatMessage[] = []
  private state: GameState | null = null
  /** A turn number, or null to follow the latest turn. */
  private selected: number | null = null

  constructor(
    private modal: HTMLElement,
    private body: HTMLElement,
    private colors: Record<string, string>,
    /** Where turns come from: the live server, or a saved game viewed locally. */
    private loadTurns: () => Promise<TurnResult[]> = async () => (await fetch('/api/turns')).json()
  ) {
    modal.addEventListener('click', e => {
      if (e.target === modal) this.close()
    })
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden')
  }

  async open(chat: ChatMessage[], state: GameState) {
    this.modal.classList.remove('hidden')
    await this.refresh(chat, state)
  }

  close() {
    this.modal.classList.add('hidden')
  }

  /** A new game starts: forget the last one. */
  reset() {
    this.turns = []
    this.selected = null
    this.close()
  }

  async refresh(chat: ChatMessage[], state: GameState) {
    this.state = state
    this.chat = chat
    try {
      this.turns = await this.loadTurns()
    } catch (err) {
      console.error('Failed to fetch turns:', err)
    }
    this.render()
  }

  /** Re-draw with new chat messages, without refetching turns. */
  update(chat: ChatMessage[]) {
    this.chat = chat
    this.render()
  }

  private render() {
    const state = this.state
    this.body.replaceChildren()

    const head = el('div', 'wr-head')
    head.append(el('div', 'wr-title', 'War Room'))
    const tools = el('div', 'wr-tools')
    const select = el('select')
    const latest = el('option', undefined, 'Latest turn')
    latest.value = 'latest'
    select.append(latest)
    for (const t of [...this.turns].reverse()) {
      const opt = el('option', undefined, `Turn ${t.turn}`)
      opt.value = String(t.turn)
      select.append(opt)
    }
    select.value = this.selected === null ? 'latest' : String(this.selected)
    select.addEventListener('change', () => {
      this.selected = select.value === 'latest' ? null : Number(select.value)
      this.render()
    })
    const closeBtn = el('button', 'btn', 'Close')
    closeBtn.addEventListener('click', () => this.close())
    tools.append(select, closeBtn)
    head.append(tools)
    this.body.append(head)
    this.body.append(el('div', 'wr-sub', 'What each leader said in public, what they privately reasoned, and what they actually ordered.'))

    const turn = this.selected === null ? this.turns.at(-1) : this.turns.find(t => t.turn === this.selected)
    if (!state || !turn) {
      this.body.append(el('div', 'wr-empty', 'Nothing yet. Private reasoning appears here once the first turn has resolved.'))
      return
    }

    const grid = el('div', 'wr-grid')
    for (const [fid, faction] of Object.entries(state.factions)) {
      const col = el('div', 'wr-col')
      col.style.setProperty('--c', this.colors[fid] ?? '#888')
      col.append(el('div', 'wr-name', `${faction.name} · T${turn.turn}`))

      col.append(el('div', 'wr-h', 'Said publicly'))
      const said = this.chat.filter(m => m.channel === 'diplomacy' && m.agent === fid && m.turn === turn.turn)
      if (said.length === 0) col.append(el('div', 'wr-none', 'Silent.'))
      for (const m of said) {
        const line = el('div', 'wr-line wr-say')
        if (m.message.startsWith('(to ')) line.append(el('span', 'wr-tag', 'private'))
        line.append(m.message)
        col.append(line)
      }

      col.append(el('div', 'wr-h', 'Privately thinking'))
      const decided = turn.orders[fid]
      if (!decided?.reasoning && !decided?.notes) col.append(el('div', 'wr-none', 'No reasoning given.'))
      if (decided?.reasoning) col.append(el('div', 'wr-line wr-think', decided.reasoning))
      if (decided?.notes) {
        const note = el('div', 'wr-line wr-note')
        note.append(el('span', 'wr-tag', 'notes to self'), decided.notes)
        col.append(note)
      }

      col.append(el('div', 'wr-h', 'Ordered'))
      if (!decided || decided.orders.length === 0) col.append(el('div', 'wr-none', 'No orders.'))
      else {
        const orders = el('div')
        for (const o of decided.orders) orders.append(el('span', 'wr-order', describeOrder(o)))
        col.append(orders)
      }
      for (const e of turn.events.filter(ev => ev.faction === fid && ev.type !== 'message')) {
        col.append(el('div', `wr-result ${e.type}`, e.description))
      }
      grid.append(col)
    }
    this.body.append(grid)
  }
}
