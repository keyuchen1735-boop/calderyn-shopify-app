import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StorefrontReleaseHistoryEntry,
  StorefrontReleaseReader,
  StorefrontReleaseResolutionError,
  StorefrontVersionRecord,
} from "./release-resolution.server";
import { resolveStorefrontRelease } from "./release-resolution.server";

const SHOP = "11111111-1111-1111-1111-111111111111";
const originalBundleRead = process.env.STOREFRONT_BUNDLE_READ;

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

function event(
  operation: StorefrontReleaseHistoryEntry["operation"],
  toVersion: StorefrontVersionRecord,
  fromVersion: StorefrontVersionRecord | null = null,
  occurredAt = "2026-07-13T00:00:00Z",
): StorefrontReleaseHistoryEntry {
  return { operation, fromVersion, toVersion, occurredAt };
}

function reader(
  published: StorefrontVersionRecord | null,
  history: StorefrontReleaseHistoryEntry[],
): StorefrontReleaseReader {
  return {
    readPublished: vi.fn(async () => published),
    readReleaseHistory: vi.fn(async () => history),
  };
}

afterEach(() => {
  if (originalBundleRead === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
  else process.env.STOREFRONT_BUNDLE_READ = originalBundleRead;
  delete process.env.STOREFRONT_RUNTIME_1_READ;
});

describe("storefront release resolution", () => {
  it("uses only STOREFRONT_BUNDLE_READ to select the immutable bundle", async () => {
    const legacy = version("legacy", 0, "2026-07-01T00:00:00Z");
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const source = reader(live, [event("publish", live, legacy)]);
    process.env.STOREFRONT_RUNTIME_1_READ = "1";
    process.env.STOREFRONT_BUNDLE_READ = "0";
    await expect(resolveStorefrontRelease({ shopId: SHOP, reader: source }))
      .resolves.toMatchObject({ kind: "runtime0-snapshot", version: legacy });
    process.env.STOREFRONT_BUNDLE_READ = "1";
    await expect(resolveStorefrontRelease({ shopId: SHOP, reader: source }))
      .resolves.toMatchObject({ kind: "runtime1", version: live });
  });

  it("ignores newer unpublished installs and preserves publish/rollback event order", async () => {
    const unsupported = version("future", 2, "2026-07-13T00:00:00Z");
    const immediatePublishedPredecessor = version("published-old", 1, "2026-01-01T00:00:00Z");
    const createdLaterButPublishedEarlier = version("created-newer", 1, "2026-06-01T00:00:00Z");
    const unpublishedDraft = version("unpublished-draft", 1, "2026-07-14T00:00:00Z");
    const history = [
      event("install_draft", unpublishedDraft, unsupported, "2026-07-14T00:00:00Z"),
      event("publish", unsupported, immediatePublishedPredecessor, "2026-07-13T00:00:00Z"),
      event("rollback", createdLaterButPublishedEarlier, null, "2026-07-12T00:00:00Z"),
    ];
    const resolved = await resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(unsupported, history),
    });
    expect(resolved).toMatchObject({
      kind: "runtime1",
      version: immediatePublishedPredecessor,
      fallbackFromVersionId: "future",
    });
  });

  it("accepts legacy capture only when it is the explicit predecessor of a publish", async () => {
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const publishedLegacy = version("legacy-published", 0, "2026-07-01T00:00:00Z");
    const neverPublishedCapture = version("legacy-unpublished", 0, "2026-07-03T00:00:00Z");
    const history = [
      event("capture_legacy", neverPublishedCapture, null, "2026-07-03T00:00:00Z"),
      event("publish", live, publishedLegacy, "2026-07-02T00:00:00Z"),
    ];
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: false,
      reader: reader(live, history),
    })).resolves.toMatchObject({ kind: "runtime0-snapshot", version: publishedLegacy });
  });

  it("fails safely when a published pointer has no compatible immutable predecessor", async () => {
    const unsupported = version("future", 2, "2026-07-03T00:00:00Z");
    const capturedButUnpublished = version("capture-only", 0, "2026-07-02T00:00:00Z");
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(unsupported, [event("capture_legacy", capturedButUnpublished)]),
    })).rejects.toEqual(expect.objectContaining<Partial<StorefrontReleaseResolutionError>>({
      code: "no_compatible_storefront_release",
      status: 503,
    }));
  });

  it("uses mutable runtime-0 only before any immutable published release exists", async () => {
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(null, []),
    })).resolves.toEqual({ kind: "runtime0-live" });
  });
});
