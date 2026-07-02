import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { ActionFunctionArgs } from "react-router";
import { action } from "../app.campaigns._index";

// Spies for the boundaries; the real route `action` logic runs against them.
const {
  executeSpy,
  setStatusSpy,
  getStatusSpy,
  metaForShopSpy,
  executeActionSpy,
  resolveDimSpy,
  resolveShopIdSpy,
  executeReallocationSpy,
  suggestSpy,
} = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  getStatusSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
  executeActionSpy: vi.fn(),
  resolveDimSpy: vi.fn(),
  resolveShopIdSpy: vi.fn(),
  executeReallocationSpy: vi.fn(),
  suggestSpy: vi.fn(),
}));

// Stub Polaris so importing the route module doesn't pull the real UI lib.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    BlockStack: Stub,
    Banner: Stub,
    Box: Stub,
    Button: Stub,
    ButtonGroup: Stub,
    Card: Stub,
    DataTable: Stub,
    Modal: Stub,
    Page: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));

// app.campaigns.tsx imports `authenticate` from "../shopify.server" (= app/shopify.server).
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    actions: { execute: (...a: unknown[]) => executeSpy(...a) },
    campaigns: { list: async () => [] },
    alerts: { list: async () => [] },
  }),
}));

vi.mock("~/lib/meta/client.server", () => ({
  metaClientForShop: (...a: unknown[]) => metaForShopSpy(...a),
}));

vi.mock("~/lib/actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeActionSpy(...a),
}));

vi.mock("~/lib/ads/campaign-dim.server", () => ({
  resolveCampaignDimId: (...a: unknown[]) => resolveDimSpy(...a),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ __fake: "sb" }),
  resolveShopId: (...a: unknown[]) => resolveShopIdSpy(...a),
}));

vi.mock("~/lib/meta/campaigns.server", () => ({
  getCampaignStatus: (...a: unknown[]) => getStatusSpy(...a),
  setCampaignStatus: (...a: unknown[]) => setStatusSpy(...a),
  // The action verifies the campaign belongs to this shop's ad account before
  // mutating it, so the owned-campaign list must include the one under test (120).
  listCampaigns: async () => [
    { id: "120", name: "Prospecting", status: "ACTIVE", dailyBudgetCents: 5800 },
  ],
}));

vi.mock("~/lib/actions/reallocate.server", () => ({
  executeReallocation: (...a: unknown[]) => executeReallocationSpy(...a),
}));
vi.mock("~/lib/actions/reallocation-suggest.server", () => ({
  suggestReallocation: (...a: unknown[]) => suggestSpy(...a),
}));

function pauseRequest(): Request {
  const fd = new FormData();
  fd.set("intent", "pause");
  fd.set("campaignId", "120");
  fd.set("campaignName", "Prospecting");
  fd.set("platform", "Meta");
  fd.set("idempotencyKey", "k1");
  return new Request("http://localhost/app/campaigns", { method: "POST", body: fd });
}

function call(request: Request) {
  return action({ request } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  executeSpy.mockReset();
  setStatusSpy.mockReset();
  getStatusSpy.mockReset();
  metaForShopSpy.mockReset();
  metaForShopSpy.mockResolvedValue({ client: { get: vi.fn(), post: vi.fn() }, adAccountId: "act_1" });
  executeActionSpy.mockReset();
  resolveDimSpy.mockReset();
  resolveShopIdSpy.mockReset();
  resolveShopIdSpy.mockResolvedValue("shop-uuid-1");
});

describe("campaigns action — Meta pause safety", () => {
  it("does NOT record an audit row when the Meta pause call fails", async () => {
    getStatusSpy.mockResolvedValue("ACTIVE");
    setStatusSpy.mockRejectedValue(new Error("Meta API error: Permission denied"));

    const res = toResponse(await call(pauseRequest()));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(false);
    expect(setStatusSpy).toHaveBeenCalledWith(expect.anything(), "120", "PAUSED");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("records the TRUE fetched prior status (not one assumed from the intent)", async () => {
    // A distinctive live status the old hardcoded-from-intent code could never produce
    // for a pause — proves pre_state comes from getCampaignStatus, per the #1 fix.
    getStatusSpy.mockResolvedValue("ARCHIVED");
    setStatusSpy.mockResolvedValue(undefined);
    executeSpy.mockResolvedValue({});

    const res = toResponse(await call(pauseRequest()));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(executeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        preState: { status: "ARCHIVED", campaign_id: "120" },
        postState: { status: "PAUSED", campaign_id: "120" },
      }),
      expect.anything(),
    );
  });
});

describe("campaigns action — orchestrator wiring", () => {
  it("routes pause through executeAction with the resolved dim UUID when the campaign is ingested", async () => {
    resolveDimSpy.mockResolvedValue("dim-uuid-120");
    executeActionSpy.mockResolvedValue({ id: "aud1", outcome: "succeeded" });

    const res = toResponse(await call(pauseRequest()));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    // Reverse-lookup uses the posted Meta external id.
    expect(resolveDimSpy).toHaveBeenCalledWith(expect.anything(), "shop-uuid-1", "meta", "120");
    // Orchestrator is called with the dim uuid, the right kind, and idempotency key.
    expect(executeActionSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      expect.objectContaining({
        kind: "pause_campaign",
        campaignId: "dim-uuid-120",
        idempotencyKey: "k1",
      }),
      expect.anything(),
    );
    // The orchestrator owns the platform call — the route does NOT also hit Meta directly.
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it("maps resume to resume_campaign through the orchestrator when ingested", async () => {
    resolveDimSpy.mockResolvedValue("dim-uuid-120");
    executeActionSpy.mockResolvedValue({ id: "aud2", outcome: "succeeded" });

    const fd = new FormData();
    fd.set("intent", "resume");
    fd.set("campaignId", "120");
    fd.set("campaignName", "Prospecting");
    fd.set("platform", "Meta");
    fd.set("idempotencyKey", "k2");
    const res = toResponse(await call(
      new Request("http://localhost/app/campaigns", { method: "POST", body: fd }),
    ));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(executeActionSpy).toHaveBeenCalledWith(
      "shop-uuid-1",
      expect.objectContaining({ kind: "resume_campaign", campaignId: "dim-uuid-120" }),
      expect.anything(),
    );
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it("falls back to the direct Meta path when the campaign is not yet ingested (dim lookup null)", async () => {
    resolveDimSpy.mockResolvedValue(null);
    getStatusSpy.mockResolvedValue("ACTIVE");
    setStatusSpy.mockResolvedValue(undefined);
    executeSpy.mockResolvedValue({});

    const res = toResponse(await call(pauseRequest()));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    // Orchestrator is NOT used; the legacy direct-Meta path runs instead.
    expect(executeActionSpy).not.toHaveBeenCalled();
    expect(setStatusSpy).toHaveBeenCalledWith(expect.anything(), "120", "PAUSED");
    expect(executeSpy).toHaveBeenCalled();
  });
});

function reallocRequest(over: Record<string, string> = {}): Request {
  const fd = new FormData();
  fd.set("intent", "reallocate");
  fd.set("campaignId", "google-uuid-1"); // non-Meta → already the dim uuid
  fd.set("campaignName", "Brand Search");
  fd.set("platform", "Google");
  fd.set("destCampaignId", "tiktok-uuid-2");
  fd.set("destName", "Spark Ads");
  fd.set("destPlatform", "TikTok");
  fd.set("amountCents", "500");
  fd.set("idempotencyKey", "kr1");
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return new Request("http://test/app/campaigns", { method: "POST", body: fd });
}

describe("action · intent=reallocate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveShopIdSpy.mockResolvedValue("shop-uuid");
  });

  it("runs the reallocation through the orchestrator and reports success", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "succeeded" });
    const res = toResponse(await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs));
    const body = (await res.json()) as { ok: boolean; toast?: { message: string }; error?: { code: string; message: string } };
    expect(executeReallocationSpy).toHaveBeenCalledWith(
      "shop-uuid",
      expect.objectContaining({
        sourceCampaignId: "google-uuid-1",
        destCampaignId: "tiktok-uuid-2",
        amountCents: 500,
        idempotencyKey: "kr1",
        alertId: null,
      }),
      expect.anything(),
    );
    expect(body.ok).toBe(true);
    expect(body.toast!.message).toMatch(/\$5\.00.*Brand Search.*Spark Ads/);
  });

  it("rejects a non-positive amount with 400 and never calls the orchestrator", async () => {
    const res = toResponse(await action({ request: reallocRequest({ amountCents: "0" }), params: {}, context: {} } as ActionFunctionArgs));
    expect(res.status).toBe(400);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing destination with 400", async () => {
    const res = toResponse(await action({ request: reallocRequest({ destCampaignId: "" }), params: {}, context: {} } as ActionFunctionArgs));
    expect(res.status).toBe(400);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });

  it("returns 202 (not success) when the dest increase is parked for retry", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "retrying" });
    const res = toResponse(await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs));
    const body = (await res.json()) as { ok: boolean; toast?: { message: string }; error?: { code: string; message: string } };
    expect(res.status).toBe(202);
    expect(body.ok).toBe(false);
    expect(body.error!.code).toBe("ACTION_RETRYING");
  });

  it("returns 502 when the reallocation failed", async () => {
    executeReallocationSpy.mockResolvedValue({ id: "aud1", outcome: "failed" });
    const res = toResponse(await action({ request: reallocRequest(), params: {}, context: {} } as ActionFunctionArgs));
    expect(res.status).toBe(502);
  });

  it("requires Meta-listed campaigns to be ingested (409 when dim resolve fails)", async () => {
    resolveDimSpy.mockResolvedValue(null);
    const res = toResponse(await action(
      { request: reallocRequest({ platform: "Meta", campaignId: "120" }), params: {}, context: {} } as ActionFunctionArgs,
    ));
    expect(res.status).toBe(409);
    expect(executeReallocationSpy).not.toHaveBeenCalled();
  });
});
