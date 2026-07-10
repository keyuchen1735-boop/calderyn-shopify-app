// Client fetchers for the Purchase orders surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file. The VM
// shapes mirror the /dashboard/api/po DTOs one-to-one; errors throw
// DashboardApiError via the shared apiGet/apiSend plumbing.
import { apiGet, apiSend } from "./client";

export type PoStatusVM = "draft" | "ordered" | "partial" | "received" | "cancelled";

export interface SupplierVM {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  leadTimeDays: number | null;
  active: boolean;
  createdAt: string;
}

export interface PoLineVM {
  id: string;
  variantId: string;
  sku: string | null;
  title: string | null;
  qtyOrdered: number;
  qtyReceived: number;
  unitCostCents: number | null;
}

export interface PoListItemVM {
  id: string;
  poNumber: string;
  supplierName: string | null;
  destinationName: string;
  status: PoStatusVM;
  expectedAt: string | null;
  source: "manual" | "autopilot";
  lineCount: number;
  unitsOrdered: number;
  unitsReceived: number;
  totalCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoDetailVM extends PoListItemVM {
  supplierId: string | null;
  destinationLocationId: string;
  notes: string | null;
  auditId: string | null;
  orderedAt: string | null;
  receivedAt: string | null;
  cancelledAt: string | null;
  lines: PoLineVM[];
}

/** Everything the Purchase orders screen caches under SCREEN_CACHE_KEYS.po —
 *  the prefetch warm target MUST return exactly this shape or the seed misses. */
export interface PoScreenData {
  pos: PoListItemVM[];
  total: number;
  suppliers: SupplierVM[];
  promotedAuditIds: string[];
}

export interface PoLineInputVM {
  variantId: string;
  qty: number;
  unitCostCents: number | null;
}

export interface PoDraftInputVM {
  supplierId: string | null;
  destinationLocationId: string;
  expectedAt: string | null;
  notes: string | null;
  lines: PoLineInputVM[];
}

export interface SupplierInputVM {
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  leadTimeDays: number | null;
}

// ---- reads ------------------------------------------------------------------

export async function fetchPoScreen(): Promise<PoScreenData> {
  const [list, suppliers] = await Promise.all([
    apiGet<{ pos: PoListItemVM[]; total: number; promotedAuditIds: string[] }>(
      "/dashboard/api/po",
    ),
    apiGet<{ suppliers: SupplierVM[] }>("/dashboard/api/po/suppliers"),
  ]);
  return {
    pos: list.pos,
    total: list.total,
    suppliers: suppliers.suppliers,
    promotedAuditIds: list.promotedAuditIds,
  };
}

/** One further page of the PO list (the screen's Load more). Only the default
 *  offset-0 payload is ever cached; paged-in rows stay screen-local. */
export async function fetchPoPage(offset: number): Promise<{ pos: PoListItemVM[]; total: number }> {
  const d = await apiGet<{ pos: PoListItemVM[]; total: number }>(
    `/dashboard/api/po?offset=${encodeURIComponent(String(offset))}`,
  );
  return { pos: d.pos, total: d.total };
}

export async function fetchPoDetail(poId: string): Promise<PoDetailVM> {
  const d = await apiGet<{ po: PoDetailVM }>(`/dashboard/api/po/${encodeURIComponent(poId)}`);
  return d.po;
}

/** Download URL for a real PO's PDF (Content-Disposition names the file). */
export function poPdfUrl(poId: string): string {
  return `/dashboard/api/po/${encodeURIComponent(poId)}/po.pdf`;
}

// ---- mutations ----------------------------------------------------------------

export async function createPo(input: PoDraftInputVM): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>("POST", "/dashboard/api/po", {
    intent: "create",
    ...input,
  });
  return d.po;
}

export async function updatePoDraft(poId: string, input: PoDraftInputVM): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>(
    "POST",
    `/dashboard/api/po/${encodeURIComponent(poId)}`,
    { intent: "update", ...input },
  );
  return d.po;
}

export async function markPoOrdered(poId: string): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>(
    "POST",
    `/dashboard/api/po/${encodeURIComponent(poId)}`,
    { intent: "mark_ordered" },
  );
  return d.po;
}

export async function receivePoLines(
  poId: string,
  lines: Array<{ lineId: string; qty: number }>,
): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>(
    "POST",
    `/dashboard/api/po/${encodeURIComponent(poId)}`,
    { intent: "receive", lines },
  );
  return d.po;
}

export async function cancelPo(poId: string): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>(
    "POST",
    `/dashboard/api/po/${encodeURIComponent(poId)}`,
    { intent: "cancel" },
  );
  return d.po;
}

/** Convert a create_po_draft audit snapshot into a real draft PO. */
export async function promotePoDraft(auditId: string): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>("POST", "/dashboard/api/po", {
    intent: "promote_draft",
    auditId,
  });
  return d.po;
}

export async function createSupplier(input: SupplierInputVM): Promise<SupplierVM> {
  const d = await apiSend<{ supplier: SupplierVM }>("POST", "/dashboard/api/po/suppliers", {
    intent: "create",
    ...input,
  });
  return d.supplier;
}

export async function updateSupplier(
  supplierId: string,
  input: SupplierInputVM,
): Promise<SupplierVM> {
  const d = await apiSend<{ supplier: SupplierVM }>("POST", "/dashboard/api/po/suppliers", {
    intent: "update",
    supplierId,
    ...input,
  });
  return d.supplier;
}

export async function setSupplierActive(
  supplierId: string,
  active: boolean,
): Promise<SupplierVM> {
  const d = await apiSend<{ supplier: SupplierVM }>("POST", "/dashboard/api/po/suppliers", {
    intent: "set_active",
    supplierId,
    active,
  });
  return d.supplier;
}
