import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../supabase/migrations/20260710225348_purchase_order_reliability.sql",
  ),
  "utf8",
).toLowerCase();

describe("purchase-order reliability migration contract", () => {
  it("serializes incoming recomputation on the inventory balance row", () => {
    const lock = SQL.indexOf("from public.inventory_balance b");
    const update = SQL.indexOf("update public.inventory_balance b", lock);
    expect(lock).toBeGreaterThan(-1);
    expect(SQL.slice(lock, update)).toContain("for update");
    expect(SQL).toContain("order by sort_line.variant_id nulls last, parsed.line_id");
  });

  it("accepts exact receipt replays after full receipt and returns their variants", () => {
    expect(SQL).toContain("po.status not in ('ordered','partial','received')");
    expect(SQL).toContain("'po_receive:' || p_receipt_id::text || ':' || ln.id::text");
    expect(SQL).toContain("raise exception 'receipt_conflict'");
    expect(SQL).toMatch(/if found then[\s\S]+v_variant_ids := v_variant_ids \|\| ln\.variant_id;[\s\S]+continue;/);
    expect(SQL).toMatch(/if po\.status = 'received' then\s+raise exception 'po_not_receivable'/);
  });

  it("rejects receipt-id reuse with a subset, superset, or changed quantity", () => {
    expect(SQL).toContain("v_existing_count <> jsonb_array_length(p_lines)");
    expect(SQL).toContain("pg_catalog.pg_advisory_xact_lock");
    expect(SQL).toMatch(
      /from jsonb_array_elements\(p_lines\) submitted[\s\S]+existing\.qty = \(submitted ->> 'qty'\)::int/,
    );
    expect(SQL).toContain("v_is_replay := true");
    expect(SQL).toContain("po.status <> 'received' and not v_is_replay");
  });

  it("makes ordered and cancelled same-state retries repairable", () => {
    expect(SQL).toContain("po.status not in ('draft','ordered')");
    expect(SQL).toContain("po.status not in ('draft','ordered','partial','cancelled')");
    expect(SQL.match(/perform public\.po_recompute_incoming/g)?.length).toBe(3);
  });

  it.each([
    "purchase_order_supplier_id_idx",
    "purchase_order_destination_location_id_idx",
    "purchase_order_line_po_id_idx",
    "purchase_order_line_variant_id_idx",
  ])("adds the missing foreign-key index %s", (indexName) => {
    expect(SQL).toContain(`create index if not exists ${indexName}`);
  });
});
