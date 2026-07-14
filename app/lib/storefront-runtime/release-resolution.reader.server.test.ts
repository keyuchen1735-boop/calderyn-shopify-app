import { beforeEach, describe, expect, it, vi } from "vitest";
import { storefrontReleaseReader } from "./release-resolution.server";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

function versionRow(id: string) {
  return {
    id,
    shop_id: "shop-1",
    source_kind: id === "legacy" ? "legacy" : "custom",
    status: "validated",
    schema_version: 1,
    runtime_version: id === "legacy" ? 0 : 1,
    validation_profile_version: id === "legacy" ? 0 : 1,
    artifact_hash: `sha256:${id}`,
    bundle_json: id === "legacy"
      ? { sourceKind: "legacy", snapshot: {} }
      : { sourceKind: "custom", bundle: { schemaVersion: 1, runtimeVersion: 1 } },
    created_at: "2026-07-13T00:00:00Z",
  };
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from(table: string) {
      const query: Record<string, unknown> = {};
      const chain = (method: string) => (...args: unknown[]) => {
        mocks.calls.push({ table, method, args });
        return query;
      };
      Object.assign(query, {
        select: chain("select"),
        eq: chain("eq"),
        in: chain("in"),
        order: chain("order"),
        range: (from: number, to: number) => {
          mocks.calls.push({ table, method: "range", args: [from, to] });
          const row = {
            from_version_id: "legacy",
            to_version_id: "live",
            operation: "publish",
            created_at: "2026-07-13T00:00:00Z",
          };
          return Promise.resolve({ data: from === 0 ? Array.from({ length: 100 }, () => row) : [row], error: null });
        },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: table === "storefront_bundle_version" ? [versionRow("legacy"), versionRow("live")] : [],
          error: null,
        }).then(resolve),
      });
      return query;
    },
  }),
}));

beforeEach(() => {
  mocks.calls.length = 0;
});

describe("storefront release history reader", () => {
  it("filters to publish/rollback operations and paginates before loading shop-scoped versions", async () => {
    const history = await storefrontReleaseReader.readReleaseHistory("shop-1");

    expect(history).toHaveLength(101);
    expect(mocks.calls).toContainEqual({
      table: "storefront_release_history",
      method: "in",
      args: ["operation", ["publish", "rollback"]],
    });
    expect(mocks.calls.filter((call) => call.table === "storefront_release_history" && call.method === "range"))
      .toEqual([
        { table: "storefront_release_history", method: "range", args: [0, 99] },
        { table: "storefront_release_history", method: "range", args: [100, 199] },
      ]);
    expect(mocks.calls).toContainEqual({
      table: "storefront_bundle_version",
      method: "eq",
      args: ["shop_id", "shop-1"],
    });
  });
});
