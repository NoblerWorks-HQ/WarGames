/**
 * Token prices, USD per million tokens, for the default model of each provider.
 *
 * These are ESTIMATES from third-party price trackers (checked 2026-10-17), not
 * the vendors' own pages - check them before quoting a figure. Override either
 * price per provider in .env (both must be set):
 *   GEMINI_PRICE_INPUT_PER_M / GEMINI_PRICE_OUTPUT_PER_M
 *   OPENAI_PRICE_INPUT_PER_M / OPENAI_PRICE_OUTPUT_PER_M
 *   ANTHROPIC_PRICE_INPUT_PER_M / ANTHROPIC_PRICE_OUTPUT_PER_M
 * A model with no price gets no cost estimate (tokens are still counted).
 */
export interface Price {
  inputPerM: number
  outputPerM: number
}

const PRICES: { provider: string; model: RegExp; price: Price }[] = [
  { provider: 'gemini', model: /^gemini-3\.5-flash-lite/, price: { inputPerM: 0.3, outputPerM: 2.5 } },
  { provider: 'openai', model: /^gpt-5\.6-luna/, price: { inputPerM: 0.2, outputPerM: 1.2 } },
  { provider: 'anthropic', model: /^claude-sonnet-5/, price: { inputPerM: 2, outputPerM: 10 } },
]

export function priceFor(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): Price | null {
  const p = provider.toUpperCase()
  const input = Number(env[`${p}_PRICE_INPUT_PER_M`])
  const output = Number(env[`${p}_PRICE_OUTPUT_PER_M`])
  if (env[`${p}_PRICE_INPUT_PER_M`] && env[`${p}_PRICE_OUTPUT_PER_M`] && Number.isFinite(input) && Number.isFinite(output)) {
    return { inputPerM: input, outputPerM: output }
  }
  return PRICES.find(e => e.provider === provider && e.model.test(model))?.price ?? null
}

/** Estimated cost in USD, or null when the model has no known price or the provider reported no token counts. */
export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const price = priceFor(provider, model, env)
  if (!price || inputTokens === undefined || outputTokens === undefined) return null
  return (inputTokens * price.inputPerM + outputTokens * price.outputPerM) / 1_000_000
}
