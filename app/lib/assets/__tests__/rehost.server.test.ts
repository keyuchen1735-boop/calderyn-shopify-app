import { describe, it, expect, vi, beforeEach } from "vitest";

const { fromMock, mirrorMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  mirrorMock: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("../persist.server", () => ({
  mirrorShopifyImage: mirrorMock,
  SHOP_ASSETS_BUCKET: "shop-assets",
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock so the fakes register first
import { sweepPendingMedia, OWNED_URL_MARKER, MAX_REHOST_ATTEMPTS } from "../rehost.server";

const PRODUCT = "aaaaaaaa-0000-0000-0000-000000000001";
const SHOP = "11111111-2222-3333-4444-555555555555";
const HOTLINK = "https://cdn.supplier.example/img.png";
const OWNED = `https://sb.co${OWNED_URL_MARKER}k1.png`;

/** Thenable chain builder: every method returns the chain; awaiting resolves `result`.
 *  Mutating calls (update/delete) are recorded with their payload and eq/in filter. */
interface Recorded {
  table: string;
  update?: Record<string, unknown>;
  delete?: boolean;
  filters: Array<[string, unknown]>;
}
const recorded: Recorded[] = [];
function chain(table: string, result: { data?: unknown; error?: unknown }) {
  const rec: Recorded = { table, filters: [] };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "is", "not", "lt", "order", "limit", "range", "in", "eq", "update", "delete"]) {
    c[m] = vi.fn((...args: unknown[]) => {
      if (m === "update") rec.update = args[0] as Record<string, unknown>;
      if (m === "delete") rec.delete = true;
      if (m === "eq" || m === "in") rec.filters.push([String(args[0]), args[1]]);
      return c;
    });
  }
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
    if (rec.update || rec.delete) recorded.push(rec);
    return Promise.resolve({ data: null, error: null, ...result }).then(resolve);
  };
  return c;
}

/** Queue of results served to successive sb.from() calls, keyed by call order. */
let fromQueue: Array<{ table: string; result: { data?: unknown; error?: unknown } }> = [];
beforeEach(() => {
  recorded.length = 0;
  fromQueue = [];
  fromMock.mockReset().mockImplementation((table: string) => {
    const next = fromQueue.shift();
    if (!next) return chain(table, { data: [] });
    expect(table).toBe(next.table);
    return chain(table, next.result);
  });
  mirrorMock.mockReset();
});

function pendingRow(over: Partial<Record<string, unknown>> = {}) {
  return { id: "media-1", product_id: PRODUCT, external_url: HOTLINK, rehost_attempts: 0, ...over };
}

describe("sweepPendingMedia", () => {
  it("rehosts a pending hotlink: rewrites external_url and preserves source_url", async () => {
    fromQueue = [
      { table: "product_media", result: { data: [pendingRow()] } },
      { table: "product_media", result: { data: [] } }, // sibling dedup read
      { table: "product_dim", result: { data: [{ id: PRODUCT, shop_id: SHOP }] } },
      { table: "product_media", result: {} }, // the rewrite
    ];
    mirrorMock.mockResolvedValue({ persisted: true, url: OWNED, assetId: "a1", storageKey: "k1" });

    const res = await sweepPendingMedia();

    expect(mirrorMock).toHaveBeenCalledWith(SHOP, HOTLINK);
    expect(res).toMatchObject({ scanned: 1, rehosted: 1, failed: 0, orphaned: 0, deduped: 0 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].update).toEqual({ external_url: OWNED, source_url: HOTLINK });
    expect(recorded[0].filters).toContainEqual(["id", "media-1"]);
  });

  it("keeps the hotlink and bumps rehost_attempts when persistence fails", async () => {
    fromQueue = [
      { table: "product_media", result: { data: [pendingRow({ rehost_attempts: 2 })] } },
      { table: "product_media", result: { data: [] } }, // sibling dedup read
      { table: "product_dim", result: { data: [{ id: PRODUCT, shop_id: SHOP }] } },
      { table: "product_media", result: {} }, // the attempts bump
    ];
    mirrorMock.mockResolvedValue({ persisted: false, url: HOTLINK, error: "fetch_failed" });

    const res = await sweepPendingMedia();

    expect(res).toMatchObject({ scanned: 1, rehosted: 0, failed: 1 });
    expect(recorded[0].update).toEqual({ rehost_attempts: 3 });
  });

  it("skips rows whose product is gone, loudly, without persisting", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fromQueue = [
      { table: "product_media", result: { data: [pendingRow()] } },
      { table: "product_media", result: { data: [] } }, // sibling dedup read
      { table: "product_dim", result: { data: [] } }, // no product row
    ];

    const res = await sweepPendingMedia();

    expect(mirrorMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ scanned: 1, orphaned: 1, rehosted: 0 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("deletes a re-inserted hotlink BEFORE rehosting so no second owned copy is minted", async () => {
    fromQueue = [
      {
        table: "product_media",
        result: {
          data: [
            pendingRow({ id: "media-9" }), // re-insert of an already-captured hotlink
            pendingRow({ id: "media-2", external_url: "https://cdn.supplier.example/other.png" }),
          ],
        },
      },
      {
        table: "product_media",
        // sibling with source_url = the re-inserted hotlink: media-9 is a dupe
        result: { data: [{ product_id: PRODUCT, source_url: HOTLINK }] },
      },
      { table: "product_media", result: {} }, // the delete
      { table: "product_dim", result: { data: [{ id: PRODUCT, shop_id: SHOP }] } },
      { table: "product_media", result: {} }, // rewrite of media-2
    ];
    mirrorMock.mockResolvedValue({ persisted: true, url: OWNED, assetId: "a1", storageKey: "k1" });

    const res = await sweepPendingMedia();

    expect(res).toMatchObject({ scanned: 2, deduped: 1, rehosted: 1 });
    // The dupe was never re-persisted — only the surviving row reached mirror.
    expect(mirrorMock).toHaveBeenCalledTimes(1);
    expect(mirrorMock).toHaveBeenCalledWith(SHOP, "https://cdn.supplier.example/other.png");
    const del = recorded.find((r) => r.delete);
    expect(del?.filters).toContainEqual(["id", ["media-9"]]);
  });

  it("returns early with only the dedup delete when every pending row is a dupe", async () => {
    fromQueue = [
      { table: "product_media", result: { data: [pendingRow({ id: "media-9" })] } },
      { table: "product_media", result: { data: [{ product_id: PRODUCT, source_url: HOTLINK }] } },
      { table: "product_media", result: {} }, // the delete
    ];

    const res = await sweepPendingMedia();

    expect(res).toMatchObject({ scanned: 1, deduped: 1, rehosted: 0, failed: 0 });
    expect(mirrorMock).not.toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledTimes(3); // no product_dim read, no rewrites
  });

  it("counts a thrown worker as failed instead of aborting the sweep", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fromQueue = [
      { table: "product_media", result: { data: [pendingRow()] } },
      { table: "product_media", result: { data: [] } },
      { table: "product_dim", result: { data: [{ id: PRODUCT, shop_id: SHOP }] } },
    ];
    mirrorMock.mockRejectedValue(new Error("boom"));

    const res = await sweepPendingMedia();

    expect(res).toMatchObject({ scanned: 1, failed: 1, rehosted: 0 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns an empty summary without further queries when nothing is pending", async () => {
    fromQueue = [{ table: "product_media", result: { data: [] } }];

    const res = await sweepPendingMedia();

    expect(res).toEqual({ scanned: 0, rehosted: 0, failed: 0, orphaned: 0, deduped: 0 });
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(mirrorMock).not.toHaveBeenCalled();
  });

  it("exports the retry cap the query filters on", () => {
    // The .lt('rehost_attempts', MAX_REHOST_ATTEMPTS) predicate is what keeps a
    // dead URL from clogging every future run; pin the cap so a refactor that
    // drops it fails here.
    expect(MAX_REHOST_ATTEMPTS).toBe(5);
  });
});
