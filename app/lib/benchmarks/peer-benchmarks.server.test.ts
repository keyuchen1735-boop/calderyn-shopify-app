import { beforeEach, describe, expect, it, vi } from "vitest";

// Programmable Supabase stub: maps table/view name -> rows.
let TABLES: Record<string, any[]> = {};

vi.mock("../supabase.server", () => ({
  resolveShopId: vi.fn().mockResolvedValue("shop-uuid"),
  getSupabase: () => ({
    from: (name: string) => {
      const rows = TABLES[name] ?? [];
      const builder: any = {
        _rows: rows,
        select() {
          return this;
        },
        eq(col: string, val: unknown) {
          this._rows = this._rows.filter((r: any) => r[col] === val);
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: this._rows[0] ?? null, error: null });
        },
        then(resolve: (v: any) => void) {
          // awaiting the builder (no maybeSingle) resolves the list.
          resolve({ data: this._rows, error: null });
        },
      };
      return builder;
    },
  }),
}));

import { getPeerBenchmarks } from "./peer-benchmarks.server";

beforeEach(() => {
  TABLES = {};
});

function consentedElectronics() {
  TABLES["shops"] = [{ id: "shop-uuid", peer_data_consent: true }];
  TABLES["v_peer_shop_niche"] = [{ shop_id: "shop-uuid", segment: "cat:electronics" }];
  TABLES["v_peer_kpi_aov"] = [{ shop_id: "shop-uuid", value: 300 }];
  TABLES["v_peer_kpi_return_rate"] = [{ shop_id: "shop-uuid", value: 0.1 }];
  TABLES["v_peer_kpi_gross_margin_pct"] = [{ shop_id: "shop-uuid", value: 0.5 }];
  TABLES["v_peer_kpi_ship_cost_pct"] = [{ shop_id: "shop-uuid", value: 0.08 }];
  TABLES["v_peer_metric_baselines"] = [
    { metric_key: "aov", segment: "cat:electronics", p25: 200, p50: 300, p75: 400, n: 7 },
  ];
}

describe("getPeerBenchmarks", () => {
  it("returns available KPI with percentile when consented and n>=5", async () => {
    consentedElectronics();
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.niche).toBe("cat:electronics");
    expect(out.consented).toBe(true);
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.your_value).toBe(300);
    expect(aov.available).toBe(true);
    expect(aov.n).toBe(7);
    expect(aov.percentile).toBe(50); // value == p50
  });

  it("shows your_value but gates peer fields when not consented", async () => {
    consentedElectronics();
    TABLES["shops"] = [{ id: "shop-uuid", peer_data_consent: false }];
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.consented).toBe(false);
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.your_value).toBe(300); // own data still shown
    expect(aov.available).toBe(false);
    expect(aov.p50).toBeNull();
    expect(aov.percentile).toBeNull();
  });

  it("gates peer fields when consented but niche has no baseline (n<5)", async () => {
    consentedElectronics();
    TABLES["v_peer_metric_baselines"] = []; // niche < 5 peers → no row
    const out = await getPeerBenchmarks("test.myshopify.com");
    const aov = out.kpis.find((k) => k.metric_key === "aov")!;
    expect(aov.available).toBe(false);
    expect(aov.your_value).toBe(300);
  });

  it("reports uncategorized niche (UI hides the card)", async () => {
    consentedElectronics();
    TABLES["v_peer_shop_niche"] = []; // no dominant category
    const out = await getPeerBenchmarks("test.myshopify.com");
    expect(out.niche).toBe("cat:uncategorized");
  });
});
