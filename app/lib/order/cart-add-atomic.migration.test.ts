import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const path = "supabase/migrations/202607200002_storefront_cart_line_personalization.sql";

describe("cart_add_line_atomic migration", () => {
  it("locks an active shop-owned cart and atomically upserts a capped quantity", () => {
    const sql = readFileSync(path, "utf8").toLowerCase();
    expect(sql).toContain("create or replace function public.cart_add_line_atomic");
    expect(sql).toContain("state = 'cart'");
    expect(sql).toContain("for update");
    expect(sql).toContain("on conflict (shop_id, cart_id, variant_id, personalization_hash)");
    expect(sql).toMatch(/least\s*\(\s*999\s*,\s*public\.cart_line\.quantity\s*\+/);
  });

  it("backfills canonical personalization identity and snapshots it onto orders", () => {
    const sql = readFileSync(path, "utf8").toLowerCase();
    expect(sql).toContain("add column personalization jsonb not null default '{}'::jsonb");
    expect(sql).toContain("add column personalization_hash text");
    expect(sql).toContain("update public.cart_line");
    expect(sql).toContain("add column personalization jsonb not null default '{}'::jsonb");
    expect(sql).toContain("unique (shop_id, cart_id, variant_id, personalization_hash)");
    expect(sql).toContain("'personalization', personalization");
  });

  it("preserves the first snapshot and exposes the function only to service_role", () => {
    const sql = readFileSync(path, "utf8").toLowerCase();
    const conflictUpdate = sql.split("do update set", 2)[1]?.split("returning", 1)[0] ?? "";
    expect(conflictUpdate).not.toContain("unit_price_cents =");
    expect(conflictUpdate).not.toContain("currency =");
    expect(conflictUpdate).not.toContain("title_snapshot =");
    expect(sql).toContain("security definer set search_path = ''");
    expect(sql).toContain("revoke all on function public.cart_add_line_atomic");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.cart_add_line_atomic");
    expect(sql).toContain("to service_role");
  });
});
