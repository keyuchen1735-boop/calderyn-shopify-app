// Merchant-facing suppliers (supplier_dim): shop-scoped contact records with a
// default lead time the PO flow uses to prefill an ETA. Distinct from the
// legacy global `supplier` table (viral sourcing, no shop_id) — do not merge
// the two concepts.

import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import { getSupabase } from "~/lib/supabase.server";
import type { SupplierDto, SupplierInput } from "./types";

export type { SupplierDto, SupplierInput } from "./types";

const SUPPLIER_COLUMNS = "id, name, email, phone, notes, lead_time_days, active, created_at";

function mapSupplier(row: Record<string, unknown>): SupplierDto {
  return {
    id: String(row.id),
    name: String(row.name),
    email: row.email == null ? null : String(row.email),
    phone: row.phone == null ? null : String(row.phone),
    notes: row.notes == null ? null : String(row.notes),
    leadTimeDays: row.lead_time_days == null ? null : Number(row.lead_time_days),
    active: row.active === true,
    createdAt: String(row.created_at),
  };
}

function invalid(message: string): never {
  throw new CalderynError({ code: "invalid_supplier", status: 422, message });
}

function assertSupplierId(supplierId: string): void {
  if (!isUuid(supplierId)) invalid("Invalid supplier reference.");
}

/** Validate + normalize a supplier create/update payload at the boundary. */
export function validateSupplierInput(body: Record<string, unknown>): SupplierInput {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) invalid("Supplier name is required.");
  if (name.length > 120) invalid("Supplier name must be 120 characters or fewer.");

  const text = (key: "email" | "phone" | "notes", max: number): string | null => {
    const v = body[key];
    if (v == null || v === "") return null;
    if (typeof v !== "string") invalid(`Invalid ${key}.`);
    const t = v.trim();
    if (t.length > max) invalid(`${key} must be ${max} characters or fewer.`);
    return t || null;
  };

  let leadTimeDays: number | null = null;
  if (body.leadTimeDays != null && body.leadTimeDays !== "") {
    const n = Number(body.leadTimeDays);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      invalid("Lead time must be a whole number of days between 0 and 365.");
    }
    leadTimeDays = n;
  }

  return {
    name,
    email: text("email", 254),
    phone: text("phone", 40),
    notes: text("notes", 2000),
    leadTimeDays,
  };
}

/** Duplicate-name unique violations map to a stable 422 the UI can name. */
function throwIfNameTaken(error: { code?: string; message?: string }): void {
  if (error.code === "23505") {
    throw new CalderynError({
      code: "supplier_name_taken",
      status: 422,
      message: "A supplier with that name already exists.",
    });
  }
}

export async function listSuppliers(shopId: string): Promise<SupplierDto[]> {
  const { data, error } = await getSupabase()
    .from("supplier_dim")
    .select(SUPPLIER_COLUMNS)
    .eq("shop_id", shopId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => mapSupplier(row as Record<string, unknown>));
}

export async function createSupplier(shopId: string, input: SupplierInput): Promise<SupplierDto> {
  const { data, error } = await getSupabase()
    .from("supplier_dim")
    .insert({
      shop_id: shopId,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
      lead_time_days: input.leadTimeDays ?? null,
    })
    .select(SUPPLIER_COLUMNS)
    .single();
  if (error) {
    throwIfNameTaken(error);
    throw error;
  }
  return mapSupplier(data as Record<string, unknown>);
}

export async function updateSupplier(
  shopId: string,
  supplierId: string,
  input: SupplierInput,
): Promise<SupplierDto> {
  assertSupplierId(supplierId);
  const { data, error } = await getSupabase()
    .from("supplier_dim")
    .update({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      notes: input.notes ?? null,
      lead_time_days: input.leadTimeDays ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("shop_id", shopId)
    .eq("id", supplierId)
    .select(SUPPLIER_COLUMNS)
    .maybeSingle();
  if (error) {
    throwIfNameTaken(error);
    throw error;
  }
  if (!data) {
    throw new CalderynError({
      code: "supplier_not_found",
      status: 404,
      message: "That supplier no longer exists.",
    });
  }
  return mapSupplier(data as Record<string, unknown>);
}

export async function setSupplierActive(
  shopId: string,
  supplierId: string,
  active: boolean,
): Promise<SupplierDto> {
  assertSupplierId(supplierId);
  const { data, error } = await getSupabase()
    .from("supplier_dim")
    .update({ active, updated_at: new Date().toISOString() })
    .eq("shop_id", shopId)
    .eq("id", supplierId)
    .select(SUPPLIER_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new CalderynError({
      code: "supplier_not_found",
      status: 404,
      message: "That supplier no longer exists.",
    });
  }
  return mapSupplier(data as Record<string, unknown>);
}
