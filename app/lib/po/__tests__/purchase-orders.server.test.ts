// Unit tests for the purchase-order server lib: boundary validation, DTO/total
// math, RPC error mapping + re-projection, and the Autopilot-draft promotion
// mapping. Supabase is a queued in-memory mock (same style as the
// inventory-relocate tests); the SQL functions themselves are exercised live
// during browser verification, not here.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CalderynError } from "~/lib/calderyn.server";
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  defaultEta,
  generatePoNumber,
  markOrdered,
  promoteAuditDraft,
  receiveLines,
  sumTotalCents,
  updateDraftPurchaseOrder,
  validatePoBody,
  validateReceiveBody,
} from "../purchase-orders.server";

const projectLevelFact = vi.hoisted(() => vi.fn());
vi.mock("~/lib/inventory/project-level-fact.server", () => ({
  projectLevelFact: (...a: unknown[]) => projectLevelFact(...a),
}));

const ensurePrimaryLocation = vi.hoisted(() => vi.fn());
vi.mock("~/lib/inventory/engine.server", () => ({
  ensurePrimaryLocation: (...a: unknown[]) => ensurePrimaryLocation(...a),
}));

// ---- queued supabase mock ----------------------------------------------------

interface Res {
  data: unknown;
  error: unknown;
  count?: number;
}
interface RecordedQuery {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  filters: Array<[string, unknown]>;
  payload?: unknown;
}

const state = vi.hoisted(() => ({
  queues: new Map<string, Res[]>(),
  queries: [] as RecordedQuery[],
  rpc: vi.fn(),
}));

function enqueue(table: string, op: RecordedQuery["op"], res: Res): void {
  const key = `${table}:${op}`;
  const q = state.queues.get(key) ?? [];
  q.push(res);
  state.queues.set(key, q);
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => {
    const from = (table: string) => {
      const query: RecordedQuery = { table, op: "select", filters: [] };
      const resolve = (): Res => {
        state.queries.push(query);
        const q = state.queues.get(`${table}:${query.op}`);
        return q?.shift() ?? { data: query.op === "select" ? [] : null, error: null };
      };
      const b: Record<string, unknown> = {};
      const chain = (name: string, record?: (...a: unknown[]) => void) => {
        b[name] = (...a: unknown[]) => {
          record?.(...a);
          return b;
        };
      };
      chain("select");
      chain("order");
      chain("range");
      chain("limit");
      chain("not");
      chain("is");
      chain("eq", (col, val) => query.filters.push([String(col), val]));
      chain("in", (col, vals) => query.filters.push([String(col), vals]));
      b.insert = (payload: unknown) => {
        query.op = "insert";
        query.payload = payload;
        return b;
      };
      b.update = (payload: unknown) => {
        query.op = "update";
        query.payload = payload;
        return b;
      };
      b.delete = () => {
        query.op = "delete";
        return b;
      };
      b.single = () => Promise.resolve(resolve());
      b.maybeSingle = () => Promise.resolve(resolve());
      b.then = (onOk: (v: Res) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onOk, onErr);
      return b;
    };
    return { from, rpc: state.rpc } as never;
  },
}));

/** Run a synchronous thrower and hand back what it threw (fails if it didn't). */
function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

const SHOP = "shop-1";
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const SUP = "44444444-4444-4444-8444-444444444444";
const PO_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT = "66666666-6666-4666-8666-666666666666";
const LINE1 = "77777777-7777-4777-8777-777777777777";

function poRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PO_ID,
    po_number: "PO-20260710-ABCDEF12",
    supplier_id: null,
    vendor_name: null,
    destination_location_id: LOC,
    status: "draft",
    expected_at: null,
    notes: null,
    source: "manual",
    audit_id: null,
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
    ordered_at: null,
    received_at: null,
    cancelled_at: null,
    ...overrides,
  };
}

/** Queue everything getPurchaseOrder(shopId, PO_ID) reads. */
function enqueueDetail(overrides: Record<string, unknown> = {}): void {
  enqueue("purchase_order", "select", { data: poRow(overrides), error: null });
  enqueue("purchase_order_line", "select", {
    data: [
      { id: LINE1, variant_id: V1, qty_ordered: 10, qty_received: 0, unit_cost_cents: 250 },
    ],
    error: null,
  });
  enqueue("variant_dim", "select", {
    data: [{ id: V1, sku: "SKU-1", title: "Widget" }],
    error: null,
  });
  enqueue("location_dim", "select", { data: [{ id: LOC, name: "Main" }], error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.queues.clear();
  state.queries.length = 0;
  state.rpc.mockResolvedValue({ data: null, error: null });
  ensurePrimaryLocation.mockResolvedValue(LOC);
  projectLevelFact.mockResolvedValue(undefined);
});

// ---- pure helpers -------------------------------------------------------------

describe("generatePoNumber", () => {
  it("matches PO-YYYYMMDD-XXXXXXXX", () => {
    expect(generatePoNumber(new Date("2026-07-10T12:00:00Z"))).toMatch(
      /^PO-20260710-[0-9A-F]{8}$/,
    );
  });
});

describe("defaultEta", () => {
  it("adds the lead time in whole days (date-only)", () => {
    expect(defaultEta(7, new Date("2026-07-10T12:00:00Z"))).toBe("2026-07-17");
    expect(defaultEta(0, new Date("2026-07-10T12:00:00Z"))).toBe("2026-07-10");
  });
});

describe("sumTotalCents", () => {
  it("is null when no line has a known cost (TBD, never $0)", () => {
    expect(sumTotalCents([{ qty: 5, unitCostCents: null }])).toBeNull();
  });
  it("sums only the known costs", () => {
    expect(
      sumTotalCents([
        { qty: 5, unitCostCents: 100 },
        { qty: 3, unitCostCents: null },
        { qty: 2, unitCostCents: 250 },
      ]),
    ).toBe(1000);
  });
});

// ---- boundary validation --------------------------------------------------------

describe("validatePoBody", () => {
  const good = {
    supplierId: SUP,
    destinationLocationId: LOC,
    expectedAt: "2026-08-01",
    notes: "  rush order  ",
    lines: [{ variantId: V1, qty: 10, unitCostCents: 250 }],
  };

  it("normalizes a valid body", () => {
    const input = validatePoBody(good);
    expect(input).toEqual({
      supplierId: SUP,
      destinationLocationId: LOC,
      expectedAt: "2026-08-01",
      notes: "rush order",
      lines: [{ variantId: V1, qty: 10, unitCostCents: 250 }],
    });
  });

  it("treats empty supplier / ETA / notes / cost as null", () => {
    const input = validatePoBody({
      ...good,
      supplierId: "",
      expectedAt: "",
      notes: "",
      lines: [{ variantId: V1, qty: 1, unitCostCents: "" }],
    });
    expect(input.supplierId).toBeNull();
    expect(input.expectedAt).toBeNull();
    expect(input.notes).toBeNull();
    expect(input.lines[0].unitCostCents).toBeNull();
  });

  it.each([
    ["missing destination", { ...good, destinationLocationId: "" }],
    ["non-uuid destination", { ...good, destinationLocationId: "main" }],
    ["no lines", { ...good, lines: [] }],
    ["zero qty", { ...good, lines: [{ variantId: V1, qty: 0, unitCostCents: null }] }],
    ["fractional qty", { ...good, lines: [{ variantId: V1, qty: 1.5, unitCostCents: null }] }],
    ["qty over cap", { ...good, lines: [{ variantId: V1, qty: 1_000_001, unitCostCents: null }] }],
    ["negative cost", { ...good, lines: [{ variantId: V1, qty: 1, unitCostCents: -5 }] }],
    ["bad date", { ...good, expectedAt: "soon" }],
    [
      "duplicate variant",
      {
        ...good,
        lines: [
          { variantId: V1, qty: 1, unitCostCents: null },
          { variantId: V1, qty: 2, unitCostCents: null },
        ],
      },
    ],
  ])("rejects %s as invalid_po", (_name, body) => {
    expect(capture(() => validatePoBody(body as Record<string, unknown>))).toMatchObject({
      code: "invalid_po",
      status: 422,
    });
  });
});

describe("validateReceiveBody", () => {
  it("normalizes entries", () => {
    expect(validateReceiveBody({ lines: [{ lineId: LINE1, qty: 4 }] })).toEqual([
      { lineId: LINE1, qty: 4 },
    ]);
  });
  it.each([
    ["empty", { lines: [] }],
    ["missing", {}],
    ["bad line id", { lines: [{ lineId: "nope", qty: 1 }] }],
    ["zero qty", { lines: [{ lineId: LINE1, qty: 0 }] }],
    ["fractional qty", { lines: [{ lineId: LINE1, qty: 1.5 }] }],
  ])("rejects %s as invalid_receive", (_name, body) => {
    expect(capture(() => validateReceiveBody(body as Record<string, unknown>))).toMatchObject({
      code: "invalid_receive",
      status: 422,
    });
  });
});

// ---- createPurchaseOrder ---------------------------------------------------------

describe("createPurchaseOrder", () => {
  const input = {
    supplierId: SUP,
    destinationLocationId: LOC,
    expectedAt: null,
    notes: null,
    lines: [{ variantId: V1, qty: 10, unitCostCents: 250 }],
  };

  it("snapshots the vendor name and defaults the ETA from the lead time", async () => {
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("supplier_dim", "select", {
      data: { id: SUP, name: "Acme Textiles", lead_time_days: 7 },
      error: null,
    });
    enqueue("purchase_order", "insert", { data: { id: PO_ID }, error: null });
    enqueue("purchase_order_line", "insert", { data: null, error: null });
    enqueueDetail({ supplier_id: SUP, vendor_name: "Acme Textiles" });

    const detail = await createPurchaseOrder(SHOP, input);
    expect(detail.id).toBe(PO_ID);

    const headerInsert = state.queries.find(
      (q) => q.table === "purchase_order" && q.op === "insert",
    );
    const payload = headerInsert?.payload as Record<string, unknown>;
    expect(payload.vendor_name).toBe("Acme Textiles");
    expect(payload.supplier_id).toBe(SUP);
    expect(payload.source).toBe("manual");
    expect(String(payload.po_number)).toMatch(/^PO-\d{8}-[0-9A-F]{8}$/);
    expect(payload.expected_at).toBe(defaultEta(7));
  });

  it("keeps an explicit ETA over the lead-time default", async () => {
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("supplier_dim", "select", {
      data: { id: SUP, name: "Acme", lead_time_days: 7 },
      error: null,
    });
    enqueue("purchase_order", "insert", { data: { id: PO_ID }, error: null });
    enqueue("purchase_order_line", "insert", { data: null, error: null });
    enqueueDetail();

    await createPurchaseOrder(SHOP, { ...input, expectedAt: "2026-09-01" });
    const headerInsert = state.queries.find(
      (q) => q.table === "purchase_order" && q.op === "insert",
    );
    expect((headerInsert?.payload as Record<string, unknown>).expected_at).toBe("2026-09-01");
  });

  it("422s location_inactive on a deactivated destination", async () => {
    enqueue("location_dim", "select", { data: { id: LOC, active: false }, error: null });
    await expect(createPurchaseOrder(SHOP, input)).rejects.toMatchObject({
      code: "location_inactive",
      status: 422,
    });
  });

  it("422s variant_not_found for a foreign or missing variant", async () => {
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [], error: null });
    await expect(createPurchaseOrder(SHOP, input)).rejects.toMatchObject({
      code: "variant_not_found",
      status: 422,
    });
  });

  it("cleans up the orphaned header when the line insert fails", async () => {
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("supplier_dim", "select", { data: { id: SUP, name: "Acme", lead_time_days: null }, error: null });
    enqueue("purchase_order", "insert", { data: { id: PO_ID }, error: null });
    enqueue("purchase_order_line", "insert", { data: null, error: { message: "boom" } });
    enqueue("purchase_order", "delete", { data: null, error: null });

    await expect(createPurchaseOrder(SHOP, input)).rejects.toMatchObject({ message: "boom" });
    expect(
      state.queries.some((q) => q.table === "purchase_order" && q.op === "delete"),
    ).toBe(true);
  });
});

describe("updateDraftPurchaseOrder", () => {
  it("422s po_not_draft when the PO left draft", async () => {
    enqueueDetail({ status: "ordered" });
    await expect(
      updateDraftPurchaseOrder(SHOP, PO_ID, {
        supplierId: null,
        destinationLocationId: LOC,
        expectedAt: null,
        notes: null,
        lines: [{ variantId: V1, qty: 1, unitCostCents: null }],
      }),
    ).rejects.toMatchObject({ code: "po_not_draft", status: 422 });
  });
});

// ---- lifecycle wrappers -----------------------------------------------------------

describe("markOrdered / receiveLines / cancelPurchaseOrder", () => {
  it("maps SQL errcodes to named CalderynErrors", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "po_not_draft" } });
    await expect(markOrdered(SHOP, PO_ID)).rejects.toMatchObject({
      code: "po_not_draft",
      status: 422,
    });

    state.rpc.mockResolvedValue({ data: null, error: { message: "receive_exceeds_ordered" } });
    await expect(receiveLines(SHOP, PO_ID, [{ lineId: LINE1, qty: 5 }])).rejects.toMatchObject({
      code: "receive_exceeds_ordered",
      status: 422,
    });

    state.rpc.mockResolvedValue({ data: null, error: { message: "po_not_cancellable" } });
    await expect(cancelPurchaseOrder(SHOP, PO_ID)).rejects.toMatchObject({
      code: "po_not_cancellable",
      status: 422,
    });

    state.rpc.mockResolvedValue({ data: null, error: { message: "po_not_found" } });
    await expect(markOrdered(SHOP, PO_ID)).rejects.toMatchObject({
      code: "po_not_found",
      status: 404,
    });
  });

  it("rethrows unrecognized RPC errors untouched (surfaced, not swallowed)", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    await expect(markOrdered(SHOP, PO_ID)).rejects.toMatchObject({
      message: "connection reset",
    });
    await expect(markOrdered(SHOP, PO_ID)).rejects.not.toBeInstanceOf(CalderynError);
  });

  it("re-projects every touched (variant, destination) after mark ordered", async () => {
    state.rpc.mockResolvedValue({
      data: { variantIds: [V1, V2, V1], locationId: LOC },
      error: null,
    });
    enqueueDetail({ status: "ordered", ordered_at: "2026-07-10T01:00:00Z" });
    const detail = await markOrdered(SHOP, PO_ID);
    expect(detail.status).toBe("ordered");
    expect(state.rpc).toHaveBeenCalledWith("po_mark_ordered", {
      p_shop_id: SHOP,
      p_po_id: PO_ID,
    });
    // De-duped: V1 appears twice in the RPC payload but projects once.
    expect(projectLevelFact).toHaveBeenCalledTimes(2);
    expect(projectLevelFact).toHaveBeenCalledWith(SHOP, V1, LOC);
    expect(projectLevelFact).toHaveBeenCalledWith(SHOP, V2, LOC);
  });

  it("passes receive entries through as {line_id, qty}", async () => {
    state.rpc.mockResolvedValue({ data: { variantIds: [V1], locationId: LOC }, error: null });
    enqueueDetail({ status: "partial" });
    await receiveLines(SHOP, PO_ID, [{ lineId: LINE1, qty: 4 }]);
    expect(state.rpc).toHaveBeenCalledWith("po_receive", {
      p_shop_id: SHOP,
      p_po_id: PO_ID,
      p_lines: [{ line_id: LINE1, qty: 4 }],
    });
    expect(projectLevelFact).toHaveBeenCalledWith(SHOP, V1, LOC);
  });
});

// ---- promoteAuditDraft --------------------------------------------------------------

describe("promoteAuditDraft", () => {
  const snapshot = {
    po: {
      po_number: "PO-20260708-ALERT001",
      lines: [
        { sku: "SKU-1", title: "Widget", quantity: 40, unit_cost_cents: 250 },
      ],
    },
  };

  function enqueueHappyCreate(): void {
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("purchase_order", "insert", { data: { id: PO_ID }, error: null });
    enqueue("purchase_order_line", "insert", { data: null, error: null });
    enqueueDetail({ source: "autopilot", audit_id: AUDIT });
  }

  it("404s draft_not_found when the audit row is missing or not a PO draft", async () => {
    enqueue("action_audit", "select", { data: null, error: null });
    await expect(promoteAuditDraft(SHOP, AUDIT)).rejects.toMatchObject({
      code: "draft_not_found",
      status: 404,
    });

    enqueue("action_audit", "select", {
      data: { id: AUDIT, action_kind: "pause_campaign", params: {} },
      error: null,
    });
    await expect(promoteAuditDraft(SHOP, AUDIT)).rejects.toMatchObject({
      code: "draft_not_found",
    });
  });

  it("422s sku_not_found when a draft SKU has no variant", async () => {
    enqueue("action_audit", "select", {
      data: { id: AUDIT, action_kind: "create_po_draft", params: snapshot },
      error: null,
    });
    enqueue("variant_dim", "select", { data: [], error: null });
    await expect(promoteAuditDraft(SHOP, AUDIT)).rejects.toMatchObject({
      code: "sku_not_found",
      status: 422,
    });
  });

  it("maps skus to variants and creates an autopilot-sourced draft PO", async () => {
    enqueue("action_audit", "select", {
      data: { id: AUDIT, action_kind: "create_po_draft", params: snapshot },
      error: null,
    });
    enqueue("variant_dim", "select", { data: [{ id: V1, sku: "SKU-1" }], error: null });
    enqueueHappyCreate();

    const detail = await promoteAuditDraft(SHOP, AUDIT);
    expect(detail.id).toBe(PO_ID);
    expect(ensurePrimaryLocation).toHaveBeenCalledWith(SHOP);

    const headerInsert = state.queries.find(
      (q) => q.table === "purchase_order" && q.op === "insert",
    );
    const payload = headerInsert?.payload as Record<string, unknown>;
    expect(payload.source).toBe("autopilot");
    expect(payload.audit_id).toBe(AUDIT);
    expect(payload.po_number).toBe("PO-20260708-ALERT001");
    expect(payload.destination_location_id).toBe(LOC);

    const lineInsert = state.queries.find(
      (q) => q.table === "purchase_order_line" && q.op === "insert",
    );
    expect(lineInsert?.payload).toEqual([
      { shop_id: SHOP, po_id: PO_ID, variant_id: V1, qty_ordered: 40, unit_cost_cents: 250 },
    ]);
  });

  it("422s already_promoted on the audit_id unique index", async () => {
    enqueue("action_audit", "select", {
      data: { id: AUDIT, action_kind: "create_po_draft", params: snapshot },
      error: null,
    });
    enqueue("variant_dim", "select", { data: [{ id: V1, sku: "SKU-1" }], error: null });
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("purchase_order", "insert", {
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "purchase_order_audit_id_key"' },
    });
    await expect(promoteAuditDraft(SHOP, AUDIT)).rejects.toMatchObject({
      code: "already_promoted",
      status: 422,
    });
  });

  it("retries with a fresh number when the draft po_number is already taken", async () => {
    enqueue("action_audit", "select", {
      data: { id: AUDIT, action_kind: "create_po_draft", params: snapshot },
      error: null,
    });
    enqueue("variant_dim", "select", { data: [{ id: V1, sku: "SKU-1" }], error: null });
    enqueue("location_dim", "select", { data: { id: LOC, active: true }, error: null });
    enqueue("variant_dim", "select", { data: [{ id: V1 }], error: null });
    enqueue("purchase_order", "insert", {
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "purchase_order_shop_id_po_number_key"' },
    });
    enqueue("purchase_order", "insert", { data: { id: PO_ID }, error: null });
    enqueue("purchase_order_line", "insert", { data: null, error: null });
    enqueueDetail({ source: "autopilot", audit_id: AUDIT });

    const detail = await promoteAuditDraft(SHOP, AUDIT);
    expect(detail.id).toBe(PO_ID);
    const inserts = state.queries.filter(
      (q) => q.table === "purchase_order" && q.op === "insert",
    );
    expect(inserts).toHaveLength(2);
    const retried = inserts[1].payload as Record<string, unknown>;
    expect(retried.po_number).not.toBe("PO-20260708-ALERT001");
    expect(String(retried.po_number)).toMatch(/^PO-\d{8}-[0-9A-F]{8}$/);
  });
});
