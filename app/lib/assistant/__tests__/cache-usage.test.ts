import { describe, it, expect, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  recordUsage,
  getCacheTotals,
  resetCacheTotals,
  costUsd,
  costUsdWithoutCaching,
  cacheHitRate,
} from "../cache-usage.server";

const usage = (u: Partial<Anthropic.Usage>): Anthropic.Usage =>
  ({ input_tokens: 0, output_tokens: 0, ...u }) as Anthropic.Usage;

describe("cache-usage tally", () => {
  beforeEach(() => resetCacheTotals());

  it("accumulates cache reads/writes across calls and ignores null usage", () => {
    recordUsage(usage({ input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 50 }));
    recordUsage(null);
    recordUsage(usage({ input_tokens: 100, cache_creation_input_tokens: 2000, output_tokens: 50 }));

    const t = getCacheTotals();
    expect(t.calls).toBe(2);
    expect(t.uncachedInputTokens).toBe(200);
    expect(t.cacheReadTokens).toBe(2000);
    expect(t.cacheWriteTokens).toBe(2000);
    expect(t.outputTokens).toBe(100);
  });

  it("caching is cheaper than no caching once a prefix is re-read", () => {
    // Write a 2k prefix once, then read it 3 times.
    recordUsage(usage({ input_tokens: 100, cache_creation_input_tokens: 2000, output_tokens: 40 }));
    for (let i = 0; i < 3; i++) {
      recordUsage(usage({ input_tokens: 100, cache_read_input_tokens: 2000, output_tokens: 40 }));
    }
    const t = getCacheTotals();
    expect(costUsd(t)).toBeLessThan(costUsdWithoutCaching(t));
    expect(cacheHitRate(t)).toBeGreaterThan(0.5);
  });

  it("reports a zero hit rate when nothing was cached", () => {
    recordUsage(usage({ input_tokens: 500, output_tokens: 50 }));
    const t = getCacheTotals();
    expect(cacheHitRate(t)).toBe(0);
    // No caching anywhere => actual cost equals the counterfactual.
    expect(costUsd(t)).toBeCloseTo(costUsdWithoutCaching(t), 10);
  });
});
