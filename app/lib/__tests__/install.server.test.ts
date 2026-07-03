// The shared install routine — the single path both the embedded afterAuth
// hook and the dashboard OAuth callback run. The load-bearing behaviors: the
// tenant is always provisioned (reactivating uninstalled shops), the ingest
// pipeline is always enqueued, and the inline backfill only runs for the
// embedded first install.
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  provisionShop,
  resolveShopId,
  registerCarrierService,
  enqueueShopifyBackfill,
  shopifyNeverSynced,
  resurfaceAllSnoozes,
  backfillShop,
} = vi.hoisted(() => ({
  provisionShop: vi.fn(async () => undefined),
  resolveShopId: vi.fn(async () => "shop-1"),
  registerCarrierService: vi.fn(async () => ({})),
  enqueueShopifyBackfill: vi.fn(async () => undefined),
  shopifyNeverSynced: vi.fn(async () => true),
  resurfaceAllSnoozes: vi.fn(async () => undefined),
  backfillShop: vi.fn(async () => ({})),
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({}),
  provisionShop,
  resolveShopId,
}));
vi.mock("../shipping/carrier-service.server", () => ({ registerCarrierService }));
vi.mock("../ingest/enqueue.server", () => ({ enqueueShopifyBackfill, shopifyNeverSynced }));
vi.mock("../actions/snooze.server", () => ({ resurfaceAllSnoozes }));
vi.mock("../ingest/backfill.server", () => ({ backfillShop }));

// eslint-disable-next-line import/first
import { completeShopInstall } from "../install.server";

const admin = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeShopInstall", () => {
  it("provisions the tenant, registers the carrier, and enqueues ingest on every install", async () => {
    await completeShopInstall({ shop: "x.myshopify.com", admin, inlineBackfill: false });
    expect(provisionShop).toHaveBeenCalledWith("x.myshopify.com");
    expect(registerCarrierService).toHaveBeenCalled();
    expect(enqueueShopifyBackfill).toHaveBeenCalledWith("x.myshopify.com");
    expect(resurfaceAllSnoozes).toHaveBeenCalled();
    // Dashboard connect: the 12-month import run covers the initial pull.
    expect(backfillShop).not.toHaveBeenCalled();
  });

  it("runs the inline first-install backfill only on the embedded path", async () => {
    await completeShopInstall({ shop: "x.myshopify.com", admin, inlineBackfill: true });
    expect(backfillShop).toHaveBeenCalledWith("x.myshopify.com");
  });

  it("a carrier-registration failure never blocks the rest of the install", async () => {
    registerCarrierService.mockRejectedValueOnce(new Error("plan not eligible"));
    await completeShopInstall({ shop: "x.myshopify.com", admin, inlineBackfill: false });
    expect(enqueueShopifyBackfill).toHaveBeenCalled();
    expect(resurfaceAllSnoozes).toHaveBeenCalled();
  });

  it("a provisioning failure propagates — callers gate on the tenant", async () => {
    provisionShop.mockRejectedValueOnce(new Error("supabase down"));
    await expect(
      completeShopInstall({ shop: "x.myshopify.com", admin, inlineBackfill: false }),
    ).rejects.toThrow("supabase down");
    expect(enqueueShopifyBackfill).not.toHaveBeenCalled();
  });
});
