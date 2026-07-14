import { describe, expect, it } from "vitest";
import {
  completeFirstRunGeneration,
  markFirstRunGenerationStarted,
  releaseFirstRunGeneration,
  reserveFirstRunGeneration,
} from "../first-run-generation.server";

function memoryDeps(dailyLimit = 30) {
  const rows = new Map<
    string,
    {
      id: string;
      shopId: string;
      runId: string;
      productId: string;
      attempt: number;
      result: unknown | null;
      providerStarted: boolean;
      failureResult: unknown | null;
    }
  >();
  let sequence = 0;
  return {
    rows,
    deps: {
      async reserve(input: {
        shopId: string;
        runId: string;
        productId: string;
        attempt: number;
      }) {
        const key = `${input.shopId}:${input.runId}:${input.productId}:${input.attempt}`;
        const existing = rows.get(key);
        if (existing) {
          return existing.result === null
            ? {
                outcome: "in_progress" as const,
                regenerationsLeft: Math.max(0, 3 - input.attempt),
              }
            : {
                outcome: "replay" as const,
                result: existing.result,
                regenerationsLeft: Math.max(0, 3 - input.attempt),
              };
        }
        if (
          [...rows.values()].filter((row) => row.shopId === input.shopId)
            .length >= dailyLimit
        ) {
          return {
            outcome: "daily_limit" as const,
            regenerationsLeft: 0,
          };
        }
        const id = `reservation-${++sequence}`;
        rows.set(key, {
          ...input,
          id,
          result: null,
          providerStarted: false,
          failureResult: null,
        });
        return {
          outcome: "reserved" as const,
          id,
          regenerationsLeft: Math.max(0, 3 - input.attempt),
        };
      },
      async complete(shopId: string, id: string, result: unknown) {
        for (const row of rows.values()) {
          if (row.shopId === shopId && row.id === id) row.result = result;
        }
      },
      async markStarted(shopId: string, id: string, failureResult: unknown) {
        for (const row of rows.values()) {
          if (row.shopId === shopId && row.id === id) {
            row.providerStarted = true;
            row.failureResult = failureResult;
          }
        }
      },
      async remove(shopId: string, id: string) {
        for (const [key, row] of rows) {
          if (row.shopId === shopId && row.id === id && !row.providerStarted)
            rows.delete(key);
        }
      },
    },
  };
}

describe("first-run creative generation reservations", () => {
  it("allows one initial generation and exactly two regenerations", async () => {
    const { deps } = memoryDeps();
    for (const [attempt, left] of [
      [1, 2],
      [2, 1],
      [3, 0],
    ] as const) {
      await expect(
        reserveFirstRunGeneration("shop", "run", "product", attempt, deps),
      ).resolves.toMatchObject({
        ok: true,
        kind: "reserved",
        regenerationsLeft: left,
      });
    }
  });

  it("fences an in-flight duplicate and replays its completed response", async () => {
    const { deps } = memoryDeps();
    const reserved = await reserveFirstRunGeneration(
      "shop",
      "run",
      "product",
      1,
      deps,
    );
    expect(reserved).toMatchObject({ ok: true, kind: "reserved" });
    if (!reserved.ok || reserved.kind !== "reserved") return;

    await expect(
      reserveFirstRunGeneration("shop", "run", "product", 1, deps),
    ).resolves.toMatchObject({ ok: false, reason: "in_progress" });

    const response = { available: true, variants: ["owned"] };
    await completeFirstRunGeneration("shop", reserved.id, response, deps);
    await expect(
      reserveFirstRunGeneration("shop", "run", "product", 1, deps),
    ).resolves.toMatchObject({
      ok: true,
      kind: "replay",
      result: response,
    });
  });

  it("applies the independent shop ceiling", async () => {
    const { deps } = memoryDeps(1);
    await reserveFirstRunGeneration("shop", "run-a", "product", 1, deps);
    await expect(
      reserveFirstRunGeneration("shop", "run-b", "product", 1, deps),
    ).resolves.toMatchObject({ ok: false, reason: "daily_limit" });
  });

  it("releases a request when no provider was invoked", async () => {
    const { deps } = memoryDeps();
    const reserved = await reserveFirstRunGeneration(
      "shop",
      "run",
      "product",
      2,
      deps,
    );
    expect(reserved.ok).toBe(true);
    if (!reserved.ok || reserved.kind !== "reserved") return;
    await releaseFirstRunGeneration("shop", reserved.id, deps);
    await expect(
      reserveFirstRunGeneration("shop", "run", "product", 2, deps),
    ).resolves.toMatchObject({
      ok: true,
      kind: "reserved",
      regenerationsLeft: 1,
    });
  });

  it("never releases the cost ledger after a provider starts", async () => {
    const { deps, rows } = memoryDeps();
    const reserved = await reserveFirstRunGeneration(
      "shop",
      "run",
      "product",
      1,
      deps,
    );
    if (!reserved.ok || reserved.kind !== "reserved") return;
    const fallback = { available: false, variants: [] };
    await markFirstRunGenerationStarted("shop", reserved.id, fallback, deps);
    await releaseFirstRunGeneration("shop", reserved.id, deps);
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({
      providerStarted: true,
      failureResult: fallback,
    });
  });
});
