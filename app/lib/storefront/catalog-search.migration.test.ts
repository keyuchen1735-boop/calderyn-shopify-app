import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migrationSql(): string {
  const directory = resolve("supabase/migrations");
  const matches = readdirSync(directory).filter((name) => name.endsWith("_storefront_catalog_search_page.sql"));
  expect(matches).toHaveLength(1);
  return readFileSync(resolve(directory, matches[0]!), "utf8").toLowerCase();
}

describe("storefront catalog search page migration", () => {
  it("keeps exact aggregates in Postgres while bounding complete search cards", () => {
    const sql = migrationSql();
    expect(sql).toContain("create or replace function public.storefront_catalog_search_page");
    expect(sql).toContain("p.shop_id = p_shop_id");
    expect(sql).toContain("p.status = 'active'");
    expect(sql).toContain("coalesce(p_limit, 1)");
    expect(sql).toMatch(/least\s*\(\s*greatest\s*\(\s*coalesce\s*\(\s*p_limit\s*,\s*1\s*\)\s*,\s*1\s*\)\s*,\s*24\s*\)/);
    expect(sql).toContain("select count(*) from filtered");
    expect(sql).toContain("'categories'");
    expect(sql).toContain("'tags'");
    expect(sql).toContain("'collections'");
    expect(sql).toContain("p_after_product_id");
    expect(sql).toContain("'cards'");
    expect(sql).not.toContain("'product_ids'");
    for (const key of [
      "'id'", "'handle'", "'title'", "'description'", "'image'", "'storage_path'", "'external_url'", "'alt'",
      "'variant'", "'sku'", "'price_cents'", "'compare_at_price_cents'", "'currency'", "'available'",
    ]) expect(sql).toContain(key);
    expect(sql).toMatch(
      /card_rows as materialized[\s\S]+from page_rows[\s\S]+page_position <= params\.page_limit[\s\S]+join lateral[\s\S]+from public\.variant_dim[\s\S]+limit 1[\s\S]+join lateral[\s\S]+from public\.product_media[\s\S]+limit 1/,
    );
    expect(sql).toContain("pg_catalog.left(coalesce(card_rows.description, ''), 500)");
  });

  it("derives the next cursor boundary from the last card in the same page snapshot", () => {
    const sql = migrationSql();
    expect(sql).toContain("'boundary'");
    expect(sql).toContain("'sort_value'");
    expect(sql).toContain("'product_id'");
    expect(sql).toMatch(
      /boundary as \([\s\S]+from page_rows[\s\S]+page_position <= params\.page_limit[\s\S]+order by page_rows\.page_position desc[\s\S]+limit 1/,
    );
    expect(sql).toMatch(/case when \(select has_next_page from page_metadata\)[\s\S]+else null[\s\S]+end/);
  });

  it("does not build tenant-wide variant and inventory rollups for unfiltered title pages", () => {
    const sql = migrationSql();
    expect(sql).not.toContain("inventory as materialized");
    expect(sql).toMatch(
      /rollup_variant_state as materialized \([\s\S]+from base_candidates[\s\S]+join public\.variant_dim[\s\S]+where p_available is not null[\s\S]+or p_sort in \('price_asc', 'price_desc'\)/,
    );
    expect(sql).toMatch(/variant_rollup as materialized \([\s\S]+from rollup_variant_state/);
  });

  it("sorts by the chosen sellable price and counts case-insensitive facets by distinct products", () => {
    const sql = migrationSql();
    expect(sql).not.toContain("min(coalesce(variant.retail_price_cents, 0))");
    expect(sql).toContain("when p_sort = 'price_desc' then -2147483649::bigint");
    expect(sql).toMatch(/min\(variant\.retail_price_cents\)\s+filter\s*\(\s*where/);
    expect(sql).toContain("group by pg_catalog.lower(filtered.category)");
    expect(sql).toContain("group by pg_catalog.lower(product_tag.value)");
    expect(sql).toContain("group by pg_catalog.lower(collection.handle)");
    expect(sql.match(/count\(distinct filtered\.id\)/g)).toHaveLength(3);
    expect(sql.match(/collate pg_catalog\."c"/g)).toHaveLength(3);
    expect(sql).toMatch(
      /case[\s\S]+when candidate_variant\.available then 0[\s\S]+when candidate_variant\.price_cents is not null then 1[\s\S]+else 2[\s\S]+candidate_variant\.price_cents asc nulls last[\s\S]+candidate_variant\.id asc/,
    );
  });

  it("keeps search-card defaults and skips unusable media before choosing primary imagery", () => {
    const sql = migrationSql();
    expect(sql).toContain("coalesce(variant.title, 'default') as title");
    expect(sql).toContain("coalesce(variant.currency, 'usd') as currency");
    expect(sql).toMatch(/where media\.product_id = page_rows\.id\s+and \(media\.storage_path is not null or media\.external_url is not null\)/);
    expect(sql).toContain("order by coalesce(media.is_primary, false) desc");
  });

  it("fails closed for an unsupported sort before selecting products", () => {
    const sql = migrationSql();
    expect(sql).toMatch(
      /where p\.shop_id = p_shop_id[\s\S]+and p_sort in \('relevance', 'title_asc', 'title_desc', 'price_asc', 'price_desc'\)/,
    );
  });

  it("exposes the security-invoker RPC only to the server service role", () => {
    const sql = migrationSql();
    expect(sql).toContain("security invoker");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toMatch(/revoke all on function public\.storefront_catalog_search_page[\s\S]+from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.storefront_catalog_search_page[\s\S]+to service_role/);
  });
});
