/**
 * AI integration for War Games
 *
 * Provides getFactionOrders() and getNarrative() using whichever
 * AI provider is configured via AI_PROVIDER env var.
 */

import { getProvider } from './ai-provider.js'
import type { AIProvider } from './ai-provider.js'
import { estimateCost } from './pricing.js'
import type { CallUsage } from './usage.js'
import type { FactionOrders } from './types.js'

/** Maximum orders a faction may submit per turn; extra orders are dropped. */
export const MAX_ORDERS = 3

/** Longest strategy note a faction may keep between turns. */
export const MAX_NOTES_CHARS = 300

/** Call the provider and report tokens, latency and estimated cost to `onUsage`. */
async function generateTracked(provider: AIProvider, prompt: string, onUsage?: (u: CallUsage) => void): Promise<string> {
  const started = Date.now()
  const result = await provider.generateWithUsage(prompt)
  onUsage?.({
    provider: provider.name,
    model: provider.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: Date.now() - started,
    costUsd: estimateCost(provider.name, provider.model, result.inputTokens, result.outputTokens),
  })
  return result.text
}

export async function getFactionOrders(
  factionId: string,
  persona: string,
  briefing: string,
  onUsage?: (u: CallUsage) => void
): Promise<FactionOrders> {
  try {
    const provider = getProvider(factionId)

    const prompt = `${persona}

CURRENT BRIEFING:
${briefing}

Respond with ONLY valid JSON. No prose, no markdown, no code fences.
Use territory IDs (snake_case like "western_na", "central_asia") not display names.
Use exact unit IDs from "units"; an order naming an unknown or out-of-range unit is rejected.
Each unit can move or attack once per turn. At most ${MAX_ORDERS} orders; extra orders are dropped.
Format: {"orders":[{"action":"move|attack|fortify|recruit|trade|spy|research|diplomacy|build_nuke|nuke|break_alliance|message|hire_mercenary",...params}],"reasoning":"<1 sentence>","notes":"<optional, max 300 chars: a private memo to yourself, returned as yourNotes next turn>"}`

    console.log(`[${factionId}] Requesting orders from ${provider.name}...`)
    const text = await generateTracked(provider, prompt, onUsage)
    console.log(`[${factionId}] Raw response:`, text.slice(0, 300))

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()

    const parsed = JSON.parse(cleaned) as FactionOrders
    if (!Array.isArray(parsed.orders)) {
      console.log(`[${factionId}] Invalid format - no orders array`)
      return { orders: [], reasoning: 'Invalid response format - forfeited turn' }
    }
    parsed.orders = parsed.orders.slice(0, MAX_ORDERS)
    if (typeof parsed.notes === 'string') parsed.notes = parsed.notes.trim().slice(0, MAX_NOTES_CHARS)
    else delete parsed.notes
    console.log(
      `[${factionId}] Got ${parsed.orders.length} orders: ${parsed.orders.map((o) => o.action).join(', ')}`
    )
    return parsed
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[${factionId}] AI error: ${msg}`)
    return { orders: [], reasoning: `API error: ${msg.slice(0, 50)}` }
  }
}

export async function getNarrative(turnSummary: string, onUsage?: (u: CallUsage) => void): Promise<string> {
  try {
    const provider = getProvider('narrator')

    const prompt = `You are The Chronicler, narrator of the War Games.

Write a dramatic 2-3 sentence narrative recap of this turn like a CNN breaking news bulletin. Use real leader names: President Trump (NATO/USA), President Putin (Russia), President Xi Jinping (China). Reference real territory names, countries, and geographic regions. Make it compelling and realistic - military operations, nuclear threats, diplomatic betrayals, economic warfare. Keep it under 80 words. If a public statement below is dramatic, quote or paraphrase it. If a previous bulletin is given, continue its storyline instead of repeating it.

TURN SUMMARY:
${turnSummary}`

    console.log(`[narrator] Requesting narrative from ${provider.name}...`)
    const text = await generateTracked(provider, prompt, onUsage)
    console.log('[narrator] Got narrative:', text.slice(0, 100))
    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[narrator] AI error: ${msg}`)
    return 'The fog of war obscures the events of this turn...'
  }
}
