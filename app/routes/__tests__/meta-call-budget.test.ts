/**
 * Meta call-budget contract for both merchant surfaces. Counts EXACTLY how
 * many Graph API calls each surface costs per interaction, by running the
 * REAL route actions and REAL executor/adapter over a counting MetaClient.
 * The numbers are the contract — a regression here silently multiplies spend
 * against the ad account's rate budget (Meta code 80004 at 300 calls/hour).
 *
 * Measured budget:
 *   dashboard action (pause/budget)            → 1 call
 *   extension action, ingested (orchestrated)  → 1 call
 *   extension action, legacy direct-Meta path  → 3 calls (list + read + write)
 *   extension campaigns loader (live list)     → 1 call per load/revalidation
 *   dashboard campaigns list                   → 0 calls (reads v_campaigns_flat)
 *     — not tested here: its route imports only calderynClient→Supabase and
 *       never constructs a MetaClient, so a mocked count would be vacuous.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { MetaClient } from "~/lib/meta/campaigns.server";

// The shop uuid appears inlined inside the vi.mock factories below — hoisting
// runs them before module consts exist, so only CAMP/EXT can live up here.
const CAMP = "11111111-1111-1111-1111-111111111111";
const EXT = "ext1";

const { counts, countingClient, resolveDimSpy } = vi.hoisted(() => {
  const counts = { get: 0, post: 0 };
  const countingClient: MetaClient = {
    async get(path) {
      counts.get += 1;
      // listCampaigns hits /<act>/campaigns; status/state reads hit /<id>.
      return path.endsWith("/campaigns")
        ? { data: [{ id: "ext1", name: "Ext One", status: "ACTIVE", daily_budget: "1000" }] }
        : { status: "ACTIVE", daily_budget: "1000" };
    },
    async post() {
      counts.post += 1;
      return { success: true };
    },
  };
  const resolveDimSpy = vi.fn(async (): Promise<string | null> => "11111111-1111-1111-1111-111111111111");
  return { counts, countingClient, resolveDimSpy };
});

// Real adapter logic (incl. its retry wrap) over the counting client.
vi.mock("~/lib/ads/action-registry.server", async () => {
  const { makeMetaActionAdapter } = await import("~/lib/meta/actions.server");
  return { actionAdapterForShop: async () => makeMetaActionAdapter(countingClient) };
});

// Compact fake Supabase: idempotency fresh, campaign owned, inserts succeed.
vi.mock("~/lib/supabase.server", () => {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.update = () => chain;
    chain.insert = () => chain;
    chain.maybeSingle = async () => {
      if (table === "ad_campaign_dim")
        return {
          data: {
            id: "11111111-1111-1111-1111-111111111111",
            shop_id: "00000000-0000-0000-0000-000000000010",
            external_id: "ext1",
            platform: "meta",
            status: "active",
            daily_budget_cents: 1000,
          },
          error: null,
        };
      return { data: null, error: null };
    };
    chain.single = async () => ({ data: { id: "aud1" }, error: null });
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  }
  return {
    getSupabase: () => ({ from: (t: string) => builder(t) }),
    resolveShopId: async () => "00000000-0000-0000-0000-000000000010",
  };
});

vi.mock("~/lib/ads/campaign-dim.server", () => ({
  resolveCampaignDimId: (...a: unknown[]) => resolveDimSpy(...(a as [])),
}));

// Surface boundaries: dashboard session, Shopify admin auth, UI modules.
vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: async () => ({ shopId: "00000000-0000-0000-0000-000000000010" }),
}));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub, BlockStack: Stub, Banner: Stub, Box: Stub, Button: Stub, ButtonGroup: Stub,
    Card: Stub, DataTable: Stub, InlineStack: Stub, Link: Stub, Modal: Stub, Page: Stub,
    Select: Stub, Text: Stub, TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));

// Extension loader/legacy dependencies: live-list client + legacy wrapper.
vi.mock("~/lib/meta/client.server", () => ({
  metaClientForShop: async () => ({ client: countingClient, adAccountId: "act_1" }),
}));
vi.mock("~/lib/calderyn.server", () => ({
  CalderynError: class CalderynError extends Error {
    status = 500;
    code = "ERR";
  },
  calderynClient: () => ({
    actions: { execute: async () => ({}) },
    campaigns: { list: async () => [] },
    alerts: { list: async () => [] },
  }),
}));

const PREV_DASHBOARD_URL = process.env.DASHBOARD_PUBLIC_URL;
const ORIGIN = "https://dashboard.call-budget.invalid";

beforeAll(() => {
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
});
afterAll(() => {
  if (PREV_DASHBOARD_URL === undefined) delete process.env.DASHBOARD_PUBLIC_URL;
  else process.env.DASHBOARD_PUBLIC_URL = PREV_DASHBOARD_URL;
});

beforeEach(() => {
  counts.get = 0;
  counts.post = 0;
  resolveDimSpy.mockResolvedValue(CAMP);
});

function dashboardPost(body: unknown): Request {
  return new Request(`${ORIGIN}/dashboard/api/campaigns/${CAMP}/action`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function extensionPost(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("https://app.call-budget.invalid/app/campaigns", { method: "POST", body: form });
}

describe("Meta call budget per surface", () => {
  it("dashboard pause action costs exactly 1 Meta call", async () => {
    const { action } = await import("../dashboard.api.campaigns.$id.action");
    const res = toResponse(await action({
      request: dashboardPost({ type: "pause_campaign", idempotency_key: "k1" }),
      params: { id: CAMP },
      context: {},
    } as never));
    expect(res.status).toBe(200);
    expect(counts).toEqual({ get: 0, post: 1 });
  });

  it("dashboard budget action costs exactly 1 Meta call", async () => {
    const { action } = await import("../dashboard.api.campaigns.$id.action");
    const res = await action({
      request: dashboardPost({ type: "reduce_campaign_budget", idempotency_key: "k2", daily_budget_cents: 700 }),
      params: { id: CAMP },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(counts).toEqual({ get: 0, post: 1 });
  });

  it("extension pause intent (ingested → orchestrated) costs exactly 1 Meta call", async () => {
    const { action } = await import("../app.campaigns._index");
    const res = toResponse(await action({
      request: extensionPost({ intent: "pause", campaignId: EXT, campaignName: "Ext One", platform: "Meta" }),
      params: {},
      context: {},
    } as never));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(counts).toEqual({ get: 0, post: 1 });
  });

  it("extension pause intent (NOT ingested → legacy direct-Meta) costs 3 Meta calls", async () => {
    resolveDimSpy.mockResolvedValue(null); // not in ad_campaign_dim yet
    const { action } = await import("../app.campaigns._index");
    const res = toResponse(await action({
      request: extensionPost({ intent: "pause", campaignId: EXT, campaignName: "Ext One", platform: "Meta" }),
      params: {},
      context: {},
    } as never));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // ownership list + true-prior-status read + status write
    expect(counts).toEqual({ get: 2, post: 1 });
  });

  it("extension campaigns loader costs 0 Meta calls per load (sources ingested data, not the live list)", async () => {
    const { loader } = await import("../app.campaigns._index");
    const res = toResponse(await loader({
      request: new Request("https://app.call-budget.invalid/app/campaigns"),
      params: {},
      context: {},
    } as never));
    expect(res.status).toBe(200);
    // Campaigns now come from the ingested view for EVERY platform (Meta included),
    // so the loader no longer hits the live Meta API — Campaigns matches Analytics
    // and Meta scale suggestions surface like Google/TikTok.
    expect(counts).toEqual({ get: 0, post: 0 });
  });
});
