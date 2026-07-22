import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://calderyncompany.com";
const SESSION = {
  shopId: "shop-1",
  shopDomain: null,
  userId: "user-1",
  sessionId: "session-1",
};

const state = vi.hoisted(() => ({
  updatedRow: {
    campaign_kind: "regular",
    sale_type: null as string | null,
    classification_source: "merchant",
  } as Record<string, unknown> | null,
  update: null as Record<string, unknown> | null,
  filters: [] as Array<[string, unknown]>,
}));

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue(SESSION),
}));

class CampaignUpdateBuilder {
  update(values: Record<string, unknown>) {
    state.update = values;
    return this;
  }

  eq(column: string, value: unknown) {
    state.filters.push([column, value]);
    return this;
  }

  select() {
    return this;
  }

  maybeSingle() {
    return Promise.resolve({ data: state.updatedRow, error: null });
  }
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      expect(table).toBe("ad_campaign_dim");
      return new CampaignUpdateBuilder();
    },
  }),
}));

function patch(body: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/dashboard/api/campaigns/c1`, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runAction(request: Request) {
  const { action } = await import("../dashboard.api.campaigns.$id");
  return action({ request, params: { id: "c1" }, context: {} });
}

beforeEach(() => {
  state.updatedRow = {
    campaign_kind: "regular",
    sale_type: null,
    classification_source: "merchant",
  };
  state.update = null;
  state.filters = [];
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
});

describe("PATCH /dashboard/api/campaigns/:id classification", () => {
  it("requires a same-origin request", async () => {
    const response = await runAction(
      patch({ campaignKind: "regular" }, "https://evil.example"),
    ).catch((error) => error as Response);

    expect(response.status).toBe(403);
    expect(state.update).toBeNull();
  });

  it("rejects a sales campaign without a valid sale type", async () => {
    const response = (await runAction(patch({ campaignKind: "sales" }))) as Response;

    expect(response.status).toBe(400);
    expect(state.update).toBeNull();
  });

  it("rejects fields outside the classification input", async () => {
    const response = (await runAction(
      patch({ campaignKind: "regular", shopId: "shop-2" }),
    )) as Response;

    expect(response.status).toBe(400);
    expect(state.update).toBeNull();
  });

  it("clears sale type for regular campaigns and scopes the update to the session shop", async () => {
    const response = (await runAction(
      patch({ campaignKind: "regular" }),
    )) as Response;

    expect(response.status).toBe(200);
    expect(state.update).toEqual({
      campaign_kind: "regular",
      sale_type: null,
      classification_source: "merchant",
    });
    expect(state.filters).toEqual([
      ["id", "c1"],
      ["shop_id", "shop-1"],
    ]);
  });

  it("trims a 1-80 character sale type before writing it", async () => {
    state.updatedRow = {
      campaign_kind: "sales",
      sale_type: "Black Friday",
      classification_source: "merchant",
    };
    const response = (await runAction(
      patch({ campaignKind: "sales", saleType: "  Black Friday  " }),
    )) as Response;

    expect(response.status).toBe(200);
    expect(state.update).toEqual({
      campaign_kind: "sales",
      sale_type: "Black Friday",
      classification_source: "merchant",
    });
  });

  it("returns 404 when the scoped campaign does not exist", async () => {
    state.updatedRow = null;
    const response = (await runAction(
      patch({ campaignKind: "regular" }),
    )) as Response;

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "campaign_not_found" });
  });
});
