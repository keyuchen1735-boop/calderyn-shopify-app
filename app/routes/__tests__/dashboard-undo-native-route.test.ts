import { describe, it, expect, vi, beforeEach } from "vitest";
import { action as undoRoute } from "../dashboard.api.audit.$id.undo";
import type * as DashboardHttp from "~/lib/dashboard/http.server";

const requireDashboardSession = vi.fn();
const undoAction = vi.fn();
const unauthenticatedAdmin = vi.fn();
const auditRow = vi.fn();

vi.mock("~/lib/dashboard/session.server", () => ({
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof DashboardHttp>()),
  requireSameOrigin: vi.fn(),
}));
vi.mock("~/lib/actions/undo.server", () => ({
  undoAction: (...a: unknown[]) => undoAction(...a),
}));
vi.mock("~/shopify.server", () => ({
  unauthenticated: { admin: (...a: unknown[]) => unauthenticatedAdmin(...a) },
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => auditRow() }),
        }),
      }),
    }),
  }),
}));

function post(): Request {
  return new Request("https://calderyncompany.com/dashboard/api/audit/a1/undo", {
    method: "POST",
    headers: { Origin: "https://calderyncompany.com" },
  });
}

const call = () => undoRoute({ request: post(), params: { id: "a1" }, context: {} } as never) as Promise<Response>;

describe("POST /dashboard/api/audit/:id/undo — native store actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireDashboardSession.mockResolvedValue({ shopId: "shop-1", shopDomain: "native.calderyn" });
    undoAction.mockResolvedValue({ id: "undo-1" });
    unauthenticatedAdmin.mockResolvedValue({ admin: { graphql: vi.fn() } });
  });

  it("undoes an owned discontinue without initializing Shopify", async () => {
    auditRow.mockResolvedValue({
      data: { action_kind: "discontinue_sku", params: { owned: true } },
      error: null,
    });

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "undo-1" });
    expect(unauthenticatedAdmin).not.toHaveBeenCalled();
    expect(undoAction).toHaveBeenCalledWith("shop-1", "a1", expect.anything(), { admin: undefined });
  });

  it("still resolves Shopify for a legacy store action", async () => {
    auditRow.mockResolvedValue({
      data: { action_kind: "discontinue_sku", params: {} },
      error: null,
    });

    await call();

    expect(unauthenticatedAdmin).toHaveBeenCalledWith("native.calderyn");
    expect(undoAction).toHaveBeenCalledWith(
      "shop-1",
      "a1",
      expect.anything(),
      expect.objectContaining({ admin: expect.anything() }),
    );
  });
});
