import { describe, expect, it, vi } from "vitest";
import type { StorefrontReleaseReader, StorefrontVersionRecord } from "./release-resolution.server";
import { resolveStorefrontRelease } from "./release-resolution.server";

const SHOP = "11111111-1111-1111-1111-111111111111";

function version(id: string, runtimeVersion: number, createdAt: string): StorefrontVersionRecord {
  return {
    id,
    shopId: SHOP,
    sourceKind: runtimeVersion === 0 ? "legacy" : "custom",
    status: "validated",
    schemaVersion: 1,
    runtimeVersion,
    validationProfileVersion: runtimeVersion === 0 ? 0 : 1,
    artifactHash: `sha256:${id}`,
    artifact: runtimeVersion === 0
      ? { sourceKind: "legacy", snapshot: { schemaVersion: 1, runtimeVersion: 0, validationProfileVersion: 0 } }
      : { sourceKind: "custom", bundle: { schemaVersion: 1, runtimeVersion } },
    createdAt,
  } as StorefrontVersionRecord;
}

function reader(published: StorefrontVersionRecord | null, history: StorefrontVersionRecord[]): StorefrontReleaseReader {
  return {
    readPublished: vi.fn(async () => published),
    readRetainedHistory: vi.fn(async () => history),
  };
}

describe("storefront release resolution", () => {
  it("keeps runtime-0 selected unless the runtime-1 read flag is enabled", async () => {
    const legacy = version("legacy", 0, "2026-07-01T00:00:00Z");
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const source = reader(live, [legacy]);
    await expect(resolveStorefrontRelease({ shopId: SHOP, runtime1Enabled: false, reader: source }))
      .resolves.toMatchObject({ kind: "runtime0-snapshot", version: legacy });
    await expect(resolveStorefrontRelease({ shopId: SHOP, runtime1Enabled: true, reader: source }))
      .resolves.toMatchObject({ kind: "runtime1", version: live });
    expect(source.readPublished).toHaveBeenCalledWith(SHOP);
    expect(source.readRetainedHistory).toHaveBeenCalledWith(SHOP);
  });

  it("falls back to the newest compatible retained history when the pointer is unsupported", async () => {
    const unsupported = version("future", 2, "2026-07-03T00:00:00Z");
    const older = version("older", 1, "2026-07-01T00:00:00Z");
    const newest = version("newest", 1, "2026-07-02T00:00:00Z");
    const resolved = await resolveStorefrontRelease({
      shopId: SHOP,
      runtime1Enabled: true,
      reader: reader(unsupported, [older, newest]),
    });
    expect(resolved).toMatchObject({ kind: "runtime1", version: newest, fallbackFromVersionId: "future" });
  });

  it("uses unchanged live runtime-0 when no immutable release exists", async () => {
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      runtime1Enabled: true,
      reader: reader(null, []),
    })).resolves.toEqual({ kind: "runtime0-live" });
  });
});
