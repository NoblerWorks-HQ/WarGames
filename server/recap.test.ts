/** The shareable recap: escapes model text, has no scripts, reports the right result. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)>'
vi.mock('./ai.js', () => ({
  getFactionOrders: vi.fn(async () => ({ orders: [{ action: 'message', message: EVIL }], reasoning: EVIL })),
  getNarrative: vi.fn(async () => `Breaking: ${EVIL} "quoted" & more`),
}))

const { GameEngine } = await import('./engine.js')
const { renderRecap } = await import('./recap.js')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

async function played(scenario = 'default', turns = 3) {
  const e = new GameEngine({ seed: 4, scenario })
  e.seats = { nato: { provider: 'anthropic', model: `m${EVIL}` }, russia: { provider: 'gemini', model: 'g' }, china: { provider: 'openai', model: 'o' } }
  e.reset()
  e.state.game.maxTurns = turns
  while (e.state.game.status === 'active') await e.executeTurn()
  return e
}

describe('renderRecap', () => {
  it('escapes everything a model wrote and contains no script or event handler', async () => {
    const html = renderRecap((await played()).snapshot())
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<[^>]*\son\w+=/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;quoted&quot; &amp; more')
  })

  it('names the winner, the seat models, the scenario and the seed, and draws the control chart', async () => {
    const e = await played()
    const html = renderRecap(e.snapshot())
    expect(html).toContain('<h1>NATO / United States wins</h1>')
    expect(html).toContain('anthropic m&lt;script&gt;')
    expect(html).toContain('gemini g')
    expect(html).toContain('scenario default')
    expect(html).toContain(`seed ${e.seed}`)
    expect(html.match(/<polyline/g)).toHaveLength(3)
    expect(html.match(/<span class="turn">/g)).toHaveLength(3)
  })

  it('reports a draw and an unfinished game honestly', async () => {
    expect(renderRecap((await played('mirror')).snapshot())).toContain('<h1>Draw</h1>')
    const e = new GameEngine({ seed: 1 })
    e.reset()
    await e.executeTurn()
    const html = renderRecap(e.snapshot())
    expect(html).toContain('In progress: turn 1 of 20')
    expect(html).not.toContain('<polyline')
  })
})
