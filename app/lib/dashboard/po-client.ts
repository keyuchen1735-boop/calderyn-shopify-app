// Client fetchers for the Purchase orders surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file. The VM
// shapes ARE the shared wire types in ~/lib/po/types (one definition for both
// sides); errors throw DashboardApiError via the shared apiGet/apiSend
// plumbing.
import { apiGet, apiSend } from "./client";
import { cachedScreenData, SCREEN_CACHE_KEYS } from "./screen-cache";
import type {
  CreatePoInput,
  PoDetailDto,
  PoLineDto,
  PoLineInput,
  PoListItemDto,
  PoStatus,
  SupplierDto,
  SupplierInput,
} from "~/lib/po/types";

export type PoStatusVM = PoStatus;
export type SupplierVM = SupplierDto;
export type PoLineVM = PoLineDto;
export type PoListItemVM = PoListItemDto;
export type PoDetailVM = PoDetailDto;
export type PoLineInputVM = PoLineInput;
export type PoDraftInputVM = CreatePoInput;
export type SupplierInputVM = SupplierInput;

/** Everything the Purchase orders screen caches under SCREEN_CACHE_KEYS.po —
 *  the prefetch warm target MUST return exactly this shape or the seed misses. */
export interface PoScreenData {
  pos: PoListItemVM[];
  total: number;
  suppliers: SupplierVM[];
  promotedAuditIds: string[];
}

// ---- reads ------------------------------------------------------------------

/** Audit ids of the Autopilot drafts currently in the session cache — what the
 *  prefetch warm target passes to fetchPoScreen so the promoted-draft filter
 *  is warm too (best effort; the screen re-sends the live ids on mount). */
export function cachedDraftAuditIds(): string[] {
  const cached = cachedScreenData<{ rows: Array<{ id: string }> }>(
    SCREEN_CACHE_KEYS.purchaseOrders,
  );
  return (cached?.rows ?? []).map((r) => r.id).slice(0, 50);
}

/** The screen's offset-0 payload. `auditIds` is the visible Autopilot drafts
 *  (bounded ≤50); the server reports which of those were already promoted.
 *  `status` narrows the PO list to one lifecycle state — only the UNfiltered
 *  payload may be written to the screen cache. */
export async function fetchPoScreen(
  auditIds: string[] = [],
  status?: PoStatusVM,
): Promise<PoScreenData> {
  const ids = auditIds.slice(0, 50);
  const params = new URLSearchParams();
  if (ids.length) params.set("auditIds", ids.join(","));
  if (status) params.set("status", status);
  // toString(), not .size — URLSearchParams.size is missing on older Safari,
  // where an undefined check would silently drop every query param.
  const search = params.toString();
  const qs = search ? `?${search}` : "";
  const [list, suppliers] = await Promise.all([
    apiGet<{ pos: PoListItemVM[]; total: number; promotedAuditIds: string[] }>(
      `/dashboard/api/po${qs}`,
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
export async function fetchPoPage(
  offset: number,
  status?: PoStatusVM,
): Promise<{ pos: PoListItemVM[]; total: number }> {
  const params = new URLSearchParams({ offset: String(offset) });
  if (status) params.set("status", status);
  const d = await apiGet<{ pos: PoListItemVM[]; total: number }>(
    `/dashboard/api/po?${params.toString()}`,
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

/** `receiptId` is one uuid per receive SUBMISSION (crypto.randomUUID(), reused
 *  when the same submission is retried after a network error) — the server
 *  keys its stock writes on it so a replay can never double-count. */
export async function receivePoLines(
  poId: string,
  lines: Array<{ lineId: string; qty: number }>,
  receiptId: string,
): Promise<PoDetailVM> {
  const d = await apiSend<{ po: PoDetailVM }>(
    "POST",
    `/dashboard/api/po/${encodeURIComponent(poId)}`,
    { intent: "receive", receiptId, lines },
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
