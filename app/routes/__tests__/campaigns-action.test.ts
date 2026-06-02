import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";
import { action } from "../app.campaigns";

// Spies for the boundaries; the real route `action` logic runs against them.
const { executeSpy, setStatusSpy, getStatusSpy, metaForShopSpy } = vi.hoisted(() => ({
  executeSpy: vi.fn(),
  setStatusSpy: vi.fn(),
  getStatusSpy: vi.fn(),
  metaForShopSpy: vi.fn(),
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

vi.mock("~/lib/meta/campaigns.server", () => ({
  getCampaignStatus: (...a: unknown[]) => getStatusSpy(...a),
  setCampaignStatus: (...a: unknown[]) => setStatusSpy(...a),
  listCampaigns: async () => [],
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
});

describe("campaigns action — Meta pause safety", () => {
  it("does NOT record an audit row when the Meta pause call fails", async () => {
    getStatusSpy.mockResolvedValue("ACTIVE");
    setStatusSpy.mockRejectedValue(new Error("Meta API error: Permission denied"));

    const res = await call(pauseRequest());
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

    const res = await call(pauseRequest());
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
