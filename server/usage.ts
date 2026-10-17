/** Per-game token, latency and cost tally for each AI role (nato, russia, china, narrator). */

export interface CallUsage {
  provider: string
  model: string
  /** Undefined when the provider returned no token counts. */
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
  /** Estimated USD; null when the price or the token counts are unknown. */
  costUsd: number | null
}

export interface RoleUsage {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  latencyMs: number
  /** False once any call had no price or no token counts, so costUsd is a lower bound. */
  costComplete: boolean
}

export interface UsageSnapshot {
  roles: Record<string, RoleUsage>
  total: { calls: number; inputTokens: number; outputTokens: number; costUsd: number; costComplete: boolean }
}

export class UsageTracker {
  private roles: Record<string, RoleUsage> = {}

  record(role: string, u: CallUsage) {
    const r = (this.roles[role] ??= {
      provider: u.provider,
      model: u.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      costComplete: true,
    })
    r.calls++
    r.inputTokens += u.inputTokens ?? 0
    r.outputTokens += u.outputTokens ?? 0
    r.latencyMs += u.latencyMs
    if (u.costUsd === null) r.costComplete = false
    else r.costUsd += u.costUsd
  }

  snapshot(): UsageSnapshot {
    const total = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costComplete: true }
    for (const r of Object.values(this.roles)) {
      total.calls += r.calls
      total.inputTokens += r.inputTokens
      total.outputTokens += r.outputTokens
      total.costUsd += r.costUsd
      if (!r.costComplete) total.costComplete = false
    }
    return { roles: structuredClone(this.roles), total }
  }
}
