// Route tests for the filtered CSV export (Phase 2 Task 4): header row, RFC-4180 escaping, filter
// passthrough via the shared parseOrdersListParams helper, the 1000-row pagination loop, and the
// 10,000-row cap marker. Convention mirrors dashboard.api.orders.list.test.ts: listOrdersUnified
// mocked, session.server mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const listOrdersUnified = vi.fn();
vi.mock("~/lib/order/unified-list.server", () => ({
  listOrdersUnified: (...a: unknown[]) => listOrdersUnified(...a),
}));

const ORIGIN = "https://calderyncompany.com";
const URL_BASE = `${ORIGIN}/dashboard/api/orders/export`;

type Row = {
  source: "calderyn" | "shopify";
  id: string;
  ref: string;
  buyerEmail: string | null;
  totalCents: number;
  currency: string;
  paymentStatus: string;
  state: string;
  cancelledAt: string | null;
  archivedAt: string | null;
  occurredAt: string;
  itemCount: number;
  tags: string[];
  remainingRefundableCents: number;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    source: "calderyn",
    id: "order-1",
    ref: "#ABC1234",
    buyerEmail: "alice@example.com",
    totalCents: 9999,
    currency: "USD",
    paymentStatus: "paid",
    state: "fulfilled",
    cancelledAt: null,
    archivedAt: null,
    occurredAt: "2026-01-15T10:00:00Z",
    itemCount: 2,
    tags: ["vip"],
    remainingRefundableCents: 9999,
    ...overrides,
  };
}

function get(query: string): Request {
  return new Request(`${URL_BASE}${query}`);
}

async function readCsv(res: Response): Promise<string> {
  return res.text();
}

beforeEach(() => {
  listOrdersUnified.mockReset();
});

describe("GET /dashboard/api/orders/export", () => {
  it("emits the exact header row plus one data row and the right response headers", async () => {
    listOrdersUnified.mockResolvedValue({ rows: [makeRow()], totalCount: 1, offset: 0, limit: 1000 });
    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;

    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="orders-export-\d{4}-\d{2}-\d{2}\.csv"$/);

    const csv = await readCsv(res);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "ref,date,source,customer,total,currency,payment_status,fulfillment_status,items,tags,cancelled,archived",
    );
    expect(lines[1]).toBe(
      "#ABC1234,2026-01-15T10:00:00Z,calderyn,alice@example.com,99.99,USD,paid,fulfilled,2,vip,,",
    );
  });

  it("leaves fulfillment_status empty for an imported (shopify) row", async () => {
    listOrdersUnified.mockResolvedValue({
      rows: [makeRow({ source: "shopify", state: "partially_refunded" })],
      totalCount: 1,
      offset: 0,
      limit: 1000,
    });
    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;
    const lines = (await readCsv(res)).split("\r\n");
    expect(lines[1]).toBe(
      "#ABC1234,2026-01-15T10:00:00Z,shopify,alice@example.com,99.99,USD,paid,,2,vip,,",
    );
  });

  it("marks cancelled/archived rows as yes", async () => {
    listOrdersUnified.mockResolvedValue({
      rows: [makeRow({ cancelledAt: "2026-01-16T00:00:00Z", archivedAt: "2026-01-17T00:00:00Z" })],
      totalCount: 1,
      offset: 0,
      limit: 1000,
    });
    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;
    const lines = (await readCsv(res)).split("\r\n");
    expect(lines[1]).toBe(
      "#ABC1234,2026-01-15T10:00:00Z,calderyn,alice@example.com,99.99,USD,paid,fulfilled,2,vip,yes,yes",
    );
  });

  it("RFC-4180 escapes a comma+quote buyer email and a newline in a tag", async () => {
    listOrdersUnified.mockResolvedValue({
      rows: [
        makeRow({
          buyerEmail: 'comma, "quote"@example.com',
          tags: ["line1\nline2", "vip"],
        }),
      ],
      totalCount: 1,
      offset: 0,
      limit: 1000,
    });
    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;
    const csv = await readCsv(res);
    // Escaped email field: wrapped in quotes, inner quotes doubled.
    expect(csv).toContain('"comma, ""quote""@example.com"');
    // Escaped tags field: the whole semicolon-joined string is quoted because it contains a newline.
    expect(csv).toContain('"line1\nline2;vip"');
  });

  it("passes through filter params to the wrapper, same contract as the list route", async () => {
    listOrdersUnified.mockResolvedValue({ rows: [], totalCount: 0, offset: 0, limit: 1000 });
    const { loader } = await import("../dashboard.api.orders.export");
    await loader({
      request: get(
        "?search=vip&payment_status=paid,partially_refunded&fulfillment_status=unfulfilled&source=calderyn" +
          "&date_from=2026-01-01T00:00:00Z&date_to=2026-01-31T23:59:59Z&tag=rush&archived=true&sort=total&dir=asc",
      ),
    } as never);
    expect(listOrdersUnified).toHaveBeenCalledWith("shop-1", {
      search: "vip",
      paymentStatus: ["paid", "partially_refunded"],
      fulfillmentStatus: "unfulfilled",
      source: "calderyn",
      dateFrom: "2026-01-01T00:00:00Z",
      dateTo: "2026-01-31T23:59:59Z",
      tag: "rush",
      archived: true,
      sort: "total",
      dir: "asc",
      offset: 0,
      limit: 1000,
    });
  });

  it("422s an invalid filter param (same as the list route) without calling the wrapper", async () => {
    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("?source=bogus") } as never)) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_source");
    expect(listOrdersUnified).not.toHaveBeenCalled();
  });

  it("loops pages of 1000 until a short page: 1000 rows then 400 rows -> 1400 data rows, offsets 0 then 1000", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => makeRow({ id: `o1-${i}`, ref: `#R1-${i}` }));
    const page2 = Array.from({ length: 400 }, (_, i) => makeRow({ id: `o2-${i}`, ref: `#R2-${i}` }));
    listOrdersUnified
      .mockResolvedValueOnce({ rows: page1, totalCount: 1400, offset: 0, limit: 1000 })
      .mockResolvedValueOnce({ rows: page2, totalCount: 1400, offset: 1000, limit: 1000 });

    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;
    const csv = await readCsv(res);
    const dataLines = csv.trimEnd().split("\r\n").slice(1);

    expect(dataLines).toHaveLength(1400);
    expect(listOrdersUnified).toHaveBeenCalledTimes(2);
    expect(listOrdersUnified).toHaveBeenNthCalledWith(1, "shop-1", expect.objectContaining({ offset: 0, limit: 1000 }));
    expect(listOrdersUnified).toHaveBeenNthCalledWith(2, "shop-1", expect.objectContaining({ offset: 1000, limit: 1000 }));
  });

  it("caps at 10,000 rows and appends the truncation marker without a further call", async () => {
    const fullPage = () => Array.from({ length: 1000 }, (_, i) => makeRow({ id: `o-${i}`, ref: `#R-${i}` }));
    for (let i = 0; i < 10; i++) {
      listOrdersUnified.mockResolvedValueOnce({ rows: fullPage(), totalCount: 20000, offset: i * 1000, limit: 1000 });
    }

    const { loader } = await import("../dashboard.api.orders.export");
    const res = (await loader({ request: get("") } as never)) as Response;
    const csv = await readCsv(res);
    const dataLines = csv.trimEnd().split("\r\n").slice(1);

    expect(dataLines).toHaveLength(10_001);
    expect(dataLines[10_000]).toBe("export truncated at 10000 rows,,,,,,,,,,,");
    expect(listOrdersUnified).toHaveBeenCalledTimes(10);
  });
});
