// Shared purchase-order wire shapes. Client-safe (types only): the server lib
// (purchase-orders.server.ts / suppliers.server.ts) shapes its DTOs to these
// and the dashboard client (po-client.ts) consumes the same definitions, so
// the two sides can never drift.

export type PoStatus = "draft" | "ordered" | "partial" | "received" | "cancelled";

export interface PoLineDto {
  id: string;
  /** null when the variant was deleted after the line was created — the
   *  sku/title snapshots below keep the row readable. */
  variantId: string | null;
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

export interface ReceiveLineInput {
  lineId: string;
  qty: number;
}

export interface SupplierDto {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  leadTimeDays: number | null;
  active: boolean;
  createdAt: string;
}

export interface SupplierInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  leadTimeDays?: number | null;
}
