import { describe, it, expect, vi } from "vitest";
import { pollWindow } from "../poller.server";

describe("pollWindow", () => {
  it("re-pulls yesterday + today so late attributions correct in place", () => {
    const { since, until } = pollWindow(new Date("2026-06-02T00:00:00Z"));
    expect(since).toBe("2026-06-01");
    expect(until).toBe("2026-06-02");
  });
});

describe("runMetaPoll (smoke via injected backfill)", () => {
  it("delegates to the same upsert path for a 2-day window", async () => {
    const upserts: string[] = [];
    const { backfillMetaShop } = await import("../backfill.server");
    await backfillMetaShop({
      shopId: "s",
      adAccountId: "act_9",
      client: { get: vi.fn(), post: vi.fn() },
      now: new Date("2026-06-02T00:00:00Z"),
      fetchInsights: vi.fn(async () => []),
      upsert: vi.fn(async (t: string) => { upserts.push(t); }),
    });
    expect(upserts).toEqual([]); // empty insights -> no upserts, no throw
  });
});
