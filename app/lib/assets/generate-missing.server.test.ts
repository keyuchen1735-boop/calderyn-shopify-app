import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { generateMissingProductImages } from "./generate-missing.server";
import { storefrontProofContext } from "../storefront-validation/fixtures";

const SHOP_ID = "11111111-1111-1111-1111-111111111111";

describe("generateMissingProductImages", () => {
  it("generates every missing image in the 61-product proof merchant", async () => {
    const missing = storefrontProofContext().products.filter((product) => product.images.length === 0);
    const claims = missing.map((product) => ({
      shop_id: SHOP_ID,
      product_id: product.id,
      title: product.title,
      description: `Complete merchant description for ${product.title}`,
      attempt_count: 1,
      lease_expires_at: "2026-07-16T00:05:00.000Z",
    }));
    const rpc = vi.fn().mockResolvedValue({ data: claims, error: null });
    const generate = vi.fn(async (claim: (typeof claims)[number]) => ({ url: `owned://${claim.product_id}` }));
    const update = vi.fn().mockResolvedValue({ data: [{ shop_id: SHOP_ID }], error: null });

    await expect(generateMissingProductImages(10, {
      rpc,
      generate,
      update,
    })).resolves.toEqual({ claimed: 10, ready: 10, failed: 0, skipped: 0 });
    expect(missing).toHaveLength(10);
    expect(rpc).toHaveBeenCalledWith(10);
    expect(generate.mock.calls.map(([claim]) => claim.product_id).sort()).toEqual(missing.map(({ id }) => id).sort());
    expect(update).toHaveBeenCalledTimes(10);
  });

  it("claims a bounded batch and reports ready and failed results", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { shop_id: SHOP_ID, product_id: "a", title: "A", description: "", attempt_count: 1, lease_expires_at: "2026-07-16T00:05:00.000Z" },
        { shop_id: SHOP_ID, product_id: "b", title: "B", description: "", attempt_count: 1, lease_expires_at: "2026-07-16T00:05:00.000Z" },
      ],
      error: null,
    });
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ url: "owned://a" })
      .mockRejectedValueOnce(new Error("provider down"));
    const update = vi.fn().mockResolvedValue({ data: [{ shop_id: SHOP_ID }], error: null });

    await expect(
      generateMissingProductImages(2, {
        rpc,
        generate,
        update,
        now: () => new Date("2026-07-16T00:00:00.000Z"),
      }),
    ).resolves.toEqual({ claimed: 2, ready: 1, failed: 1, skipped: 0 });

    expect(rpc).toHaveBeenCalledWith(2);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ product_id: "a" }),
      expect.objectContaining({ status: "ready", url: "owned://a" }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ product_id: "b" }),
      expect.objectContaining({ status: "failed", next_attempt_at: "2026-07-16T00:05:00.000Z" }),
    );
  });

  it("surfaces claim and state-write errors", async () => {
    await expect(
      generateMissingProductImages(1, {
        rpc: vi.fn().mockResolvedValue({ data: null, error: new Error("claim failed") }),
        generate: vi.fn(),
        update: vi.fn(),
      }),
    ).rejects.toThrow("claim failed");

    await expect(
      generateMissingProductImages(1, {
        rpc: vi.fn().mockResolvedValue({
          data: [{ shop_id: SHOP_ID, product_id: "a", title: "A", description: "", attempt_count: 1, lease_expires_at: "2026-07-16T00:05:00.000Z" }],
          error: null,
        }),
        generate: vi.fn().mockResolvedValue({ url: "owned://a" }),
        update: vi.fn().mockResolvedValue({ data: null, error: new Error("write failed") }),
      }),
    ).rejects.toThrow("write failed");
  });

  it.each([
    ["success", vi.fn().mockResolvedValue({ url: "owned://a" }), "ready"],
    ["failure", vi.fn().mockRejectedValue(new Error("provider down")), "failed"],
  ])("reports a lost %s finalization race as skipped", async (_case, generate, status) => {
    const update = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(generateMissingProductImages(1, {
      rpc: vi.fn().mockResolvedValue({
        data: [{
          shop_id: SHOP_ID,
          product_id: "a",
          title: "A",
          description: "",
          attempt_count: 1,
          lease_expires_at: "2026-07-16T00:05:00.000Z",
        }],
        error: null,
      }),
      generate,
      update,
    })).resolves.toEqual({ claimed: 1, ready: 0, failed: 0, skipped: 1 });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ lease_expires_at: "2026-07-16T00:05:00.000Z" }),
      expect.objectContaining({ status }),
    );
  });
});

describe("store asset generation claim migration", () => {
  const sql = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../supabase/migrations/20260716_store_asset_generation_claims.sql",
    ),
    "utf8",
  ).toLowerCase();

  it("atomically claims only missing imagery with leases and bounded retries", () => {
    const seed = sql.match(/with missing as materialized \(([\s\S]+?)\), seeded as/)?.[1] ?? "";
    const candidates = sql.match(/return query\s+with candidates as materialized \(([\s\S]+?)\), claimed as/)?.[1] ?? "";
    expect(sql).toMatch(/status[^;]+pending[^;]+ready[^;]+failed/);
    expect(sql).toContain("attempt_count");
    expect(sql).toContain("next_attempt_at");
    expect(sql).toContain("lease_expires_at");
    expect(sql).toMatch(/create or replace function public\.claim_missing_storefront_images/);
    expect(sql).toMatch(/limit greatest\(0, least\(coalesce\(p_limit, 10\), 50\)\)/);
    expect(sql).toMatch(/for update of sa skip locked/);
    expect(sql).toMatch(/not exists[^;]+public\.product_media/s);
    expect(sql).toMatch(/not exists[^;]+status = 'ready'/s);
    expect(sql).toMatch(/order by[^;]+latest_version_at desc nulls last/s);
    expect(seed).toMatch(/not exists[^;]+public\.store_asset queued[^;]+queued\.source = 'gemini'/s);
    expect(seed).not.toMatch(/coalesce\(v\.latest_version_at/);
    expect(candidates).toMatch(/p\.status = 'active'/);
  });

  it("exposes the invoker RPC only to service_role", () => {
    expect(sql).toMatch(/language plpgsql\s+security invoker\s+set search_path = ''/);
    expect(sql).toMatch(/revoke all on function public\.claim_missing_storefront_images\(integer\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.claim_missing_storefront_images\(integer\) to service_role/);
  });
});
