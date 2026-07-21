import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProduct: vi.fn(),
  listCollections: vi.fn(),
  listProducts: vi.fn(),
  getStoreSettings: vi.fn(),
  getSeoOverride: vi.fn(),
  upsertSeoOverride: vi.fn(),
  deleteSeoOverride: vi.fn(),
  getSeoSettings: vi.fn(),
  upsertSeoSettings: vi.fn(),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    getProduct: mocks.getProduct,
    listCollections: mocks.listCollections,
    listProducts: mocks.listProducts,
  }),
}));
vi.mock("~/lib/storefront/settings.server", () => ({ getStoreSettings: mocks.getStoreSettings }));
vi.mock("~/lib/seo/seo-store.server", () => ({
  getSeoOverride: mocks.getSeoOverride,
  upsertSeoOverride: mocks.upsertSeoOverride,
  deleteSeoOverride: mocks.deleteSeoOverride,
  getSeoSettings: mocks.getSeoSettings,
  upsertSeoSettings: mocks.upsertSeoSettings,
}));

// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import { validateMeta } from "~/lib/seo/validator.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import {
  applyOrgRefresh,
  applySeoMeta,
  deterministicMeta,
  RadarApplyError,
  revertSeoMeta,
  sha256,
} from "../apply-seo.server";
// eslint-disable-next-line import/first -- vitest vi.hoisted() requires mocks before imports
import type { RadarMoveRow } from "../types";

const SHOP = "11111111-2222-3333-4444-555555555555";
const STORE = {
  shopId: SHOP,
  storeName: "Peak & Pine",
  logoUrl: null,
  voiceTagline: "Gear for the trail.",
  palette: { primary: "", background: "", text: "" },
  vibe: "minimal",
  typeStyle: "classic",
  density: "standard",
};
const PRODUCT = {
  id: "p1",
  handle: "trail-boots",
  title: "Trail Boots",
  description: "<p>Waterproof leather boots built for long days on rough ground.</p>",
  images: [],
  variants: [],
  collections: [],
};

function move(patch: Partial<RadarMoveRow>): RadarMoveRow {
  return {
    id: "m1",
    shopId: SHOP,
    kind: "seo_regression_patch",
    status: "draft",
    headline: "h",
    rationale: "r",
    evidence: { chips: [], facts: {} },
    payload: { applyMode: "publish_meta", entityType: "product", handle: "trail-boots", focusQuery: "trail boots" },
    dedupKey: "d",
    priorState: null,
    appliedStateHash: null,
    createdAt: "c",
    appliedAt: null,
    resolvedAt: null,
    expiresAt: "e",
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProduct.mockResolvedValue(PRODUCT);
  mocks.getStoreSettings.mockResolvedValue(STORE);
  mocks.getSeoOverride.mockResolvedValue(null);
  mocks.upsertSeoOverride.mockResolvedValue(undefined);
  mocks.deleteSeoOverride.mockResolvedValue(undefined);
  mocks.getSeoSettings.mockResolvedValue({ orgDescription: null });
  mocks.upsertSeoSettings.mockResolvedValue({});
  mocks.listCollections.mockResolvedValue([{ handle: "boots", title: "Hiking Boots" }]);
  mocks.listProducts.mockResolvedValue([PRODUCT]);
});

describe("deterministicMeta", () => {
  it("always lands inside the validator bounds, even for terse products", () => {
    for (const p of [PRODUCT, { ...PRODUCT, title: "X", description: "" }]) {
      const meta = deterministicMeta(p as never, "trail boots", STORE as never);
      expect(validateMeta(meta.title, meta.description)).toEqual([]);
      expect(meta.title.toLowerCase()).toContain("trail boots");
    }
  });
});

describe("applySeoMeta", () => {
  it("publishes a validator-clean product override and records revert state", async () => {
    const out = await applySeoMeta(SHOP, move({}), "u1");
    expect(mocks.upsertSeoOverride).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({
        entityType: "product",
        entityId: "p1",
        updatedBy: "u1",
        metaTitle: expect.any(String),
        metaDescription: expect.any(String),
      }),
    );
    expect(out.priorState).toMatchObject({ kind: "seo_meta", entityId: "p1", prior: null });
    expect(out.appliedStateHash).toHaveLength(64);
  });
  it("keeps the previous override for revert", async () => {
    mocks.getSeoOverride.mockResolvedValue({
      entityType: "product",
      entityId: "p1",
      metaTitle: "Old",
      metaDescription: "Old desc",
    });
    const out = await applySeoMeta(SHOP, move({}), null);
    expect(out.priorState).toMatchObject({ prior: { metaTitle: "Old", metaDescription: "Old desc" } });
  });
  it("409s when the product left the catalog", async () => {
    mocks.getProduct.mockResolvedValue(null);
    await expect(applySeoMeta(SHOP, move({}), null)).rejects.toMatchObject({
      code: "product_missing",
      status: 409,
    });
    expect(mocks.upsertSeoOverride).not.toHaveBeenCalled();
  });
});

describe("revertSeoMeta", () => {
  function applied(prior: { metaTitle: string; metaDescription: string } | null): RadarMoveRow {
    const written = { metaTitle: "New title for trail boots", metaDescription: "New description." };
    return move({
      status: "applied",
      priorState: { kind: "seo_meta", entityId: "p1", prior },
      appliedStateHash: sha256(written),
    });
  }
  it("restores the prior override (or deletes when there was none) after a clean hash check", async () => {
    mocks.getSeoOverride.mockResolvedValue({
      entityType: "product",
      entityId: "p1",
      metaTitle: "New title for trail boots",
      metaDescription: "New description.",
    });
    await revertSeoMeta(SHOP, applied(null), { confirm: false }, "u1");
    expect(mocks.deleteSeoOverride).toHaveBeenCalledWith(SHOP, "product", "p1");
    await revertSeoMeta(SHOP, applied({ metaTitle: "Old", metaDescription: "Old desc" }), { confirm: false }, "u1");
    expect(mocks.upsertSeoOverride).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ metaTitle: "Old", metaDescription: "Old desc" }),
    );
  });
  it("requires confirm when the live meta changed since apply", async () => {
    mocks.getSeoOverride.mockResolvedValue({
      entityType: "product",
      entityId: "p1",
      metaTitle: "Merchant edited",
      metaDescription: "Since then.",
    });
    await expect(revertSeoMeta(SHOP, applied(null), { confirm: false }, null)).rejects.toMatchObject({
      code: "revert_conflict",
      status: 409,
    });
    await revertSeoMeta(SHOP, applied(null), { confirm: true }, null);
    expect(mocks.deleteSeoOverride).toHaveBeenCalled();
  });
});

describe("applyOrgRefresh", () => {
  it("fills the store description deterministically and keeps the prior for revert", async () => {
    const out = await applyOrgRefresh(SHOP, move({ kind: "aeo_refresh", payload: { applyMode: "refresh_org" } }));
    expect(mocks.upsertSeoSettings).toHaveBeenCalledWith(SHOP, { orgDescription: expect.stringContaining("Peak & Pine") });
    expect(out.priorState).toMatchObject({ kind: "org", prior: null });
  });
});

describe("RadarApplyError", () => {
  it("carries code and status", () => {
    const err = new RadarApplyError("x", "y", 409);
    expect(err).toMatchObject({ code: "x", status: 409, message: "y" });
  });
});
