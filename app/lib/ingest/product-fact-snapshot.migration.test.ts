import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260720203000_product_fact_ingestion.sql", "utf8");

describe("product fact snapshot replacement", () => {
  it("is provider-tagged, stable-ID keyed, shop-scoped, and atomic", () => {
    expect(sql).toContain("source_provider text");
    expect(sql).toContain("source_external_id text");
    expect(sql).toContain("on public.product_fact(shop_id, source_provider, source_external_id)");
    expect(sql).toContain("replace_product_fact_snapshot");
    expect(sql).toContain("security definer\nset search_path = ''");
    expect(sql).toContain("where p.shop_id = p_shop_id");
    expect(sql).toContain("and f.source_provider = p_provider");
    expect(sql).toContain("on conflict (shop_id, source_provider, source_external_id)");
    expect(sql).toContain("where incoming.external_id = f.source_external_id");
    expect(sql).toContain("deferrable initially deferred");
    expect(sql).toContain("revoke all on function public.replace_product_fact_snapshot(uuid, text, jsonb) from public");
    expect(sql).toContain("grant execute on function public.replace_product_fact_snapshot(uuid, text, jsonb) to service_role");
    expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(sql).toContain("p_shop_id::text || ':' || p_provider");
    expect(sql).toContain("jsonb_to_recordset");
    expect(sql).toContain("if p_facts is null or jsonb_typeof(p_facts) <> 'array'");
    expect(sql).toContain("nullif(btrim(f.product_external_id), '') is null");
    expect(sql).toContain("raise exception 'product fact snapshot references unknown product %'");
  });

  it("claims a rotating, locked batch of active Shopify shops", () => {
    expect(sql).toContain("product_facts_sync_attempted_at timestamptz");
    expect(sql).toContain("claim_product_fact_syncs");
    expect(sql).toContain("order by integrations.product_facts_sync_attempted_at asc nulls first");
    expect(sql).toContain("for update of integrations skip locked");
    expect(sql).toContain("set product_facts_sync_attempted_at = now()");
    expect(sql).toContain("grant execute on function public.claim_product_fact_syncs(integer) to service_role");
  });

  it("validates product ownership before the provider-scoped stale delete", () => {
    const ownershipCheck = sql.indexOf("where p.shop_id = p_shop_id and p.external_id = f.product_external_id");
    const advisoryLock = sql.indexOf("pg_catalog.pg_advisory_xact_lock");
    const staleDelete = sql.indexOf("delete from public.product_fact f");
    const upsert = sql.indexOf("insert into public.product_fact");
    expect(ownershipCheck).toBeGreaterThan(0);
    expect(advisoryLock).toBeGreaterThan(0);
    expect(advisoryLock).toBeLessThan(staleDelete);
    expect(ownershipCheck).toBeLessThan(staleDelete);
    expect(staleDelete).toBeLessThan(upsert);
    expect(sql.slice(staleDelete, upsert)).toContain("f.shop_id = p_shop_id");
    expect(sql.slice(staleDelete, upsert)).toContain("f.source_provider = p_provider");
    expect(sql.slice(staleDelete, upsert)).toContain("not exists");
  });

  it("preserves stable rows on retry and updates every projected value on conflict", () => {
    const conflict = sql.slice(sql.indexOf("on conflict (shop_id, source_provider, source_external_id)"));
    expect(conflict).toMatch(/do update set[\s\S]*product_id = excluded\.product_id/);
    expect(conflict).toMatch(/kind = excluded\.kind/);
    expect(conflict).toMatch(/text_value = excluded\.text_value/);
    expect(conflict).toMatch(/number_value = excluded\.number_value/);
    expect(conflict).toMatch(/unit = excluded\.unit/);
    expect(conflict).toMatch(/url_value = excluded\.url_value/);
    expect(conflict).toMatch(/position = excluded\.position/);
  });
});
