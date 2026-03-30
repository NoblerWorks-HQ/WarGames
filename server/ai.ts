/**
 * AI integration for War Games
 *
 * Provides getFactionOrders() and getNarrative() using whichever
 * AI provider is configured via AI_PROVIDER env var.
 */

import { getProvider } from './ai-provider.js'
import type { FactionOrders } from './types.js'

export async function getFactionOrders(
  factionId: string,
  persona: string,
  briefing: string
): Promise<FactionOrders> {
  try {
    const provider = getProvider(factionId)

    const prompt = `${persona}

CURRENT BRIEFING:
${briefing}

Respond with ONLY valid JSON. No prose, no markdown, no code fences.
Use territory IDs (snake_case like "western_na", "central_asia") not display names.
Format: {"orders":[{"action":"move|attack|fortify|recruit|trade|spy|research|diplomacy",...params}],"reasoning":"<1 sentence>"}`

    console.log(`[${factionId}] Requesting orders from ${provider.name}...`)
    const text = await provider.generate(prompt)
    console.log(`[${factionId}] Raw response:`, text.slice(0, 300))

    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()

    const parsed = JSON.parse(cleaned) as FactionOrders
    if (!Array.isArray(parsed.orders)) {
      console.log(`[${factionId}] Invalid format - no orders array`)
      return { orders: [], reasoning: 'Invalid response format - forfeited turn' }
    }
    // Cap at 3 orders
    parsed.orders = parsed.orders.slice(0, 3)
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

export async function getNarrative(turnSummary: string): Promise<string> {
  try {
    const provider = getProvider('narrator')

    const prompt = `You are The Chronicler, narrator of the War Games.

Write a dramatic 2-3 sentence narrative recap of this turn like a CNN breaking news bulletin. Use real leader names: President Trump (NATO/USA), President Putin (Russia), President Xi Jinping (China). Reference real territory names, countries, and geographic regions. Make it compelling and realistic - military operations, nuclear threats, diplomatic betrayals, economic warfare. Keep it under 80 words.

TURN SUMMARY:
${turnSummary}`

    console.log(`[narrator] Requesting narrative from ${provider.name}...`)
    const text = await provider.generate(prompt)
    console.log('[narrator] Got narrative:', text.slice(0, 100))
    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[narrator] AI error: ${msg}`)
    return 'The fog of war obscures the events of this turn...'
  }
}
