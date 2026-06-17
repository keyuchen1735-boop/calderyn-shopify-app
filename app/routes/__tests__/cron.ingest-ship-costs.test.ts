import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../cron.ingest-ship-costs";
import type {
  ShipCostAdapter,
  ShipIntegrationKind,
  ShipProvider,
  ShipSource,
} from "~/lib/ship-cost/adapters/adapter";
import type { ShipWorkItem } from "~/lib/ship-cost/adapters/registry.server";

// ---------------------------------------------------------------------------
// Behavior under test (the fix): the ship cron must DISTINGUISH a benign "not
// connected" skip from a stored-but-BROKEN credential.
//   - adapter.connect() returns null  → benign skip  (NO sync_error written)
//   - adapter.connect() THROWS         → sync_status:'error' (a sync_error IS written),
//                                        same surfacing as a fetchCharges 401.
// These are cron-level (loader) behavior tests, not unit tests of connect().
// mapWithConcurrency is the REAL one (it provides per-slot isolation we assert);
// only the registry / land / runner module boundaries are mocked. Mirrors the
// cron.ingest.test.ts mocking style.
// ---------------------------------------------------------------------------

const { shipAdaptersForShops, landShipmentCharges, runShipCostResolution } = vi.hoisted(() => ({
  shipAdaptersForShops: vi.fn<() => Promise<ShipWorkItem[]>>(),
  landShipmentCharges: vi.fn(async () => ({
    matchedLineCount: 0,
    unmatchedCount: 0,
    skippedNoKeyCount: 0,
    duplicateExternalIdCount: 0,
  })),
  runShipCostResolution: vi.fn(async () => {}),
}));

vi.mock("~/lib/ship-cost/adapters/registry.server", () => ({ shipAdaptersForShops }));
vi.mock("~/lib/ship-cost/adapters/land.server", () => ({ landShipmentCharges }));
vi.mock("~/lib/ship-cost/runner.server", () => ({ runShipCostResolution }));

// Fake Supabase: capture every shop_integrations UPDATE patch (with the shop_id it
// was scoped to) so a test can assert what sync_status / sync_error was written per shop.
// setSync does: from('shop_integrations').update(patch).eq('shop_id', id).eq('kind', kind)
interface CapturedWrite {
  shopId: string;
  patch: Record<string, unknown>;
}
const writes: CapturedWrite[] = [];
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const w: CapturedWrite = { shopId: "", patch };
        return {
          eq: (col: string, val: string) => {
            if (col === "shop_id") {
              w.shopId = val;
              writes.push(w); // record once, on the shop_id eq
            }
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      },
    }),
  }),
}));

// ── adapter doubles ────────────────────────────────────────────────────────
function makeAdapter(
  provider: ShipProvider,
  kind: ShipIntegrationKind,
  connect: ShipCostAdapter["connect"],
): ShipCostAdapter {
  return { provider, integrationKind: kind, connect };
}
const okSource: ShipSource = { fetchCharges: async () => [] };

function workItem(shopId: string, adapter: ShipCostAdapter): ShipWorkItem {
  return { shopId, status: "ready", adapter };
}

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/ingest-ship-costs", { headers });
}

function errorWritesFor(shopId: string): CapturedWrite[] {
  return writes.filter((w) => w.shopId === shopId && w.patch.sync_status === "error");
}

describe("cron.ingest-ship-costs loader — skip vs. broken-connection error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writes.length = 0;
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("records sync_status:'error' (with a sync_error) when connect() THROWS — a stored-but-broken credential is NOT a silent skip", async () => {
    // ShipHero shape: a credential is stored but the refresh token is revoked/expired →
    // connect() throws. The cron must surface it as an error, not bucket it as skipped.
    const broken = makeAdapter("shiphero", "shiphero_ship", async () => {
      throw new Error("ShipHero token refresh 401 Unauthorized: nope");
    });
    shipAdaptersForShops.mockResolvedValue([workItem("shopBroken", broken)]);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    // NOT skipped …
    expect(body.skipped).not.toContain("shopBroken:shiphero");
    // … recorded as an error in the summary …
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("shopBroken");
    expect(body.errors[0]).toContain("401");
    // … AND a sync_status:'error' patch with a non-empty sync_error was persisted.
    const errs = errorWritesFor("shopBroken");
    expect(errs).toHaveLength(1);
    expect(errs[0].patch.sync_error).toEqual(expect.stringContaining("401"));
    // never resolved ship-cost for a shop that failed to connect
    expect(runShipCostResolution).not.toHaveBeenCalled();
  });

  it("treats connect() returning null as a benign skip — NO sync_error is written", async () => {
    // No stored credential (shop never connected / disconnected). Preserve existing behavior.
    const notConnected = makeAdapter("shiphero", "shiphero_ship", async () => null);
    shipAdaptersForShops.mockResolvedValue([workItem("shopUnconnected", notConnected)]);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    expect(body.skipped).toContain("shopUnconnected:shiphero");
    expect(body.errors).toEqual([]);
    // crucially: no error-status row was written for a benign skip.
    expect(errorWritesFor("shopUnconnected")).toHaveLength(0);
    expect(writes).toHaveLength(0); // a skip writes nothing at all
  });

  it("isolates a broken shop from a healthy one in the same batch (per-slot isolation preserved)", async () => {
    const broken = makeAdapter("shiphero", "shiphero_ship", async () => {
      throw new Error("ShipHero token refresh 401 Unauthorized: nope");
    });
    const healthy = makeAdapter("easypost", "easypost_ship", async () => okSource);
    shipAdaptersForShops.mockResolvedValue([
      workItem("shopBroken", broken),
      workItem("shopHealthy", healthy),
    ]);

    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();

    // broken → error; healthy → still landed & resolved.
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("shopBroken");
    expect(body.landed.join(" ")).toContain("shopHealthy:easypost");
    expect(runShipCostResolution).toHaveBeenCalledTimes(1);
    expect(runShipCostResolution).toHaveBeenCalledWith(expect.anything(), "shopHealthy", { shopCountry: null });

    // healthy shop flipped to 'live'; broken shop written as 'error'.
    expect(writes.find((w) => w.shopId === "shopHealthy")?.patch.sync_status).toBe("live");
    expect(errorWritesFor("shopBroken")).toHaveLength(1);
  });
});
