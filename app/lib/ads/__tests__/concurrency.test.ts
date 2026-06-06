import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("processes all items and preserves result order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([
      { ok: true, value: 10 }, { ok: true, value: 20 },
      { ok: true, value: 30 }, { ok: true, value: 40 },
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; return n;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("isolates failures: one rejection does not abort the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("fail-2");
      return n;
    });
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toEqual({ ok: true, value: 3 });
  });
});
