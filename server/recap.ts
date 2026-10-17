/**
 * A finished (or in-progress) game as one self-contained HTML page: no scripts, no external
 * requests, so it can be emailed, attached or dropped on any static host. Everything a model
 * wrote is escaped; nothing from the game is ever inserted as markup.
 */

import type { SavedGame } from './engine.js'
import { buildScorecard } from './scorecard.js'

const COLORS: Record<string, string> = { nato: '#3498db', russia: '#e74c3c', china: '#f1c40f' }

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const usd = (x: number, complete: boolean) => `${complete ? '' : '\u2265'}$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`

/** Territories held per faction after each turn, as an inline SVG line chart. */
function controlChart(g: SavedGame): string {
  const frames = g.turnHistory.filter(t => t.frame)
  if (frames.length < 2) return ''
  const ids = Object.keys(g.state.factions)
  const W = 640
  const H = 200
  const pad = 28
  const maxY = Math.max(4, ...frames.flatMap(t => ids.map(id => t.frame!.factions[id]?.territoryCount ?? 0)))
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (frames.length - 1)
  const y = (v: number) => H - pad - (v * (H - 2 * pad)) / maxY
  const lines = ids
    .map(id => {
      const pts = frames.map((t, i) => `${x(i).toFixed(1)},${y(t.frame!.factions[id]?.territoryCount ?? 0).toFixed(1)}`).join(' ')
      return `<polyline fill="none" stroke="${COLORS[id] ?? '#999'}" stroke-width="2.5" points="${pts}"><title>${esc(g.state.factions[id].name)}</title></polyline>`
    })
    .join('')
  const grid = [0, Math.round(maxY / 2), maxY]
    .map(v => `<line x1="${pad}" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
    .join('')
  const ticks = frames
    .map((t, i) => (i === 0 || i === frames.length - 1 || frames.length <= 10 || i % 5 === 4 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">T${t.turn}</text>` : ''))
    .join('')
  return `<figure><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Territories held per turn">${grid}${lines}${ticks}</svg><figcaption>Territories held after each turn</figcaption></figure>`
}

export function renderRecap(g: SavedGame): string {
  const s = g.state
  const card = buildScorecard(s, g.turnHistory, { roles: g.usage })
  const victor = s.game.victor ? s.factions[s.game.victor] : null
  const finished = s.game.status === 'finished'
  const headline = !finished ? `In progress: turn ${s.game.turn} of ${s.game.maxTurns}` : victor ? `${victor.name} wins` : 'Draw'
  const how = finished ? (g.turnHistory.at(-1)?.events.find(e => e.type === 'victory')?.description ?? '') : ''
  const meta = [
    `Turn ${s.game.turn} / ${s.game.maxTurns}`,
    s.game.scenario && `scenario ${s.game.scenario}`,
    `seed ${g.seed}`,
    s.game.structuredOutput && 'structured output',
    card.rows.some(r => r.calls) && `est. cost ${usd(card.rows.reduce((n, r) => n + r.costUsd, 0) + (g.usage.narrator?.costUsd ?? 0), card.rows.every(r => r.costComplete) && (g.usage.narrator?.costComplete ?? true))}`,
  ].filter(Boolean)

  const rows = [...card.rows]
    .sort((a, b) => a.rank - b.rank)
    .map(r => {
      const seat = s.game.seats?.[r.faction]
      const model = seat ? `${seat.provider} ${seat.model}` : r.provider ? `${r.provider} ${r.model}` : '-'
      return `<tr><td><span class="dot" style="background:${COLORS[r.faction] ?? '#999'}"></span>${esc(s.factions[r.faction].name)}${r.won ? ' <b>(won)</b>' : ''}</td><td>${esc(model)}</td><td>${r.rank}</td><td>${r.score}</td><td>${r.territories}</td><td>${r.validRate === null ? '-' : `${Math.round(r.validRate * 100)}%`}</td><td>${r.forfeits}</td><td>${r.calls ? esc(usd(r.costUsd, r.costComplete)) : '-'}</td></tr>`
    })
    .join('')

  const timeline = g.turnHistory
    .map(t => {
      const big = t.events.filter(e => ['capture', 'nuke', 'betrayal', 'victory', 'diplomacy'].includes(e.type) && !/proposes/.test(e.description))
      const text = t.narrative || big.map(e => e.description).join('. ') || 'A quiet turn.'
      const tags = big.length && t.narrative ? `<ul>${big.slice(0, 6).map(e => `<li>${esc(e.description)}</li>`).join('')}</ul>` : ''
      return `<li><span class="turn">T${t.turn}</span><div><p>${esc(text)}</p>${tags}</div></li>`
    })
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`War Games recap: ${headline}`)}</title>
<style>
:root { --bg: #0d1014; --fg: #e8e8e8; --muted: #9aa0a6; --line: rgba(255,255,255,.12); --card: #151a20; }
@media (prefers-color-scheme: light) { :root { --bg: #f7f7f5; --fg: #1b1d20; --muted: #5f6368; --line: rgba(0,0,0,.12); --card: #fff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.9rem; margin: 0 0 4px; }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 36px 0 12px; }
.meta, figcaption, .foot { color: var(--muted); font-size: .85rem; }
.how { margin: 6px 0 0; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
svg { width: 100%; height: auto; font-size: 11px; fill: var(--muted); }
svg .grid { stroke: var(--line); }
ol { list-style: none; padding: 0; margin: 0; }
ol > li { display: flex; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.turn { flex: none; width: 36px; font-weight: 600; color: var(--muted); font-variant-numeric: tabular-nums; }
ol p { margin: 0; }
ol ul { margin: 6px 0 0; padding-left: 18px; color: var(--muted); font-size: .85rem; }
</style>
</head>
<body>
<main>
<h1>${esc(headline)}</h1>
${how ? `<p class="how">${esc(how)}</p>` : ''}
<p class="meta">${meta.map(m => esc(m)).join(' &middot; ')}</p>

<h2>Scorecard</h2>
<div class="table-wrap"><table>
<thead><tr><th>Faction</th><th>Model</th><th>Rank</th><th>Score</th><th>Territories</th><th>Valid orders</th><th>Forfeits</th><th>Cost</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>

${controlChart(g) ? `<h2>Control</h2>${controlChart(g)}` : ''}

<h2>How it unfolded</h2>
<ol>${timeline || '<li>No turns played.</li>'}</ol>

<p class="foot">Generated by War Games, an AI geopolitical strategy simulation: three language models command NATO, Russia and China. Game ${esc(g.id)}.</p>
</main>
</body>
</html>
`
}
