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
import type { PoLine } from "./draft.server";

export type PoStatus = "draft" | "ordered" | "partial" | "received" | "cancelled";

export interface PoLineInput {
  variantId: string;
  qty: number;
  unitCostCents: number | null;
}

export interface CreatePoInput {
  supplierId: string | null;
  destinationLocationId: string;
  expectedAt: string | null;
  notes: string | null;
  lines: PoLineInput[];
}

export interface PoLineDto {
  id: string;
  variantId: string;
  sku: string | null;
  title: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number | null;
}

export interface PoListItemDto {
  id: string;
  poNumber: string;
  supplierName: string | null;
  destinationName: string;
  status: PoStatus;
  expectedAt: string | null;
  source: "manual" | "autopilot";
  lineCount: number;
  unitsOrdered: number;
  unitsReceived: number;
  totalCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoDetailDto extends PoListItemDto {
  supplierId: string | null;
  destinationLocationId: string;
  notes: string | null;
  auditId: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: PoLineDto[];
}

export interface ReceiveLineInput {
  lineId: string;
  qty: number;
}

const PO_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "ordered",
  "partial",
  "received",
  "cancelled",
]);

const MAX_LINE_QTY = 1_000_000;
const MAX_PO_LINES = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(code: string, message: string, status = 422): never {
  throw new CalderynError({ code, status, message });
}

export function isPoStatus(value: string): value is PoStatus {
  return PO_STATUSES.has(value);
}

/** `PO-YYYYMMDD-XXXXXXXX` — same shape as the Autopilot draft numbers. */
export function generatePoNumber(now: Date = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replaceAll("-", "");
  const ref = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `PO-${ymd}-${ref}`;
}

/** Date-only ETA `today + leadTimeDays` (UTC day, matching `expected_at date`). */
export function defaultEta(leadTimeDays: number, now: Date = new Date()): string {
  return new Date(now.getTime() + leadTimeDays * 86_400_000).toISOString().slice(0, 10);
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
    if (!UUID_RE.test(variantId)) invalid("invalid_po", "Each line needs a valid variant.");
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
      if (!Number.isInteger(cost) || cost < 0) {
        invalid("invalid_po", "Unit costs must be zero or more, in cents.");
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
    if (typeof body.supplierId !== "string" || !UUID_RE.test(body.supplierId)) {
      invalid("invalid_po", "Invalid supplier.");
    }
    supplierId = body.supplierId;
  }
  const destinationLocationId =
    typeof body.destinationLocationId === "string" ? body.destinationLocationId : "";
  if (!UUID_RE.test(destinationLocationId)) {
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

/** Validate an inbound receive body into typed entries. */
export function validateReceiveBody(body: Record<string, unknown>): ReceiveLineInput[] {
  const raw = body.lines;
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid("invalid_receive", "Enter a quantity to receive on at least one line.");
  }
  return raw.map((entry) => {
    const line = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const lineId = typeof line.lineId === "string" ? line.lineId : "";
    if (!UUID_RE.test(lineId)) invalid("invalid_receive", "Invalid line reference.");
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      invalid("invalid_receive", "Receive quantities must be whole numbers above zero.");
    }
    return { lineId, qty };
  });
}

// ---- shared lookups -----------------------------------------------------------

async function assertActiveLocation(shopId: string, locationId: string): Promise<void> {
  const { data, error } = await getSupabase()
    .from("location_dim")
    .select("id, active")
    .eq("shop_id", shopId)
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) invalid("invalid_po", "That location no longer exists.");
  if (data.active !== true) {
    invalid("location_inactive", "That location is deactivated. Reactivate it first.");
  }
}

async function assertShopVariants(shopId: string, variantIds: string[]): Promise<void> {
  const { data, error } = await getSupabase()
    .from("variant_dim")
    .select("id")
    .eq("shop_id", shopId)
    .in("id", variantIds);
  if (error) throw error;
  const found = new Set((data ?? []).map((v) => String(v.id)));
  if (variantIds.some((id) => !found.has(id))) {
    invalid("variant_not_found", "One of those variants no longer exists.");
  }
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

async function locationNames(shopId: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await getSupabase()
    .from("location_dim")
    .select("id, name")
    .eq("shop_id", shopId)
    .in("id", ids);
  if (error) throw error;
  for (const row of data ?? []) names.set(String(row.id), String(row.name));
  return names;
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

function baseItem(
  row: RawPoRow,
  destinationName: string,
  lines: Array<{ qty_ordered: number; qty_received: number; unit_cost_cents: number | null }>,
): PoListItemDto {
  return {
    id: String(row.id),
    poNumber: String(row.po_number),
    supplierName: row.vendor_name == null ? null : String(row.vendor_name),
    destinationName,
    status: isPoStatus(String(row.status)) ? (String(row.status) as PoStatus) : "draft",
    expectedAt: row.expected_at == null ? null : String(row.expected_at),
    source: row.source === "autopilot" ? "autopilot" : "manual",
    lineCount: lines.length,
    unitsOrdered: lines.reduce((sum, l) => sum + Number(l.qty_ordered), 0),
    unitsReceived: lines.reduce((sum, l) => sum + Number(l.qty_received), 0),
    totalCents: sumTotalCents(
      lines.map((l) => ({
        qty: Number(l.qty_ordered),
        unitCostCents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents),
      })),
    ),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function listPurchaseOrders(
  shopId: string,
  opts: { status?: PoStatus; limit?: number; offset?: number } = {},
): Promise<{ pos: PoListItemDto[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(0, opts.offset ?? 0);
  let query = getSupabase()
    .from("purchase_order")
    .select("*", { count: "exact" })
    .eq("shop_id", shopId);
  if (opts.status) query = query.eq("status", opts.status);
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as RawPoRow[];
  if (rows.length === 0) return { pos: [], total: count ?? 0 };

  const poIds = rows.map((r) => String(r.id));
  const { data: lineRows, error: lineErr } = await getSupabase()
    .from("purchase_order_line")
    .select("po_id, qty_ordered, qty_received, unit_cost_cents")
    .eq("shop_id", shopId)
    .in("po_id", poIds);
  if (lineErr) throw lineErr;
  const linesByPo = new Map<
    string,
    Array<{ qty_ordered: number; qty_received: number; unit_cost_cents: number | null }>
  >();
  for (const raw of lineRows ?? []) {
    const key = String(raw.po_id);
    const list = linesByPo.get(key) ?? [];
    list.push({
      qty_ordered: Number(raw.qty_ordered),
      qty_received: Number(raw.qty_received),
      unit_cost_cents: raw.unit_cost_cents == null ? null : Number(raw.unit_cost_cents),
    });
    linesByPo.set(key, list);
  }

  const names = await locationNames(shopId, [
    ...new Set(rows.map((r) => String(r.destination_location_id))),
  ]);
  return {
    pos: rows.map((row) =>
      baseItem(
        row,
        names.get(String(row.destination_location_id)) ?? "Location",
        linesByPo.get(String(row.id)) ?? [],
      ),
    ),
    total: count ?? 0,
  };
}

/** audit_ids of drafts already promoted into real POs — the drafts list hides
 *  these so a converted draft can't be converted twice from the UI. */
export async function listPromotedAuditIds(shopId: string): Promise<string[]> {
  const { data, error } = await getSupabase()
    .from("purchase_order")
    .select("audit_id")
    .eq("shop_id", shopId)
    .not("audit_id", "is", null);
  if (error) throw error;
  return (data ?? []).map((row) => String(row.audit_id));
}

export async function getPurchaseOrder(shopId: string, poId: string): Promise<PoDetailDto> {
  if (!UUID_RE.test(poId)) {
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
    .select("id, variant_id, qty_ordered, qty_received, unit_cost_cents")
    .eq("shop_id", shopId)
    .eq("po_id", poId);
  if (lineErr) throw lineErr;
  const rawLines = lineRows ?? [];

  const variantIds = [...new Set(rawLines.map((l) => String(l.variant_id)))];
  const labels = new Map<string, { sku: string | null; title: string | null }>();
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

  const lines: PoLineDto[] = rawLines.map((l) => ({
    id: String(l.id),
    variantId: String(l.variant_id),
    sku: labels.get(String(l.variant_id))?.sku ?? null,
    title: labels.get(String(l.variant_id))?.title ?? null,
    qtyOrdered: Number(l.qty_ordered),
    qtyReceived: Number(l.qty_received),
    unitCostCents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents),
  }));

  const names = await locationNames(shopId, [String(row.destination_location_id)]);
  return {
    ...baseItem(
      row,
      names.get(String(row.destination_location_id)) ?? "Location",
      rawLines.map((l) => ({
        qty_ordered: Number(l.qty_ordered),
        qty_received: Number(l.qty_received),
        unit_cost_cents: l.unit_cost_cents == null ? null : Number(l.unit_cost_cents),
      })),
    ),
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

// ---- writes --------------------------------------------------------------------

async function insertLines(
  shopId: string,
  poId: string,
  lines: PoLineInput[],
): Promise<void> {
  const { error } = await getSupabase()
    .from("purchase_order_line")
    .insert(
      lines.map((line) => ({
        shop_id: shopId,
        po_id: poId,
        variant_id: line.variantId,
        qty_ordered: line.qty,
        unit_cost_cents: line.unitCostCents,
      })),
    );
  if (error) throw error;
}

export async function createPurchaseOrder(
  shopId: string,
  input: CreatePoInput,
  opts: { source?: "manual" | "autopilot"; auditId?: string; poNumber?: string } = {},
): Promise<PoDetailDto> {
  await assertActiveLocation(shopId, input.destinationLocationId);
  await assertShopVariants(shopId, input.lines.map((l) => l.variantId));

  let vendorName: string | null = null;
  let expectedAt = input.expectedAt;
  if (input.supplierId) {
    const supplier = await resolveSupplier(shopId, input.supplierId);
    vendorName = supplier.name;
    // When a supplier with a lead time is chosen and no explicit ETA is given,
    // default the ETA server-side so the list is honest without extra input.
    if (!expectedAt && supplier.leadTimeDays != null) {
      expectedAt = defaultEta(supplier.leadTimeDays);
    }
  }

  const insertPo = async (poNumber: string) =>
    getSupabase()
      .from("purchase_order")
      .insert({
        shop_id: shopId,
        po_number: poNumber,
        supplier_id: input.supplierId,
        vendor_name: vendorName,
        destination_location_id: input.destinationLocationId,
        expected_at: expectedAt,
        notes: input.notes,
        source: opts.source ?? "manual",
        audit_id: opts.auditId ?? null,
      })
      .select("id")
      .single();

  let created = await insertPo(opts.poNumber ?? generatePoNumber());
  if (created.error?.code === "23505") {
    if (String(created.error.message).includes("audit")) {
      invalid("already_promoted", "That draft was already converted to a purchase order.");
    }
    // po_number collision (e.g. a promoted draft number a manual PO already
    // took) — retry once with a freshly generated number.
    created = await insertPo(generatePoNumber());
  }
  if (created.error) throw created.error;
  const poId = String((created.data as { id: string }).id);

  try {
    await insertLines(shopId, poId, input.lines);
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
  return getPurchaseOrder(shopId, poId);
}

export async function updateDraftPurchaseOrder(
  shopId: string,
  poId: string,
  input: CreatePoInput,
): Promise<PoDetailDto> {
  const existing = await getPurchaseOrder(shopId, poId);
  if (existing.status !== "draft") {
    invalid("po_not_draft", "Only a draft purchase order can be edited.");
  }
  await assertActiveLocation(shopId, input.destinationLocationId);
  await assertShopVariants(shopId, input.lines.map((l) => l.variantId));

  let vendorName: string | null = null;
  let expectedAt = input.expectedAt;
  if (input.supplierId) {
    const supplier = await resolveSupplier(shopId, input.supplierId);
    vendorName = supplier.name;
    if (!expectedAt && supplier.leadTimeDays != null) {
      expectedAt = defaultEta(supplier.leadTimeDays);
    }
  }

  const { error } = await getSupabase()
    .from("purchase_order")
    .update({
      supplier_id: input.supplierId,
      vendor_name: vendorName,
      destination_location_id: input.destinationLocationId,
      expected_at: expectedAt,
      notes: input.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("shop_id", shopId)
    .eq("id", poId)
    .eq("status", "draft");
  if (error) throw error;

  // Replace-all line semantics: a draft holds no stock, so deleting and
  // reinserting is safe (no incoming to rebalance — edits are draft-only).
  const { error: delErr } = await getSupabase()
    .from("purchase_order_line")
    .delete()
    .eq("shop_id", shopId)
    .eq("po_id", poId);
  if (delErr) throw delErr;
  await insertLines(shopId, poId, input.lines);
  return getPurchaseOrder(shopId, poId);
}

// ---- lifecycle (SQL-function wrappers) ------------------------------------------

const RPC_ERROR_MAP: Record<string, { status: number; message: string }> = {
  po_not_found: { status: 404, message: "That purchase order no longer exists." },
  po_not_draft: { status: 422, message: "Only a draft purchase order can be marked ordered." },
  po_empty: { status: 422, message: "Add at least one line before marking it ordered." },
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
  receive_exceeds_ordered: {
    status: 422,
    message: "You can't receive more units than were ordered.",
  },
  line_not_found: { status: 422, message: "One of those lines is not on this purchase order." },
  po_not_cancellable: { status: 422, message: "This purchase order can no longer be cancelled." },
};

/** Map a po_* SQL-function error to its named 4xx; anything unrecognized is a
 *  real upstream failure and is rethrown untouched (never swallowed). */
function throwMappedRpcError(error: { message?: string }): never {
  const message = String(error.message ?? "");
  for (const [code, mapping] of Object.entries(RPC_ERROR_MAP)) {
    if (message.includes(code)) {
      throw new CalderynError({ code, status: mapping.status, message: mapping.message });
    }
  }
  throw error;
}

/** Re-project inventory_level_fact for every (variant, destination) a po_*
 *  function touched — same post-mutation pattern as the inventory engine. */
async function reprojectFromRpc(shopId: string, payload: unknown): Promise<void> {
  if (payload === null || typeof payload !== "object") return;
  const result = payload as { variantIds?: unknown; locationId?: unknown };
  const locationId = typeof result.locationId === "string" ? result.locationId : null;
  if (!locationId || !Array.isArray(result.variantIds)) return;
  const seen = new Set<string>();
  for (const raw of result.variantIds) {
    const variantId = String(raw);
    if (seen.has(variantId)) continue;
    seen.add(variantId);
    await projectLevelFact(shopId, variantId, locationId);
  }
}

export async function markOrdered(shopId: string, poId: string): Promise<PoDetailDto> {
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
): Promise<PoDetailDto> {
  const { data, error } = await getSupabase().rpc("po_receive", {
    p_shop_id: shopId,
    p_po_id: poId,
    p_lines: lines.map((l) => ({ line_id: l.lineId, qty: l.qty })),
  });
  if (error) throwMappedRpcError(error);
  await reprojectFromRpc(shopId, data);
  return getPurchaseOrder(shopId, poId);
}

export async function cancelPurchaseOrder(shopId: string, poId: string): Promise<PoDetailDto> {
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
  if (!UUID_RE.test(auditId)) {
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
    const cost = Number(line.unit_cost_cents);
    return {
      sku,
      title: typeof line.title === "string" ? line.title : sku,
      quantity,
      unit_cost_cents: Number.isInteger(cost) && cost >= 0 ? cost : null,
    };
  });

  // sku → variant. sku_dim.sku_code strings are what the snapshot carries;
  // variant_dim rows hold the same string in their sku column.
  const skus = [...new Set(draftLines.map((l) => l.sku))];
  const { data: variants, error: vErr } = await getSupabase()
    .from("variant_dim")
    .select("id, sku")
    .eq("shop_id", shopId)
    .in("sku", skus);
  if (vErr) throw vErr;
  const variantBySku = new Map<string, string>();
  for (const v of variants ?? []) {
    const sku = v.sku == null ? "" : String(v.sku);
    if (sku && !variantBySku.has(sku)) variantBySku.set(sku, String(v.id));
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
