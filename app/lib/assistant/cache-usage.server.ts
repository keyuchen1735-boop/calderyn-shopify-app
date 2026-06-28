// Central, in-memory tally of Anthropic token usage. Every Claude call across
// every surface flows through the wrapped client in anthropic.server.ts, which
// reports its response usage here — so the real dollar impact of prompt caching
// is measurable from one place (cache reads bill ~0.1x, cache writes ~1.25x).
// Surfaces never call this directly.
import type Anthropic from "@anthropic-ai/sdk";

export interface CacheTotals {
  calls: number;
  /** Uncached prompt tokens, billed at full input price. */
  uncachedInputTokens: number;
  /** Tokens served from cache, billed ~0.1x input. */
  cacheReadTokens: number;
  /** Tokens written to cache, billed ~1.25x input (5-minute TTL). */
  cacheWriteTokens: number;
  outputTokens: number;
}

function empty(): CacheTotals {
  return {
    calls: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  };
}

let totals = empty();

export function recordUsage(usage: Anthropic.Usage | null | undefined): void {
  if (!usage) return;
  totals.calls += 1;
  totals.uncachedInputTokens += usage.input_tokens ?? 0;
  totals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  totals.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
}

export function getCacheTotals(): CacheTotals {
  return { ...totals };
}

export function resetCacheTotals(): void {
  totals = empty();
}

/** USD per million tokens. Cache read = 0.1x input, cache write (5m) = 1.25x input. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Default model is claude-sonnet-4-6: $3/MTok in, $15/MTok out.
export const SONNET_4_6_RATES: Rates = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

/** Actual USD billed for these totals (caching applied). */
export function costUsd(t: CacheTotals, r: Rates = SONNET_4_6_RATES): number {
  return (
    t.uncachedInputTokens * r.input +
    t.cacheReadTokens * r.cacheRead +
    t.cacheWriteTokens * r.cacheWrite +
    t.outputTokens * r.output
  ) / 1_000_000;
}

/** Counterfactual USD for the same tokens with NO caching: every cached token
 *  billed at full input price, no write premium. Subtract costUsd to get savings. */
export function costUsdWithoutCaching(t: CacheTotals, r: Rates = SONNET_4_6_RATES): number {
  const allInput = t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return (allInput * r.input + t.outputTokens * r.output) / 1_000_000;
}

/** Fraction of prompt tokens served from cache (0..1). 0 when nothing was cached. */
export function cacheHitRate(t: CacheTotals): number {
  const prompt = t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  return prompt === 0 ? 0 : t.cacheReadTokens / prompt;
}
