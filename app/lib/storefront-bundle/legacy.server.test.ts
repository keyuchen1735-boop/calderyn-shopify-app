import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureLegacyRelease } from "./legacy.server";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ rpc }) }));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({ listProducts: async () => [], listCollections: async () => [] }),
}));

const SHOP = "11111111-1111-1111-1111-111111111111";
const LEGACY = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  rpc.mockReset()
    .mockResolvedValueOnce({
      data: {
        snapshot: {
          schemaVersion: 1,
          runtimeVersion: 0,
          validationProfileVersion: 0,
          pageDocuments: {
            home: { kind: "singleton", pageKey: "home", blocks: [] },
            collection: null,
            pdp: null,
          },
          storeSettings: {},
          referencedAssetKeys: [],
          capturedAt: "2026-07-13T00:00:00.000Z",
        },
        assetManifest: { entries: [] },
        sourceAssets: [],
        captureToken: `sha256:${"b".repeat(64)}`,
      },
      error: null,
    })
    .mockResolvedValueOnce({ data: `sha256:${"a".repeat(64)}`, error: null })
    .mockResolvedValueOnce({ data: LEGACY, error: null });
});

describe("legacy storefront release capture", () => {
  it("delegates one-time, transactionally consistent capture to the database", async () => {
    await expect(captureLegacyRelease({ shopId: SHOP, actorId: null })).resolves.toBe(LEGACY);
    expect(rpc).toHaveBeenNthCalledWith(1, "prepare_storefront_legacy_capture", { p_shop_id: SHOP });
    expect(rpc).toHaveBeenNthCalledWith(3, "capture_storefront_legacy_release", expect.objectContaining({
      p_shop_id: SHOP,
      p_actor_id: null,
      p_snapshot: expect.objectContaining({ runtimeVersion: 0 }),
      p_validation_report: expect.objectContaining({ legacyAdapter: "validated" }),
      p_artifact_hash: `sha256:${"a".repeat(64)}`,
      p_capture_token: `sha256:${"b".repeat(64)}`,
    }));
  });

  it("returns the existing immutable capture id on repeated calls", async () => {
    await captureLegacyRelease({ shopId: SHOP });
    rpc.mockReset().mockResolvedValue({ data: { existingVersionId: LEGACY }, error: null });
    await expect(captureLegacyRelease({ shopId: SHOP })).resolves.toBe(LEGACY);
    expect(rpc).toHaveBeenCalledWith("prepare_storefront_legacy_capture", { p_shop_id: SHOP });
  });

  it("refuses a malformed legacy snapshot before capture", async () => {
    rpc.mockReset().mockResolvedValueOnce({ data: { snapshot: { pageDocuments: "bad" }, assetManifest: { entries: [] } }, error: null });
    await expect(captureLegacyRelease({ shopId: SHOP })).rejects.toMatchObject({ code: "legacy_capture_invalid" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
