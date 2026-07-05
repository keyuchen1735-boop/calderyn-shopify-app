// Deterministic assignment, one-at-a-time start guards, distinct-session
// report math, and guarded decide transitions for store A/B experiments.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assignArm,
  clearStoreExperimentCache,
  getRunningExperiment,
  latestStudioExperiment,
  startExperiment,
  experimentReport,
  decideExperiment,
} from "./store-experiment.server";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// mocks still apply even though they are written below them.
const { fromMock, pageDoc, catalogMock, settingsMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  pageDoc: {
    loadPublishedDoc: vi.fn(),
    saveDraft: vi.fn(),
    publishDoc: vi.fn(),
  },
  catalogMock: {
    listProducts: vi.fn(),
    listCollections: vi.fn(),
  },
  settingsMock: { getStoreSettings: vi.fn(), saveStoreSettings: vi.fn() },
}));

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock }) }));
vi.mock("~/lib/storebuilder/page-document.server", () => pageDoc);
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => catalogMock }));
vi.mock("~/lib/storefront/settings.server", () => settingsMock);

const SHOP = "11111111-1111-1111-1111-111111111111";
const EXP_ID = "22222222-2222-2222-2222-222222222222";

const HOME_DOC = {
  kind: "singleton",
  pageKey: "home",
  blocks: [
    {
      id: "h",
      type: "hero",
      layout: { x: 0, y: 0, w: 12, h: 2 },
      props: { headline: "Welcome", subhead: "Shop our latest" },
    },
  ],
};

// Fake PostgREST: each from(table) mints a chainable builder whose terminal
// reads (maybeSingle / single / awaited range or update) pull FIFO results
// from a per-(table, verb) queue; writes are recorded in `calls`.
type Result = { data?: unknown; error?: unknown };
const resultQueues = new Map<string, Result[]>();
const calls: Array<{ table: string; verb: string; payload?: unknown }> = [];

function queue(key: string, ...results: Result[]): void {
  resultQueues.set(key, [...(resultQueues.get(key) ?? []), ...results]);
}

function nextResult(key: string): { data: unknown; error: unknown } {
  const q = resultQueues.get(key);
  const r = q && q.length > 0 ? q.shift()! : {};
  return { data: r.data ?? null, error: r.error ?? null };
}

function makeBuilder(table: string): Record<string, unknown> {
  let verb = "select";
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order", "limit"]) b[m] = () => b;
  const withVerb = (v: string, payload?: unknown) => {
    verb = v;
    calls.push({ table, verb: v, payload });
    return b;
  };
  b.insert = (row: unknown) => withVerb("insert", row);
  b.update = (row: unknown) => withVerb("update", row);
  b.upsert = (row: unknown) => {
    calls.push({ table, verb: "upsert", payload: row });
    return Promise.resolve(nextResult(`${table}:upsert`));
  };
  b.maybeSingle = () => Promise.resolve(nextResult(`${table}:${verb}.maybeSingle`));
  b.single = () => Promise.resolve(nextResult(`${table}:${verb}.single`));
  b.range = () => Promise.resolve(nextResult(`${table}:range`));
  b.then = (
    resolve: (v: { data: unknown; error: unknown }) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(nextResult(`${table}:${verb}`)).then(resolve, reject);
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearStoreExperimentCache();
  resultQueues.clear();
  calls.length = 0;
  fromMock.mockImplementation((table: string) => makeBuilder(table));
  pageDoc.loadPublishedDoc.mockResolvedValue(null);
  pageDoc.saveDraft.mockResolvedValue(undefined);
  pageDoc.publishDoc.mockResolvedValue(undefined);
  catalogMock.listProducts.mockResolvedValue([]);
  catalogMock.listCollections.mockResolvedValue([]);
  settingsMock.getStoreSettings.mockResolvedValue({
    shopId: SHOP,
    storeName: "Peak & Pine",
    palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
    logoUrl: null,
    voiceTagline: null,
    vibe: "minimal",
  });
  settingsMock.saveStoreSettings.mockResolvedValue(undefined);
});

describe("assignArm", () => {
  it("is deterministic for the same visitor and experiment", () => {
    const a = assignArm("visitor-1", EXP_ID);
    expect(assignArm("visitor-1", EXP_ID)).toBe(a);
  });

  it("splits a visitor population roughly 50/50", () => {
    let aCount = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      if (assignArm(`visitor-${i}-${i * 31}`, EXP_ID) === "a") aCount++;
    }
    expect(aCount / n).toBeGreaterThan(0.4);
    expect(aCount / n).toBeLessThan(0.6);
  });

  it("reshuffles assignments for a new experiment", () => {
    let flipped = 0;
    for (let i = 0; i < 200; i++) {
      const v = `visitor-${i}`;
      if (assignArm(v, EXP_ID) !== assignArm(v, "33333333-3333-3333-3333-333333333333")) flipped++;
    }
    expect(flipped).toBeGreaterThan(0);
  });
});

describe("getRunningExperiment", () => {
  it("returns null for non-uuid (demo) shops without touching the DB", async () => {
    expect(await getRunningExperiment("demo-shop")).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("shapes the running row and serves repeats from the 60s cache", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: {
        id: EXP_ID,
        name: "Sharper headline",
        why: "why",
        started_at: "2026-07-05T00:00:00Z",
        variant_doc: HOME_DOC,
        variant_settings: { vibe: "bold" },
      },
    });
    const first = await getRunningExperiment(SHOP);
    expect(first).toMatchObject({
      id: EXP_ID,
      pageKey: "home",
      variantSettings: { vibe: "bold" },
    });
    const second = await getRunningExperiment(SHOP);
    expect(second).toEqual(first);
    expect(fromMock.mock.calls.filter((c) => c[0] === "store_experiment")).toHaveLength(1);
  });
});

describe("startExperiment", () => {
  it("rejects demo shops with a clean 422", async () => {
    await expect(startExperiment("demo-shop", { kind: "headline" })).rejects.toMatchObject({
      status: 422,
      code: "demo_shop",
    });
  });

  it("409s when an experiment is already running", async () => {
    queue("store_experiment:select.maybeSingle", { data: { id: EXP_ID } });
    await expect(startExperiment(SHOP, { kind: "headline" })).rejects.toMatchObject({
      status: 409,
      code: "experiment_running",
    });
  });

  it("422s when nothing is published to test against", async () => {
    await expect(startExperiment(SHOP, { kind: "headline" })).rejects.toMatchObject({
      status: 422,
      code: "nothing_published",
    });
  });

  it("builds a headline challenger from the top product and store name", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    catalogMock.listProducts.mockResolvedValue([{ id: "p1", title: "Alpine Mug", variants: [], images: [] }]);
    queue("store_experiment:insert.single", {
      data: {
        id: EXP_ID,
        name: "Sharper headline",
        why: "w",
        state: "running",
        started_at: "2026-07-05T00:00:00Z",
        decided_at: null,
      },
    });
    const exp = await startExperiment(SHOP, { kind: "headline" });
    expect(exp.state).toBe("running");
    const insert = calls.find((c) => c.table === "store_experiment" && c.verb === "insert");
    const payload = insert?.payload as {
      variant_doc: typeof HOME_DOC;
      variant_settings: unknown;
      page_key: string;
    };
    expect(payload.page_key).toBe("home");
    expect(payload.variant_settings).toBeNull();
    expect(payload.variant_doc.blocks[0].props.headline).toBe("Start with Alpine Mug");
    expect(payload.variant_doc.blocks[0].props.subhead).toContain("Peak & Pine");
    // The champion doc is untouched — the challenger is a patched clone.
    expect(HOME_DOC.blocks[0].props.headline).toBe("Welcome");
  });

  it("builds a vibe challenger from the next vibe in the rotation", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    queue("store_experiment:insert.single", {
      data: {
        id: EXP_ID,
        name: "Try the bold look",
        why: "w",
        state: "running",
        started_at: "2026-07-05T00:00:00Z",
        decided_at: null,
      },
    });
    await startExperiment(SHOP, { kind: "vibe" });
    const insert = calls.find((c) => c.table === "store_experiment" && c.verb === "insert");
    const payload = insert?.payload as { variant_doc: unknown; variant_settings: unknown };
    expect(payload.variant_settings).toEqual({ vibe: "bold" });
    expect(payload.variant_doc).toEqual(HOME_DOC);
  });

  it("maps the one-running unique-index race (23505) to a 409", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    queue("store_experiment:insert.single", { error: { code: "23505", message: "duplicate" } });
    await expect(startExperiment(SHOP, { kind: "headline" })).rejects.toMatchObject({
      status: 409,
      code: "experiment_running",
    });
  });
});

describe("experimentReport", () => {
  const experiment = { id: EXP_ID, startedAt: "2026-07-01T00:00:00Z" };

  it("returns an empty report for non-uuid shops", async () => {
    const report = await experimentReport("demo-shop", experiment);
    expect(report).toEqual({
      aSessions: 0,
      bSessions: 0,
      aConversions: 0,
      bConversions: 0,
      lift: null,
      confidence: null,
    });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("counts distinct sessions per arm and withholds confidence under 30 sessions/arm", async () => {
    const events = [
      // s1 seen twice — distinct-session math must count it once.
      { session_id: "s1", variant_key: "a", type: "page_view" },
      { session_id: "s1", variant_key: "a", type: "page_view" },
      { session_id: "s2", variant_key: "a", type: "page_view" },
      { session_id: "s3", variant_key: "b", type: "page_view" },
      { session_id: "s3", variant_key: "b", type: "checkout_complete" },
    ];
    queue("storefront_event:range", { data: events });
    queue("orders:range", {
      data: [
        { id: "o1", attribution: { experiment_id: EXP_ID, variant_key: "a", live_session_id: "s1" } },
      ],
    });
    const report = await experimentReport(SHOP, experiment);
    expect(report.aSessions).toBe(2);
    expect(report.bSessions).toBe(1);
    expect(report.aConversions).toBe(1);
    expect(report.bConversions).toBe(1);
    expect(report.confidence).toBeNull();
  });

  it("unions the order stamp with checkout_complete sessions without double counting", async () => {
    queue("storefront_event:range", {
      data: [
        { session_id: "s1", variant_key: "b", type: "page_view" },
        { session_id: "s1", variant_key: "b", type: "checkout_complete" },
      ],
    });
    queue("orders:range", {
      data: [
        { id: "o1", attribution: { experiment_id: EXP_ID, variant_key: "b", live_session_id: "s1" } },
      ],
    });
    const report = await experimentReport(SHOP, experiment);
    expect(report.bConversions).toBe(1);
  });

  it("reports high confidence and lift for a decisive winner at scale", async () => {
    const events: Array<{ session_id: string; variant_key: string; type: string }> = [];
    const orders: Array<{ id: string; attribution: Record<string, unknown> }> = [];
    for (let i = 0; i < 500; i++) {
      events.push({ session_id: `a-${i}`, variant_key: "a", type: "page_view" });
      events.push({ session_id: `b-${i}`, variant_key: "b", type: "page_view" });
    }
    for (let i = 0; i < 25; i++) {
      orders.push({ id: `oa-${i}`, attribution: { variant_key: "a", live_session_id: `a-${i}` } });
    }
    for (let i = 0; i < 50; i++) {
      orders.push({ id: `ob-${i}`, attribution: { variant_key: "b", live_session_id: `b-${i}` } });
    }
    queue("storefront_event:range", { data: events });
    queue("orders:range", { data: orders });
    const report = await experimentReport(SHOP, experiment);
    expect(report.aSessions).toBe(500);
    expect(report.bSessions).toBe(500);
    expect(report.lift).toBeCloseTo(1, 5);
    expect(report.confidence).toBeGreaterThanOrEqual(95);
    expect(report.confidence).toBeLessThanOrEqual(99);
  });

  it("clamps sessions to conversions (trimmed exposure rows) instead of yielding NaN confidence", async () => {
    // Arm A's page_view rows were trimmed by the event-retention sweep, but 50
    // stamped orders survive; arm B's exposure is intact.
    const events: Array<{ session_id: string; variant_key: string; type: string }> = [];
    for (let i = 0; i < 50; i++) {
      events.push({ session_id: `b-${i}`, variant_key: "b", type: "page_view" });
    }
    const orders: Array<{ id: string; attribution: Record<string, unknown> }> = [];
    for (let i = 0; i < 50; i++) {
      orders.push({ id: `oa-${i}`, attribution: { variant_key: "a", live_session_id: `a-${i}` } });
    }
    orders.push({ id: "ob-0", attribution: { variant_key: "b", live_session_id: "b-0" } });
    queue("storefront_event:range", { data: events });
    queue("orders:range", { data: orders });
    const report = await experimentReport(SHOP, experiment);
    expect(report.aSessions).toBe(50); // clamped up from 0 so rA <= 1
    expect(report.aConversions).toBe(50);
    expect(report.confidence).not.toBeNull();
    expect(Number.isNaN(report.confidence)).toBe(false);
    expect(Number.isNaN(report.lift)).toBe(false);
  });
});

describe("decideExperiment", () => {
  const runningRow = {
    id: EXP_ID,
    name: "Sharper headline",
    why: "w",
    state: "running",
    started_at: "2026-07-01T00:00:00Z",
    decided_at: null,
    variant_doc: HOME_DOC,
    variant_settings: null,
  };

  it("rejects demo shops with a clean 422", async () => {
    await expect(decideExperiment("demo-shop", EXP_ID, "keep")).rejects.toMatchObject({
      status: 422,
      code: "demo_shop",
    });
  });

  it("404s when the experiment does not exist for this shop", async () => {
    await expect(decideExperiment(SHOP, EXP_ID, "keep")).rejects.toMatchObject({
      status: 404,
      code: "experiment_not_found",
    });
  });

  it("409s when the experiment was already decided", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: { ...runningRow, state: "decided_keep" },
    });
    await expect(decideExperiment(SHOP, EXP_ID, "ship")).rejects.toMatchObject({
      status: 409,
      code: "experiment_not_running",
    });
  });

  it("409s when a racing decide wins the guarded state flip", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [] });
    await expect(decideExperiment(SHOP, EXP_ID, "keep")).rejects.toMatchObject({
      status: 409,
      code: "experiment_not_running",
    });
  });

  it("keep flips state only, applying nothing", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    const exp = await decideExperiment(SHOP, EXP_ID, "keep");
    expect(exp.state).toBe("decided_keep");
    expect(exp.decidedAt).not.toBeNull();
    expect(pageDoc.saveDraft).not.toHaveBeenCalled();
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
    expect(settingsMock.saveStoreSettings).not.toHaveBeenCalled();
  });

  it("ship publishes a headline challenger through validate + saveDraft + publishDoc", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    const exp = await decideExperiment(SHOP, EXP_ID, "ship");
    expect(exp.state).toBe("decided_ship");
    expect(pageDoc.saveDraft).toHaveBeenCalledWith(
      SHOP,
      "home",
      expect.objectContaining({
        blocks: expect.arrayContaining([expect.objectContaining({ type: "hero" })]),
      }),
    );
    expect(pageDoc.publishDoc).toHaveBeenCalledWith(SHOP, "home");
  });

  it("ship applies a vibe challenger through the StoreSettings contract instead of publishing", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: { ...runningRow, variant_settings: { vibe: "warm" } },
    });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    await decideExperiment(SHOP, EXP_ID, "ship");
    expect(settingsMock.saveStoreSettings).toHaveBeenCalledWith(
      SHOP,
      expect.objectContaining({ storeName: "Peak & Pine", vibe: "warm" }),
    );
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("reverts the row to running when the ship apply fails, so ship can be retried", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] }); // guarded flip wins
    queue("store_experiment:update", { data: [{ id: EXP_ID }] }); // compensating revert
    pageDoc.publishDoc.mockRejectedValue(new Error("publish blew up"));
    await expect(decideExperiment(SHOP, EXP_ID, "ship")).rejects.toThrow("publish blew up");
    const updates = calls.filter((c) => c.table === "store_experiment" && c.verb === "update");
    expect(updates).toHaveLength(2);
    expect(updates[1].payload).toMatchObject({ state: "running", decided_at: null });
  });
});

describe("latestStudioExperiment", () => {
  it("returns null for non-uuid shops and for shops that never ran one", async () => {
    expect(await latestStudioExperiment("demo-shop")).toBeNull();
    expect(await latestStudioExperiment(SHOP)).toBeNull();
  });

  it("shapes the newest row and attaches a fresh report", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: {
        id: EXP_ID,
        name: "Sharper headline",
        why: "w",
        state: "decided_keep",
        started_at: "2026-07-01T00:00:00Z",
        decided_at: "2026-07-04T00:00:00Z",
      },
    });
    const exp = await latestStudioExperiment(SHOP);
    expect(exp).toMatchObject({ id: EXP_ID, state: "decided_keep", pageKey: "home" });
    expect(exp?.report).toEqual({
      aSessions: 0,
      bSessions: 0,
      aConversions: 0,
      bConversions: 0,
      lift: null,
      confidence: null,
    });
  });
});

describe("report cache", () => {
  const decidedRow = {
    id: EXP_ID,
    name: "Sharper headline",
    why: "w",
    state: "decided_keep",
    started_at: "2026-07-01T00:00:00Z",
    decided_at: "2026-07-04T00:00:00Z",
  };
  const runningRow = {
    id: EXP_ID,
    name: "Sharper headline",
    why: "w",
    state: "running",
    started_at: "2026-07-01T00:00:00Z",
    decided_at: null,
    variant_doc: HOME_DOC,
    variant_settings: null,
  };

  it("serves a repeat report read from cache within the TTL, sweeping the DB only once", async () => {
    queue("store_experiment:select.maybeSingle", { data: decidedRow }, { data: decidedRow });
    queue("storefront_event:range", { data: [] });
    queue("orders:range", { data: [] });

    await latestStudioExperiment(SHOP);
    await latestStudioExperiment(SHOP);

    expect(fromMock.mock.calls.filter((c) => c[0] === "storefront_event")).toHaveLength(1);
  });

  it("decide invalidates the shop's cached report so the next read sweeps the DB again", async () => {
    queue("store_experiment:select.maybeSingle", { data: decidedRow }, { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    queue("storefront_event:range", { data: [] }, { data: [] });
    queue("orders:range", { data: [] }, { data: [] });

    await latestStudioExperiment(SHOP); // primes the report cache (sweep 1)
    await decideExperiment(SHOP, EXP_ID, "keep"); // invalidates, then re-sweeps for its own report (sweep 2)

    expect(fromMock.mock.calls.filter((c) => c[0] === "storefront_event")).toHaveLength(2);
  });
});
