// Real purchase orders (purchase_order / purchase_order_line): DTO shaping,
// action-boundary validation, and thin wrappers over the po_* SQL functions.
// Stock only ever moves inside those functions (FOR UPDATE lock + ledger row in
// the same transaction — see 20260710200000_purchase_orders.sql); after every
// mutating call the touched (variant, destination) pairs are re-projected into
// inventory_level_fact so the engine keeps reading the owned numbers.

import { randomUUID } from "node:crypto";
import { CalderynError } from "~/lib/calderyn.server";
import { getSupabase } from "~/lib/supabase.server";
import { ensurePrimaryLocation } from "~/lib/inventory/engine.server";
import { projectLevelFact } from "~/lib/inventory/project-level-fact.server";
import { hasPoSnapshot } from "~/lib/catalog/po-list.server";
import { isUuid } from "~/lib/ids";
import { defaultEta, formatPoNumber } from "./format";
import type {
  CreatePoInput,
  PoDetailDto,
  PoLineDto,
  PoLineInput,
  PoListItemDto,
  PoStatus,
  ReceiveLineInput,
} from "./types";
import type { PoLine } from "./draft.server";

export type {
  CreatePoInput,
  PoDetailDto,
  PoLineDto,
  PoLineInput,
  PoListItemDto,
  PoStatus,
  ReceiveLineInput,
} from "./types";
export { defaultEta };

const PO_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "ordered",
  "partial",
  "received",
  "cancelled",
]);

const MAX_LINE_QTY = 1_000_000;
const MAX_PO_LINES = 100;
// Unit cost ceiling ($500,000.00 in cents). Bounds the value BEFORE it reaches
// the `unit_cost_cents int` column: without a ceiling a large cost overflows
// Postgres int (max 2,147,483,647) and surfaces as a 500 instead of a 422.
// Chosen so MAX_PO_LINES * MAX_LINE_QTY * MAX_UNIT_COST_CENTS (5e15) stays
// under Number.MAX_SAFE_INTEGER, keeping the client-side total exact too.
const MAX_UNIT_COST_CENTS = 50_000_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(code: string, message: string, status = 422): never {
  throw new CalderynError({ code, status, message });
}

function asPoStatus(value: unknown): PoStatus {
  const s = String(value);
  return PO_STATUSES.has(s) ? (s as PoStatus) : "draft";
}

/** `PO-YYYYMMDD-XXXXXXXX` — same shape as the Autopilot draft numbers. */
export function generatePoNumber(now: Date = new Date()): string {
  const ref = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return formatPoNumber(ref, now);
}

/** Order total across lines: sum of the KNOWN unit costs; null when no line has
 *  a cost (rendered "TBD", never $0 — same rule as the draft snapshots). */
export function sumTotalCents(
  lines: Array<{ qty: number; unitCostCents: number | null }>,
): number | null {
  let total = 0;
  let known = false;
  for (const line of lines) {
    if (line.unitCostCents == null) continue;
    known = true;
    total += line.qty * line.unitCostCents;
  }
  return known ? total : null;
}

// ---- boundary validation ----------------------------------------------------

function validateLines(raw: unknown): PoLineInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid("invalid_po", "Add at least one line to the purchase order.");
  }
  if (raw.length > MAX_PO_LINES) {
    invalid("invalid_po", `A purchase order can have at most ${MAX_PO_LINES} lines.`);
  }
  const seen = new Set<string>();
  return raw.map((entry) => {
    const line = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const variantId = typeof line.variantId === "string" ? line.variantId : "";
    if (!isUuid(variantId)) invalid("invalid_po", "Each line needs a valid variant.");
    if (seen.has(variantId)) {
      invalid("invalid_po", "The same variant appears on more than one line — combine them.");
    }
    seen.add(variantId);
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      invalid("invalid_po", "Line quantities must be whole numbers between 1 and 1,000,000.");
    }
    let unitCostCents: number | null = null;
    if (line.unitCostCents != null && line.unitCostCents !== "") {
      const cost = Number(line.unitCostCents);
      if (!Number.isInteger(cost) || cost < 0 || cost > MAX_UNIT_COST_CENTS) {
        invalid("invalid_po", "Unit costs must be between 0 and 50,000,000 cents.");
      }
      unitCostCents = cost;
    }
    return { variantId, qty, unitCostCents };
  });
}

function validateExpectedAt(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !DATE_RE.test(raw) || !Number.isFinite(Date.parse(`${raw}T00:00:00Z`))) {
    invalid("invalid_po", "The expected date must be a valid date.");
  }
  return raw;
}

function validateNotes(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") invalid("invalid_po", "Notes must be text.");
  const trimmed = raw.trim();
  if (trimmed.length > 4000) invalid("invalid_po", "Notes must be 4,000 characters or fewer.");
  return trimmed || null;
}

/** Validate an inbound create/update-draft body into a typed CreatePoInput. */
export function validatePoBody(body: Record<string, unknown>): CreatePoInput {
  let supplierId: string | null = null;
  if (body.supplierId != null && body.supplierId !== "") {
    if (typeof body.supplierId !== "string" || !isUuid(body.supplierId)) {
      invalid("invalid_po", "Invalid supplier.");
    }
    supplierId = body.supplierId;
  }
  const destinationLocationId =
    typeof body.destinationLocationId === "string" ? body.destinationLocationId : "";
  if (!isUuid(destinationLocationId)) {
    invalid("invalid_po", "Choose a destination location.");
  }
  return {
    supplierId,
    destinationLocationId,
    expectedAt: validateExpectedAt(body.expectedAt),
    notes: validateNotes(body.notes),
    lines: validateLines(body.lines),
  };
}

export interface ReceiveBody {
  /** Client-generated uuid, one per receive submission — the idempotency
   *  handle po_receive keys its ledger rows on, so a retried submission can
   *  never double-count stock. */
  receiptId: string;
  lines: ReceiveLineInput[];
}

/** Validate an inbound receive body into typed entries + the receipt id. */
export function validateReceiveBody(body: Record<string, unknown>): ReceiveBody {
  const receiptId = typeof body.receiptId === "string" ? body.receiptId : "";
  if (!isUuid(receiptId)) {
    invalid("invalid_receive", "Missing receive reference — reopen the receive panel and try again.");
  }
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid("invalid_receive", "Enter a quantity to receive on at least one line.");
  }
  const seen = new Set<string>();
  const lines = raw.map((entry) => {
    const line = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const lineId = typeof line.lineId === "string" ? line.lineId : "";
    if (!isUuid(lineId)) invalid("invalid_receive", "Invalid line reference.");
    if (seen.has(lineId)) invalid("invalid_receive", "Each line can only be received once.");
    seen.add(lineId);
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      invalid("invalid_receive", "Receive quantities must be whole numbers above zero.");
    }
    return { lineId, qty };
  });
  return { receiptId, lines };
}

// ---- shared lookups -----------------------------------------------------------

/** Destination preflight: exists, shop-scoped, and not deactivated. A NULL
 *  active flag counts as active — same rule as inventory_list and the SQL
 *  guards (legacy rows may carry NULL). Returns the name for DTO shaping. */
async function getActiveLocation(
  shopId: string,
  locationId: string,
): Promise<{ name: string }> {
  const { data, error } = await getSupabase()
    .from("location_dim")
    .select("id, name, active")
    .eq("shop_id", shopId)
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) invalid("invalid_po", "That location no longer exists.");
  if (data.active === false) {
    invalid("location_inactive", "That location is deactivated. Reactivate it first.");
  }
  return { name: String(data.name) };
}

interface VariantLabel {
  sku: string | null;
  title: string | null;
}

/** All variants must exist in this shop; returns their labels for the line
 *  sku/title snapshots. */
async function resolveShopVariants(
  shopId: string,
  variantIds: string[],
): Promise<Map<string, VariantLabel>> {
  const { data, error } = await getSupabase()
    .from("variant_dim")
    .select("id, sku, title")
    .eq("shop_id", shopId)
    .in("id", variantIds);
  if (error) throw error;
  const labels = new Map<string, VariantLabel>();
  for (const v of data ?? []) {
    labels.set(String(v.id), {
      sku: v.sku == null ? null : String(v.sku),
      title: v.title == null ? null : String(v.title),
    });
  }
  if (variantIds.some((id) => !labels.has(id))) {
    invalid("variant_not_found", "One of those variants no longer exists.");
  }
  return labels;
}

/** Resolve a supplier for create/update: shop-scoped, returns the snapshot name
 *  + lead time. Inactive suppliers are still resolvable (an in-flight PO keeps
 *  working after a deactivation), but the UI only offers active ones. */
async function resolveSupplier(
  shopId: string,
  supplierId: string,
): Promise<{ name: string; leadTimeDays: number | null }> {
  const { data, error } = await getSupabase()
    .from("supplier_dim")
    .select("id, name, lead_time_days")
    .eq("shop_id", shopId)
    .eq("id", supplierId)
    .maybeSingle();
  if (error) throw error;
  if (!data) invalid("supplier_not_found", "That supplier no longer exists.");
  return {
    name: String(data.name),
    leadTimeDays: data.lead_time_days == null ? null : Number(data.lead_time_days),
  };
}

/** Vendor snapshot + ETA default shared by create and draft update. */
async function resolveVendorAndEta(
  shopId: string,
  supplierId: string | null,
): Promise<{ vendorName: string | null; leadTimeDays: number | null }> {
  if (!supplierId) return { vendorName: null, leadTimeDays: null };
  const supplier = await resolveSupplier(shopId, supplierId);
  return { vendorName: supplier.name, leadTimeDays: supplier.leadTimeDays };
}

// ---- reads --------------------------------------------------------------------

interface RawPoRow {
  id: string;
  po_number: string;
  supplier_id: string | null;
  vendor_name: string | null;
  destination_location_id: string;
  status: string;
  expected_at: string | null;
  notes: string | null;
  source: string;
  audit_id: string | null;
  created_at: string;
  updated_at: string;
  ordered_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
}

interface RawLineRow {
  id: string;
  variant_id: string | null;
  sku: string | null;
  variant_title: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost_cents: number | null;
}

const LINE_COLUMNS = "id, variant_id, sku, variant_title, qty_ordered, qty_received, unit_cost_cents";

/** Line DTO from a raw row: prefer the live variant label, fall back to the
 *  snapshot taken at line creation (the variant may have been deleted). */
function mapLine(raw: RawLineRow, live: VariantLabel | undefined): PoLineDto {
  return {
    id: String(raw.id),
    variantId: raw.variant_id == null ? null : String(raw.variant_id),
    sku: live?.sku ?? (raw.sku == null ? null : String(raw.sku)),
    title: live?.title ?? (raw.variant_title == null ? null : String(raw.variant_title)),
    qtyOrdered: Number(raw.qty_ordered),
    qtyReceived: Number(raw.qty_received),
    unitCostCents: raw.unit_cost_cents == null ? null : Number(raw.unit_cost_cents),
  };
}

function toDetail(row: RawPoRow, destinationName: string, lines: PoLineDto[]): PoDetailDto {
  return {
    id: String(row.id),
    poNumber: String(row.po_number),
    supplierName: row.vendor_name == null ? null : String(row.vendor_name),
    destinationName,
    status: asPoStatus(row.status),
    expectedAt: row.expected_at == null ? null : String(row.expected_at),
    source: row.source === "autopilot" ? "autopilot" : "manual",
    lineCount: lines.length,
    unitsOrdered: lines.reduce((sum, l) => sum + l.qtyOrdered, 0),
    unitsReceived: lines.reduce((sum, l) => sum + l.qtyReceived, 0),
    totalCents: sumTotalCents(
      lines.map((l) => ({ qty: l.qtyOrdered, unitCostCents: l.unitCostCents })),
    ),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierId: row.supplier_id == null ? null : String(row.supplier_id),
    destinationLocationId: String(row.destination_location_id),
    notes: row.notes == null ? null : String(row.notes),
    auditId: row.audit_id == null ? null : String(row.audit_id),
    orderedAt: row.ordered_at == null ? null : String(row.ordered_at),
    receivedAt: row.received_at == null ? null : String(row.received_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
    lines,
  };
}

interface PoListRpcRow {
  id: string;
  po_number: string;
  vendor_name: string | null;
  destination_name: string;
  status: string;
  expected_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  line_count: number | string;
  units_ordered: number | string;
  units_received: number | string;
  total_cents: number | string | null;
  total_count: number | string;
}

/** One page of POs with per-PO aggregates computed in SQL (po_list), so page
 *  totals never depend on PostgREST's 1000-row response clamp. */
export async function listPurchaseOrders(
  shopId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ pos: PoListItemDto[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(0, opts.offset ?? 0);
  const { data, error } = await getSupabase().rpc("po_list", {
    p_shop_id: shopId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) throw error;
  const rows = (data ?? []) as unknown as PoListRpcRow[];
  if (rows.length === 0) {
    if (offset === 0) return { pos: [], total: 0 };
    // Paged past the end (the list shrank between pages) — count for an
    // honest total, since the window count needs at least one row.
    const { count, error: countErr } = await getSupabase()
      .from("purchase_order")
      .select("id", { count: "exact", head: true })
      .eq("shop_id", shopId);
    if (countErr) throw countErr;
    return { pos: [], total: count ?? 0 };
  }
  return {
    pos: rows.map((row) => ({
      id: String(row.id),
      poNumber: String(row.po_number),
      supplierName: row.vendor_name == null ? null : String(row.vendor_name),
      destinationName: String(row.destination_name),
      status: asPoStatus(row.status),
      expectedAt: row.expected_at == null ? null : String(row.expected_at),
      source: row.source === "autopilot" ? ("autopilot" as const) : ("manual" as const),
      lineCount: Number(row.line_count),
      unitsOrdered: Number(row.units_ordered),
      unitsReceived: Number(row.units_received),
      totalCents: row.total_cents == null ? null : Number(row.total_cents),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    total: Number(rows[0].total_count),
  };
}

/** Which of the given draft audit_ids were already promoted into real POs —
 *  the drafts list hides these so a converted draft can't be converted twice
 *  from the UI. Bounded to the visible drafts (≤50): an unbounded read would
 *  clamp at PostgREST's 1000 rows and silently resurrect old drafts. */
export async function listPromotedAuditIds(
  shopId: string,
  auditIds: string[],
): Promise<string[]> {
  const ids = [...new Set(auditIds.filter((id) => isUuid(id)))].slice(0, 50);
  if (ids.length === 0) return [];
  const { data, error } = await getSupabase()
    .from("purchase_order")
    .select("audit_id")
    .eq("shop_id", shopId)
    .in("audit_id", ids);
  if (error) throw error;
  return (data ?? []).map((row) => String(row.audit_id));
}

export async function getPurchaseOrder(shopId: string, poId: string): Promise<PoDetailDto> {
  if (!isUuid(poId)) {
    invalid("po_not_found", "That purchase order no longer exists.", 404);
  }
  const { data, error } = await getSupabase()
    .from("purchase_order")
    .select("*")
    .eq("shop_id", shopId)
    .eq("id", poId)
    .maybeSingle();
  if (error) throw error;
  if (!data) invalid("po_not_found", "That purchase order no longer exists.", 404);
  const row = data as unknown as RawPoRow;

  const { data: lineRows, error: lineErr } = await getSupabase()
    .from("purchase_order_line")
    .select(LINE_COLUMNS)
    .eq("shop_id", shopId)
    .eq("po_id", poId);
  if (lineErr) throw lineErr;
  const rawLines = (lineRows ?? []) as unknown as RawLineRow[];

  const variantIds = [
    ...new Set(rawLines.flatMap((l) => (l.variant_id == null ? [] : [String(l.variant_id)]))),
  ];
  const labels = new Map<string, VariantLabel>();
  if (variantIds.length) {
    const { data: variants, error: vErr } = await getSupabase()
      .from("variant_dim")
      .select("id, sku, title")
      .eq("shop_id", shopId)
      .in("id", variantIds);
    if (vErr) throw vErr;
    for (const v of variants ?? []) {
      labels.set(String(v.id), {
        sku: v.sku == null ? null : String(v.sku),
        title: v.title == null ? null : String(v.title),
      });
    }
  }

  const lines = rawLines.map((l) =>
    mapLine(l, l.variant_id == null ? undefined : labels.get(String(l.variant_id))),
  );

  const { data: loc, error: locErr } = await getSupabase()
    .from("location_dim")
    .select("id, name")
    .eq("shop_id", shopId)
    .eq("id", String(row.destination_location_id))
    .maybeSingle();
  if (locErr) throw locErr;
  return toDetail(row, loc?.name == null ? "Location" : String(loc.name), lines);
}

// ---- writes --------------------------------------------------------------------

/** The audit_id partial unique index: its violation means "this Autopilot
 *  draft was already promoted", distinct from a po_number collision. */
const AUDIT_UNIQUE_CONSTRAINT = "purchase_order_audit_id_key";

/** Constraint name of a unique violation ("" when unparseable), null for any
 *  other error. Matching the constraint NAME (not a substring of the whole
 *  message) keeps po_number collisions and audit_id double-promotions apart. */
function uniqueConstraintName(error: { code?: string; message?: string }): string | null {
  if (error.code !== "23505") return null;
  const m = /unique constraint "([^"]+)"/.exec(String(error.message ?? ""));
  return m?.[1] ?? "";
}

async function insertLines(
  shopId: string,
  poId: string,
  lines: PoLineInput[],
  labels: Map<string, VariantLabel>,
): Promise<PoLineDto[]> {
  const { data, error } = await getSupabase()
    .from("purchase_order_line")
    .insert(
      lines.map((line) => ({
        shop_id: shopId,
        po_id: poId,
        variant_id: line.variantId,
        sku: labels.get(line.variantId)?.sku ?? null,
        variant_title: labels.get(line.variantId)?.title ?? null,
        qty_ordered: line.qty,
        unit_cost_cents: line.unitCostCents,
      })),
    )
    .select(LINE_COLUMNS);
  if (error) throw error;
  return ((data ?? []) as unknown as RawLineRow[]).map((l) =>
    mapLine(l, l.variant_id == null ? undefined : labels.get(String(l.variant_id))),
  );
}

export async function createPurchaseOrder(
  shopId: string,
  input: CreatePoInput,
  opts: { source?: "manual" | "autopilot"; auditId?: string; poNumber?: string } = {},
): Promise<PoDetailDto> {
  // The three preflights are independent reads — run them together.
  const [location, labels, vendor] = await Promise.all([
    getActiveLocation(shopId, input.destinationLocationId),
    resolveShopVariants(shopId, input.lines.map((l) => l.variantId)),
    resolveVendorAndEta(shopId, input.supplierId),
  ]);
  let expectedAt = input.expectedAt;
  // When a supplier with a lead time is chosen and no explicit ETA is given,
  // default the ETA server-side so the list is honest without extra input.
  if (!expectedAt && vendor.leadTimeDays != null) {
    expectedAt = defaultEta(vendor.leadTimeDays);
  }

  const insertPo = async (poNumber: string) =>
    getSupabase()
      .from("purchase_order")
      .insert({
        shop_id: shopId,
        po_number: poNumber,
        supplier_id: input.supplierId,
        vendor_name: vendor.vendorName,
        destination_location_id: input.destinationLocationId,
        expected_at: expectedAt,
        notes: input.notes,
        source: opts.source ?? "manual",
        audit_id: opts.auditId ?? null,
      })
      .select("*")
      .single();

  let created = await insertPo(opts.poNumber ?? generatePoNumber());
  let constraint = created.error ? uniqueConstraintName(created.error) : null;
  if (constraint === AUDIT_UNIQUE_CONSTRAINT) {
    invalid("already_promoted", "That draft was already converted to a purchase order.");
  }
  if (constraint != null) {
    // po_number collision (e.g. a promoted draft number a manual PO already
    // took) — retry once with a freshly generated number. The retry can still
    // lose an audit_id race, which must surface as already_promoted, not 500.
    created = await insertPo(generatePoNumber());
    constraint = created.error ? uniqueConstraintName(created.error) : null;
    if (constraint === AUDIT_UNIQUE_CONSTRAINT) {
      invalid("already_promoted", "That draft was already converted to a purchase order.");
    }
  }
  if (created.error) throw created.error;
  const header = created.data as unknown as RawPoRow;
  const poId = String(header.id);

  let lines: PoLineDto[];
  try {
    lines = await insertLines(shopId, poId, input.lines, labels);
  } catch (err) {
    // Lines are inserted after the header (no cross-statement transaction over
    // PostgREST); remove the orphaned header so a failed create leaves nothing.
    const { error: cleanupErr } = await getSupabase()
      .from("purchase_order")
      .delete()
      .eq("shop_id", shopId)
      .eq("id", poId);
    if (cleanupErr) console.error("[po] failed to clean up orphaned PO header", cleanupErr);
    throw err;
  }
  // Both inserts returned their rows — the DTO composes without a refetch.
  return toDetail(header, location.name, lines);
}

export async function updateDraftPurchaseOrder(
  shopId: string,
  poId: string,
  input: CreatePoInput,
): Promise<PoDetailDto> {
  if (!isUuid(poId)) {
    invalid("po_not_found", "That purchase order no longer exists.", 404);
  }
  const [, labels, vendor] = await Promise.all([
    getActiveLocation(shopId, input.destinationLocationId),
    resolveShopVariants(shopId, input.lines.map((l) => l.variantId)),
    resolveVendorAndEta(shopId, input.supplierId),
  ]);
  let expectedAt = input.expectedAt;
  if (!expectedAt && vendor.leadTimeDays != null) {
    expectedAt = defaultEta(vendor.leadTimeDays);
  }

  // The whole edit (draft check + header + replace-all lines) runs atomically
  // inside po_update_draft under a FOR UPDATE lock, so a PO that concurrently
  // left draft raises po_not_draft instead of losing its lines.
  const { error } = await getSupabase().rpc("po_update_draft", {
    p_shop_id: shopId,
    p_po_id: poId,
    p_header: {
      supplier_id: input.supplierId,
      vendor_name: vendor.vendorName,
      destination_location_id: input.destinationLocationId,
      expected_at: expectedAt,
      notes: input.notes,
    },
    p_lines: input.lines.map((line) => ({
      variant_id: line.variantId,
      sku: labels.get(line.variantId)?.sku ?? null,
      variant_title: labels.get(line.variantId)?.title ?? null,
      qty_ordered: line.qty,
      unit_cost_cents: line.unitCostCents,
    })),
  });
  if (error) throwMappedRpcError(error);
  return getPurchaseOrder(shopId, poId);
}

// ---- lifecycle (SQL-function wrappers) ------------------------------------------

/** The po_* SQL functions raise these bare errcodes as their exception message;
 *  the wrappers map them to named 4xxs. Exported so routes and tests share one
 *  vocabulary. */
export const PO_RPC_ERRORS: Record<string, { status: number; message: string }> = {
  po_not_found: { status: 404, message: "That purchase order no longer exists." },
  po_not_draft: { status: 422, message: "This purchase order is no longer a draft." },
  po_empty: { status: 422, message: "Add at least one line first." },
  location_inactive: {
    status: 422,
    message: "The destination location is deactivated. Reactivate it first.",
  },
  po_not_receivable: {
    status: 422,
    message: "Only an ordered purchase order can receive stock.",
  },
  invalid_receive_qty: {
    status: 422,
    message: "Receive quantities must be whole numbers above zero.",
  },
  invalid_receipt_id: {
    status: 422,
    message: "Missing receive reference — reopen the receive panel and try again.",
  },
  receipt_conflict: {
    status: 422,
    message: "That receive reference was already used with a different quantity.",
  },
  receive_exceeds_ordered: {
    status: 422,
    message: "You can't receive more units than were ordered.",
  },
  line_not_found: { status: 422, message: "One of those lines is not on this purchase order." },
  line_variant_missing: {
    status: 422,
    message: "One of those lines refers to a deleted product — remove the line first.",
  },
  po_not_cancellable: { status: 422, message: "This purchase order can no longer be cancelled." },
};

/** Map a po_* SQL-function error to its named 4xx. The SQL raises the bare
 *  errcode as the WHOLE message, so this is an exact match (a substring match
 *  could fire on an unrelated upstream error that merely mentions a code);
 *  anything else is a real upstream failure and is rethrown untouched. */
function throwMappedRpcError(error: { message?: string }): never {
  const code = String(error.message ?? "").trim();
  const mapping = PO_RPC_ERRORS[code];
  if (mapping) {
    throw new CalderynError({ code, status: mapping.status, message: mapping.message });
  }
  throw error;
}

/** How many projectLevelFact calls run at once during re-projection. */
const REPROJECT_CONCURRENCY = 8;

/** Re-project inventory_level_fact for every (variant, destination) a po_*
 *  function touched — same post-mutation pattern as the inventory engine.
 *  Bounded-parallel: a 100-line PO would take ~2 RTTs per variant serially. */
async function reprojectFromRpc(shopId: string, payload: unknown): Promise<void> {
  if (payload === null || typeof payload !== "object") return;
  const result = payload as { variantIds?: unknown; locationId?: unknown };
  const locationId = typeof result.locationId === "string" ? result.locationId : null;
  if (!locationId || !Array.isArray(result.variantIds)) return;
  const variantIds = [...new Set(result.variantIds.map((raw) => String(raw)))];
  for (let i = 0; i < variantIds.length; i += REPROJECT_CONCURRENCY) {
    await Promise.all(
      variantIds
        .slice(i, i + REPROJECT_CONCURRENCY)
        .map((variantId) => projectLevelFact(shopId, variantId, locationId)),
    );
  }
}

function assertPoId(poId: string): void {
  if (!isUuid(poId)) {
    invalid("po_not_found", "That purchase order no longer exists.", 404);
  }
}

export async function markOrdered(shopId: string, poId: string): Promise<PoDetailDto> {
  assertPoId(poId);
  const { data, error } = await getSupabase().rpc("po_mark_ordered", {
    p_shop_id: shopId,
    p_po_id: poId,
  });
  if (error) throwMappedRpcError(error);
  await reprojectFromRpc(shopId, data);
  return getPurchaseOrder(shopId, poId);
}

export async function receiveLines(
  shopId: string,
  poId: string,
  lines: ReceiveLineInput[],
  receiptId: string,
): Promise<PoDetailDto> {
  assertPoId(poId);
  if (!isUuid(receiptId)) {
    invalid("invalid_receive", "Missing receive reference — reopen the receive panel and try again.");
  }
  const { data, error } = await getSupabase().rpc("po_receive", {
    p_shop_id: shopId,
    p_po_id: poId,
    p_lines: lines.map((l) => ({ line_id: l.lineId, qty: l.qty })),
    p_receipt_id: receiptId,
  });
  if (error) throwMappedRpcError(error);
  await reprojectFromRpc(shopId, data);
  return getPurchaseOrder(shopId, poId);
}

export async function cancelPurchaseOrder(shopId: string, poId: string): Promise<PoDetailDto> {
  assertPoId(poId);
  const { data, error } = await getSupabase().rpc("po_cancel", {
    p_shop_id: shopId,
    p_po_id: poId,
  });
  if (error) throwMappedRpcError(error);
  await reprojectFromRpc(shopId, data);
  return getPurchaseOrder(shopId, poId);
}

// ---- promote an Autopilot draft ---------------------------------------------------

/** Convert a create_po_draft audit snapshot into a real draft PO: lines map
 *  sku → variant_dim (shop-scoped), destination is the shop's primary active
 *  location, source='autopilot', audit_id links back (double promotion is
 *  blocked by the partial unique index and surfaces as already_promoted). */
export async function promoteAuditDraft(shopId: string, auditId: string): Promise<PoDetailDto> {
  if (!isUuid(auditId)) {
    invalid("draft_not_found", "That restock draft no longer exists.", 404);
  }
  const { data, error } = await getSupabase()
    .from("action_audit")
    .select("id, action_kind, params")
    .eq("shop_id", shopId)
    .eq("id", auditId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.action_kind !== "create_po_draft" || !hasPoSnapshot(data.params)) {
    invalid("draft_not_found", "That restock draft no longer exists.", 404);
  }
  const snapshot = (data.params as { po: { po_number?: unknown; lines?: unknown } }).po;
  const rawLines = Array.isArray(snapshot.lines) ? (snapshot.lines as unknown[]) : [];
  if (rawLines.length === 0) {
    invalid("invalid_draft", "That draft has no lines to convert.");
  }

  const draftLines: PoLine[] = rawLines.map((entry) => {
    const line = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const sku = typeof line.sku === "string" ? line.sku : "";
    const quantity = Number(line.quantity);
    if (!sku || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) {
      invalid("invalid_draft", "That draft's lines can't be converted.");
    }
    // null in the snapshot means "cost unknown / TBD" and must stay null — a
    // bare Number(null) is 0, which would render a real $0.00 total instead of
    // "TBD". Only a genuine, in-range integer cost is carried through.
    const rawCost = line.unit_cost_cents;
    const cost = rawCost == null ? null : Number(rawCost);
    return {
      sku,
      title: typeof line.title === "string" ? line.title : sku,
      quantity,
      unit_cost_cents:
        cost != null && Number.isInteger(cost) && cost >= 0 && cost <= MAX_UNIT_COST_CENTS
          ? cost
          : null,
    };
  });

  // sku → variant. sku_dim.sku_code strings are what the snapshot carries;
  // variant_dim rows hold the same string in their sku column. A sku carried
  // by MORE than one variant is ambiguous — picking one would order stock for
  // an arbitrary variant, so refuse with the offending sku named.
  const skus = [...new Set(draftLines.map((l) => l.sku))];
  const { data: variants, error: vErr } = await getSupabase()
    .from("variant_dim")
    .select("id, sku")
    .eq("shop_id", shopId)
    .in("sku", skus);
  if (vErr) throw vErr;
  const variantBySku = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const v of variants ?? []) {
    const sku = v.sku == null ? "" : String(v.sku);
    if (!sku) continue;
    if (variantBySku.has(sku)) {
      if (!ambiguous.includes(sku)) ambiguous.push(sku);
    } else {
      variantBySku.set(sku, String(v.id));
    }
  }
  if (ambiguous.length) {
    invalid(
      "sku_ambiguous",
      `SKU ${ambiguous[0]} matches more than one variant — fix the duplicate SKU first.`,
    );
  }
  const missing = skus.filter((sku) => !variantBySku.has(sku));
  if (missing.length) {
    invalid(
      "sku_not_found",
      `No variant matches SKU ${missing[0]} — update the catalog first.`,
    );
  }

  // Merge lines that land on the same variant (unique per (po, variant)).
  const merged = new Map<string, PoLineInput>();
  for (const line of draftLines) {
    const variantId = variantBySku.get(line.sku)!;
    const existing = merged.get(variantId);
    if (existing) {
      existing.qty = Math.min(MAX_LINE_QTY, existing.qty + line.quantity);
      if (existing.unitCostCents == null) existing.unitCostCents = line.unit_cost_cents;
    } else {
      merged.set(variantId, {
        variantId,
        qty: line.quantity,
        unitCostCents: line.unit_cost_cents,
      });
    }
  }

  const destinationLocationId = await ensurePrimaryLocation(shopId);
  const poNumber =
    typeof snapshot.po_number === "string" && snapshot.po_number ? snapshot.po_number : undefined;
  return createPurchaseOrder(
    shopId,
    {
      supplierId: null,
      destinationLocationId,
      expectedAt: null,
      notes: null,
      lines: [...merged.values()],
    },
    { source: "autopilot", auditId, poNumber },
  );
}
