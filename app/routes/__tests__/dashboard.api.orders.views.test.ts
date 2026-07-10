// Route tests for the saved order-views API (Phase 2 Task 2): GET list / POST create / DELETE
// ?id=. Convention mirrors dashboard.api.orders.detail.test.ts's notes/tags describe blocks:
// session.server + http.server (importOriginal, so requireSameOrigin is REAL) mocked, and
// ~/lib/supabase.server backed by a small in-memory Builder so views.server.ts's create-limit +
// unique-violation-mapping logic is exercised for real, not stubbed away.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpServer from "~/lib/dashboard/http.server";
import { MAX_ORDER_VIEWS } from "~/lib/order/views.server";

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

type Row = Record<string, any>;

const store = vi.hoisted(() => {
  const rows: Row[] = [];
  let seq = 0;

  class Builder {
    private op: "select" | "insert" | "delete" = "select";
    private payload: Row = {};
    private filters: Array<[string, unknown]> = [];
    private sorts: Array<[string, boolean]> = [];
    private wantSingle = false;

    select(_cols?: string) {
      return this;
    }
    eq(col: string, val: unknown) {
      this.filters.push([col, val]);
      return this;
    }
    order(col: string, opts: { ascending: boolean }) {
      this.sorts.push([col, opts.ascending]);
      return this;
    }
    insert(payload: Row) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    single() {
      this.wantSingle = true;
      return this;
    }
    then(resolve: (v: { data: unknown; error: unknown }) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
    private matches(r: Row): boolean {
      return this.filters.every(([c, v]) => r[c] === v);
    }
    private run(): { data: unknown; error: unknown } {
      if (this.op === "insert") {
        const dup = rows.some((r) => r.shop_id === this.payload.shop_id && r.name === this.payload.name);
        if (dup) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        seq += 1;
        const row: Row = { id: `view-${seq}`, position: 0, created_at: new Date(2026, 0, seq).toISOString(), ...this.payload };
        rows.push(row);
        return { data: row, error: null };
      }
      if (this.op === "delete") {
        const matched = rows.filter((r) => this.matches(r));
        for (const r of matched) rows.splice(rows.indexOf(r), 1);
        return { data: matched, error: null };
      }
      let result = rows.filter((r) => this.matches(r));
      for (const [col, asc] of [...this.sorts].reverse()) {
        result = [...result].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this.wantSingle) return { data: result[0] ?? null, error: null };
      return { data: result, error: null };
    }
  }

  const client = { from: (_table: string) => new Builder() };
  return { rows, client };
});

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => store.client }));

function req(url: string, method: string, body?: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

const LIST_URL = `${ORIGIN}/dashboard/api/orders/views`;

beforeEach(() => {
  store.rows.length = 0;
  process.env.DASHBOARD_PUBLIC_URL = ORIGIN;
});

describe("GET /dashboard/api/orders/views", () => {
  it("lists the shop's views ordered by position then created_at", async () => {
    store.rows.push(
      { id: "v1", shop_id: "shop-1", name: "B", filters: {}, position: 1, created_at: "2026-01-01T00:00:00Z" },
      { id: "v2", shop_id: "shop-1", name: "A", filters: { search: "x" }, position: 0, created_at: "2026-01-02T00:00:00Z" },
      { id: "v3", shop_id: "shop-2", name: "Other", filters: {}, position: 0, created_at: "2026-01-01T00:00:00Z" },
    );
    const { loader } = await import("../dashboard.api.orders.views");
    const res = (await loader({ request: new Request(LIST_URL) } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      views: [
        { id: "v2", name: "A", filters: { search: "x" }, position: 0 },
        { id: "v1", name: "B", filters: {}, position: 1 },
      ],
    });
  });

  it("returns an empty list when the shop has no saved views", async () => {
    const { loader } = await import("../dashboard.api.orders.views");
    const res = (await loader({ request: new Request(LIST_URL) } as never)) as Response;
    expect(await res.json()).toEqual({ views: [] });
  });
});

describe("POST /dashboard/api/orders/views", () => {
  it("creates a view and returns it", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({
      request: req(LIST_URL, "POST", { name: "VIP orders", filters: { search: "vip", archived: false } }),
    } as never)) as Response;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { view: { id: string; name: string; filters: unknown; position: number } };
    expect(json.view).toMatchObject({ name: "VIP orders", filters: { search: "vip", archived: false }, position: 0 });
    expect(typeof json.view.id).toBe("string");
    expect(store.rows).toHaveLength(1);
  });

  it("422s a name outside 1-60 chars", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({ request: req(LIST_URL, "POST", { name: "", filters: {} }) } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_name");
    expect(store.rows).toHaveLength(0);
  });

  it("422s a filters object with an unknown key", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({
      request: req(LIST_URL, "POST", { name: "Bad filters", filters: { bogus: "x" } }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_filters");
    expect(store.rows).toHaveLength(0);
  });

  it("422s a filters object with a nested object value", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({
      request: req(LIST_URL, "POST", { name: "Nested", filters: { search: { nested: true } } }),
    } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_filters");
    expect(store.rows).toHaveLength(0);
  });

  it("409s a duplicate name for the same shop", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    await action({ request: req(LIST_URL, "POST", { name: "Dup", filters: {} }) } as never);
    // dashboardJson rethrows a jsonError Response thrown inside its callback, so the action
    // promise itself rejects with it (same convention as the 404 tests in the detail suite).
    const res = await action({ request: req(LIST_URL, "POST", { name: "Dup", filters: {} }) } as never).catch(
      (e) => e as Response,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("view_name_taken");
    expect(store.rows).toHaveLength(1);
  });

  it("422s at MAX_ORDER_VIEWS, without inserting an extra row", async () => {
    for (let i = 0; i < MAX_ORDER_VIEWS; i++) {
      store.rows.push({ id: `v${i}`, shop_id: "shop-1", name: `View ${i}`, filters: {}, position: i, created_at: "2026-01-01T00:00:00Z" });
    }
    const { action } = await import("../dashboard.api.orders.views");
    const res = await action({
      request: req(LIST_URL, "POST", { name: "One too many", filters: {} }),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("too_many_views");
    expect(store.rows).toHaveLength(MAX_ORDER_VIEWS);
  });

  it("rejects a cross-origin request without creating a view", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = await action({
      request: req(LIST_URL, "POST", { name: "Evil", filters: {} }, "https://evil.example"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.rows).toHaveLength(0);
  });

  it("a literal JSON `null` body is treated as empty (422, not a crash)", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({ request: req(LIST_URL, "POST", null) } as never)) as Response;
    expect(res.status).toBe(422);
    expect(store.rows).toHaveLength(0);
  });
});

describe("DELETE /dashboard/api/orders/views", () => {
  it("deletes a matching view and returns deleted: true", async () => {
    store.rows.push({ id: "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b", shop_id: "shop-1", name: "A", filters: {}, position: 0 });
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({
      request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE"),
    } as never)) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(store.rows).toHaveLength(0);
  });

  it("404s an unknown/foreign-shop id", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    await expect(
      action({ request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE") } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("422s a non-uuid id", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({ request: req(`${LIST_URL}?id=not-a-uuid`, "DELETE") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_id");
  });

  it("422s a missing id", async () => {
    const { action } = await import("../dashboard.api.orders.views");
    const res = (await action({ request: req(LIST_URL, "DELETE") } as never)) as Response;
    expect(res.status).toBe(422);
  });

  it("rejects a cross-origin request without deleting", async () => {
    store.rows.push({ id: "3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b", shop_id: "shop-1", name: "A", filters: {}, position: 0 });
    const { action } = await import("../dashboard.api.orders.views");
    const res = await action({
      request: req(`${LIST_URL}?id=3a788ee3-1c2d-4e5f-8a9b-0c1d2e3f4a5b`, "DELETE", undefined, "https://evil.example"),
    } as never).catch((e) => e as Response);
    expect(res.status).toBe(403);
    expect(store.rows).toHaveLength(1);
  });
});
