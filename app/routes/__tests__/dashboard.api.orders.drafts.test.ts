// Route tests for the merchant-drafts CRUD API (orders phase 3, Task 2): GET list / POST
// create-or-replace / DELETE ?id=. Convention mirrors dashboard.api.orders.views.test.ts
// (session.server mocked, http.server kept REAL via importOriginal so requireSameOrigin is a
// genuine CSRF guard) but mocks merchant-drafts.server directly — its own CRUD/validation
// behavior is unit-tested in merchant-drafts.server.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { CalderynError } from "~/lib/calderyn.server";
import { VariantUnavailableError } from "~/lib/order/cart.server";

const ORIGIN = "https://calderyncompany.com";

const SESSION = {
  shopId: "shop-1",
  shopDomain: null,
  userId: "u1",
  sessionId: "s1",
  emailVerified: true,
  onboardedAt: null,
  accountCreatedAt: null,
};

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: vi.fn().mockResolvedValue(SESSION),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpServer>()),
}));

const drafts = vi.hoisted(() => ({
  listMerchantDrafts: vi.fn(),
  createMerchantDraft: vi.fn(),
  replaceMerchantDraftLines: vi.fn(),
  deleteMerchantDraft: vi.fn(),
}));
vi.mock("~/lib/order/merchant-drafts.server", () => drafts);

const SAMPLE_DRAFT = {
  id: "cart-1",
  lines: [{ id: "line-1", variantId: "v-tee-s", title: "Cotton Tee - Small", quantity: 2, unitPriceCents: 1999, currency: "usd" }],
  subtotalCents: 3998,
  currency: "usd",
  createdAt: "2026-07-01T00:00:00.000Z",
};

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const LIST_URL = `${ORIGIN}/dashboard/api/orders/drafts`;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
});

describe("GET /dashboard/api/orders/drafts", () => {
  it("lists the shop's drafts", async () => {
    drafts.listMerchantDrafts.mockResolvedValue([SAMPLE_DRAFT]);
    const { loader } = await import("../dashboard.api.orders.drafts");
    const res = (await loader({ request: new Request(LIST_URL) } as never)) as Response;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.drafts).toEqual([
      {
        id: "cart-1",
        lines: [{ id: "line-1", variant_id: "v-tee-s", title: "Cotton Tee - Small", quantity: 2, unit_price_cents: 1999, currency: "usd" }],
        subtotal_cents: 3998,
        currency: "usd",
        created_at: "2026-07-01T00:00:00.000Z",
      },
    ]);
    expect(drafts.listMerchantDrafts).toHaveBeenCalledWith("shop-1");
  });
});

describe("POST /dashboard/api/orders/drafts (create)", () => {
  it("creates a draft from valid lines", async () => {
    drafts.createMerchantDraft.mockResolvedValue(SAMPLE_DRAFT);
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(LIST_URL, "POST", { lines: [{ variant_id: "v-tee-s", quantity: 2 }] }),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(drafts.createMerchantDraft).toHaveBeenCalledWith("shop-1", [{ variantId: "v-tee-s", quantity: 2 }]);
    const json = await res.json();
    expect(json.draft.id).toBe("cart-1");
  });

  it("422s an empty lines array", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({ request: req(LIST_URL, "POST", { lines: [] }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
    expect(drafts.createMerchantDraft).not.toHaveBeenCalled();
  });

  it("422s more than 50 lines", async () => {
    const lines = Array.from({ length: 51 }, (_, i) => ({ variant_id: `v-${i}`, quantity: 1 }));
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({ request: req(LIST_URL, "POST", { lines }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a quantity outside 1-999", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(LIST_URL, "POST", { lines: [{ variant_id: "v-tee-s", quantity: 1000 }] }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s a non-integer quantity", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(LIST_URL, "POST", { lines: [{ variant_id: "v-tee-s", quantity: 1.5 }] }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_lines");
  });

  it("422s (variant_unavailable) when createMerchantDraft throws VariantUnavailableError", async () => {
    drafts.createMerchantDraft.mockRejectedValue(new VariantUnavailableError("v-missing", "not_found"));
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = await action({
      request: req(LIST_URL, "POST", { lines: [{ variant_id: "v-missing", quantity: 1 }] }),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("variant_unavailable");
  });

  it("rejects a cross-origin request without creating a draft", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = await action({
      request: req(LIST_URL, "POST", { lines: [{ variant_id: "v-tee-s", quantity: 1 }] }, "https://evil.example"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(drafts.createMerchantDraft).not.toHaveBeenCalled();
  });
});

describe("POST /dashboard/api/orders/drafts (replace)", () => {
  it("replaces an existing draft's lines when cart_id is given", async () => {
    drafts.replaceMerchantDraftLines.mockResolvedValue(SAMPLE_DRAFT);
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(LIST_URL, "POST", {
        cart_id: "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
        lines: [{ variant_id: "v-hoodie-l", quantity: 1 }],
      }),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(drafts.replaceMerchantDraftLines).toHaveBeenCalledWith(
      "shop-1",
      "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      [{ variantId: "v-hoodie-l", quantity: 1 }],
    );
    expect(drafts.createMerchantDraft).not.toHaveBeenCalled();
  });

  it("422s a non-uuid cart_id", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(LIST_URL, "POST", { cart_id: "not-a-uuid", lines: [{ variant_id: "v-tee-s", quantity: 1 }] }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_cart_id");
  });

  it("404s (draft_not_found) when replaceMerchantDraftLines throws", async () => {
    drafts.replaceMerchantDraftLines.mockRejectedValue(
      new CalderynError({ code: "draft_not_found", status: 404, message: "not found" }),
    );
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = await action({
      request: req(LIST_URL, "POST", {
        cart_id: "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
        lines: [{ variant_id: "v-tee-s", quantity: 1 }],
      }),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("draft_not_found");
  });
});

describe("DELETE /dashboard/api/orders/drafts", () => {
  it("deletes a draft by id", async () => {
    drafts.deleteMerchantDraft.mockResolvedValue(undefined);
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({
      request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE"),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(drafts.deleteMerchantDraft).toHaveBeenCalledWith("shop-1", "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  });

  it("422s a non-uuid id", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = (await action({ request: req(`${LIST_URL}?id=not-a-uuid`, "DELETE") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_id");
  });

  it("404s an unknown id", async () => {
    drafts.deleteMerchantDraft.mockRejectedValue(
      new CalderynError({ code: "draft_not_found", status: 404, message: "not found" }),
    );
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = await action({
      request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(404);
  });

  it("rejects a cross-origin request without deleting", async () => {
    const { action } = await import("../dashboard.api.orders.drafts");
    const res = await action({
      request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE", undefined, "https://evil.example"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(drafts.deleteMerchantDraft).not.toHaveBeenCalled();
  });
});
