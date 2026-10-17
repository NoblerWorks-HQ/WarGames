/**
 * npm run tournament -- [options]
 *
 *   --lineup gemini,openai,anthropic   three entrants, "provider" or "provider:model" (repeats allowed)
 *   --scenarios default,mirror         scenarios to play
 *   --rounds 1                         each round plays every scenario 3 times (one per seat rotation)
 *   --max-turns 20                     cap game length (cheaper; recorded in the results)
 *   --budget 5                         USD: no new turn starts once the estimate reaches this
 *   --id <name>                        tournament id; re-running with the same id resumes
 *   --narrate                          also call the narrator each turn (off by default: extra cost, no effect on play)
 *   --allow-unpriced                   run models with no known price (their spend is NOT counted toward --budget)
 *   --dry-run                          print the schedule and exit without calling any model
 *
 * Output goes to games/tournaments/<id>/: one save per game, results.json and results.md.
 * STRUCTURED_OUTPUT=1 is honoured and recorded.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { parseArgs } from 'util'
import { GameEngine, listScenarios } from './engine.js'
import { parseProviderSpec, providerFor, setRoleProviders, structuredOutputEnabled } from './ai-provider.js'
import { SaveStore } from './saves.js'
import { priceFor } from './pricing.js'
import { makeEntrants, resultsMarkdown, runTournament, schedule } from './tournament.js'
import type { TournamentConfig } from './tournament.js'

const { values } = parseArgs({
  options: {
    lineup: { type: 'string', default: 'gemini,openai,anthropic' },
    scenarios: { type: 'string', default: 'default,mirror' },
    rounds: { type: 'string', default: '1' },
    'max-turns': { type: 'string' },
    budget: { type: 'string', default: '5' },
    id: { type: 'string' },
    narrate: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'allow-unpriced': { type: 'boolean', default: false },
  },
})

function fail(msg: string): never {
  console.error(`tournament: ${msg}`)
  process.exit(1)
}

const positiveInt = (name: string, v: string | undefined) => {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive whole number`)
  return n
}

let specs
try {
  specs = values.lineup.split(',').map(parseProviderSpec)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const scenarios = values.scenarios.split(',').map(s => s.trim()).filter(Boolean)
for (const s of scenarios) if (!listScenarios().includes(s)) fail(`unknown scenario "${s}" (have: ${listScenarios().join(', ')})`)
const budgetUsd = Number(values.budget)
if (!(budgetUsd > 0)) fail('--budget must be a positive number of US dollars')
const id = values.id ?? `t-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) fail('--id may only use letters, digits, - and _')

const dryRun = values['dry-run']
// A dry run never builds a provider, so it works without API keys; labels then show "default".
let entrants
try {
  entrants = makeEntrants(specs, s => (dryRun ? 'default' : providerFor(s).model))
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
const cfg: TournamentConfig = {
  id,
  entrants,
  scenarios,
  rounds: positiveInt('rounds', values.rounds)!,
  maxTurns: positiveInt('max-turns', values['max-turns']),
  budgetUsd,
  narrate: values.narrate,
  structuredOutput: structuredOutputEnabled(),
}

let games
try {
  games = schedule(cfg)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}
console.log(`Tournament ${id}: ${games.length} games, ${entrants.map(e => e.label).join(' vs ')}, budget $${budgetUsd}`)

if (dryRun) {
  for (const g of games) console.log(`  ${g.id}  seed ${g.seed}  ${Object.entries(g.seats).map(([s, l]) => `${s}=${l}`).join('  ')}`)
  process.exit(0)
}

// The budget is computed from known prices, so a model without one would spend unchecked.
const unpriced = entrants.filter(e => !priceFor(e.spec.provider, providerFor(e.spec).model))
if (unpriced.length && !values['allow-unpriced']) {
  fail(
    `no known price for ${unpriced.map(e => e.label).join(', ')}, so --budget cannot limit its spend. ` +
      'Set <PROVIDER>_PRICE_INPUT_PER_M and <PROVIDER>_PRICE_OUTPUT_PER_M, or pass --allow-unpriced.'
  )
}
if (unpriced.length) console.warn(`WARNING: ${unpriced.map(e => e.label).join(', ')} unpriced: their spend is not counted toward the budget`)

// Same boot check as the server: the key works and the model exists, before any money is spent.
for (const e of entrants) {
  const p = providerFor(e.spec)
  const check = await p.checkModel()
  if (check.status === 'bad-model' || check.status === 'bad-key') fail(`${e.label}: ${check.status}${check.detail ? ` - ${check.detail}` : ''}`)
  if (check.status === 'unverified') console.warn(`WARNING: could not verify ${e.label} - continuing`)
}

const root = process.env.GAMES_DIR ? resolve(process.env.GAMES_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), '../games')
const dir = resolve(root, 'tournaments', id)
mkdirSync(dir, { recursive: true })

// The engine's per-call logging is noise here; keep warnings and errors.
const quiet = console.log
console.log = () => {}
const results = await runTournament(cfg, {
  makeEngine: g => new GameEngine({ seed: g.seed, scenario: g.scenario, structuredOutput: cfg.structuredOutput, narrate: cfg.narrate }),
  store: new SaveStore(dir),
  pinSeats: setRoleProviders,
  log: line => quiet(line),
})
console.log = quiet

writeFileSync(resolve(dir, 'results.json'), JSON.stringify(results, null, 2))
writeFileSync(resolve(dir, 'results.md'), resultsMarkdown(results))
console.log(`\n${resultsMarkdown(results).split('\n## By scenario')[0]}`)
console.log(`Saved to ${dir}`)
