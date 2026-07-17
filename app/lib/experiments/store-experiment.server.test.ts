// Deterministic assignment, one-at-a-time start guards, distinct-session
// report math, and guarded decide transitions for store A/B experiments.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { STUDIO_EXPERIMENT_KINDS } from "~/lib/storebuilder/studio-types";
import {
  assignArm,
  clearStoreExperimentCache,
  expireOverdueExperiment,
  getRunningExperiment,
  latestStudioExperiment,
  startExperiment,
  experimentReport,
  decideExperiment,
  resolveServedExperiment,
} from "./store-experiment.server";

// vi.mock is hoisted above the imports by vitest at transform time, so the
// mocks still apply even though they are written below them.
const { fromMock, rpcMock, pageDoc, catalogMock, settingsMock, visitorMock } = vi.hoisted(() => ({
  visitorMock: { peekVisitorId: vi.fn(), ensureVisitorSession: vi.fn() },
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
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

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: fromMock, rpc: rpcMock }) }));
vi.mock("~/lib/storebuilder/page-document.server", () => pageDoc);
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: () => catalogMock }));
vi.mock("~/lib/storefront/settings.server", () => settingsMock);
vi.mock("~/lib/storefront/visitor-cookie.server", () => visitorMock);

const SHOP = "11111111-1111-1111-1111-111111111111";
const EXP_ID = "22222222-2222-2222-2222-222222222222";

it("offers only deterministic challenger kinds", () => {
  expect(STUDIO_EXPERIMENT_KINDS).toEqual(["headline", "vibe", "pdp_copy"]);
});

const EMPTY_REPORT = {
  aSessions: 0,
  bSessions: 0,
  aConversions: 0,
  bConversions: 0,
  aRevenueCents: 0,
  bRevenueCents: 0,
  funnel: { aCartAdds: 0, bCartAdds: 0, aCheckoutStarts: 0, bCheckoutStarts: 0 },
  lift: null,
  confidence: null,
};

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
  delete process.env.STORE_EXPERIMENT_MAX_DAYS;
  resultQueues.clear();
  calls.length = 0;
  fromMock.mockImplementation((table: string) => makeBuilder(table));
  rpcMock.mockImplementation(async (name: string, params: Record<string, unknown>) => {
    if (name === "start_store_experiment") return nextResult("store_experiment:insert.single");
    if (name === "transition_store_experiment") {
      calls.push({ table: "store_experiment", verb: "update", payload: { state: params.p_state } });
      const result = nextResult("store_experiment:update");
      return Array.isArray(result.data) && result.data.length === 0 ? { ...result, data: null } : result;
    }
    return { data: null, error: null };
  });
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
  it("commits the start through the shared-lock transition RPC", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue(HOME_DOC);
    rpcMock.mockResolvedValue({
      data: {
        id: EXP_ID,
        page_key: "home",
        name: "Sharper headline",
        why: "w",
        state: "running",
        started_at: "2026-07-05T00:00:00Z",
        decided_at: null,
      },
      error: null,
    });
    await startExperiment(SHOP, { kind: "headline" });
    expect(rpcMock).toHaveBeenCalledWith("start_store_experiment", expect.objectContaining({
      p_shop_id: SHOP,
      p_variant_doc: expect.objectContaining({ pageKey: "home" }),
    }));
    expect(calls.find((call) => call.table === "store_experiment" && call.verb === "insert")).toBeUndefined();
  });
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
    const payload = rpcMock.mock.calls.find((c) => c[0] === "start_store_experiment")?.[1] as {
      p_variant_doc: typeof HOME_DOC;
      p_variant_settings: unknown;
      p_page_key: string;
    };
    expect(payload.p_page_key).toBe("home");
    expect(payload.p_variant_settings).toBeNull();
    expect(payload.p_variant_doc.blocks[0].props.headline).toBe("Start with Alpine Mug");
    expect(payload.p_variant_doc.blocks[0].props.subhead).toContain("Peak & Pine");
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
    const payload = rpcMock.mock.calls.find((c) => c[0] === "start_store_experiment")?.[1] as {
      p_variant_doc: unknown;
      p_variant_settings: unknown;
    };
    expect(payload.p_variant_settings).toEqual({ vibe: "bold" });
    expect(payload.p_variant_doc).toEqual(HOME_DOC);
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
    expect(report).toEqual(EMPTY_REPORT);
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

  it("sums stamped order revenue per arm and counts funnel steps as distinct sessions", async () => {
    queue("storefront_event:range", {
      data: [
        { session_id: "s1", variant_key: "a", type: "page_view" },
        // s1 adds to cart twice — distinct-session math counts it once.
        { session_id: "s1", variant_key: "a", type: "cart_add" },
        { session_id: "s1", variant_key: "a", type: "cart_add" },
        { session_id: "s1", variant_key: "a", type: "checkout_start" },
        { session_id: "s2", variant_key: "b", type: "page_view" },
        { session_id: "s2", variant_key: "b", type: "cart_add" },
        { session_id: "s3", variant_key: "b", type: "cart_add" },
        // Fallback conversion with no stamped order: counts as a conversion,
        // contributes 0 revenue.
        { session_id: "s2", variant_key: "b", type: "checkout_complete" },
      ],
    });
    queue("orders:range", {
      data: [
        { id: "o1", attribution: { variant_key: "a", live_session_id: "s1" }, total_cents: 2500 },
        // Order-keyed stamp (no session id) still adds its total to the arm.
        { id: "o2", attribution: { variant_key: "a" }, total_cents: 1000 },
        { id: "o3", attribution: { variant_key: null }, total_cents: 9999 },
      ],
    });
    const report = await experimentReport(SHOP, experiment);
    expect(report.aRevenueCents).toBe(3500);
    expect(report.bRevenueCents).toBe(0);
    expect(report.funnel).toEqual({ aCartAdds: 1, bCartAdds: 2, aCheckoutStarts: 1, bCheckoutStarts: 0 });
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

  it("ship passes a validated headline challenger through the atomic transition RPC", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    const exp = await decideExperiment(SHOP, EXP_ID, "ship");
    expect(exp.state).toBe("decided_ship");
    expect(rpcMock).toHaveBeenCalledWith("transition_store_experiment", expect.objectContaining({
      p_shop_id: SHOP,
      p_state: "decided_ship",
      p_validated_variant_doc: expect.objectContaining({
        blocks: expect.arrayContaining([expect.objectContaining({ type: "hero" })]),
      }),
    }));
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("ship applies a vibe challenger inside the atomic transition RPC", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: { ...runningRow, variant_settings: { vibe: "warm" } },
    });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    await decideExperiment(SHOP, EXP_ID, "ship");
    expect(rpcMock).toHaveBeenCalledWith("transition_store_experiment", expect.objectContaining({
      p_state: "decided_ship",
      p_validated_variant_doc: null,
    }));
    expect(settingsMock.saveStoreSettings).not.toHaveBeenCalled();
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("leaves the row running when the atomic transition fails", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { error: new Error("publish blew up") });
    await expect(decideExperiment(SHOP, EXP_ID, "ship")).rejects.toThrow("publish blew up");
    const updates = calls.filter((c) => c.table === "store_experiment" && c.verb === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ state: "decided_ship" });
  });
});

describe("latestStudioExperiment", () => {
  it("returns null for non-uuid shops and for shops that never ran one", async () => {
    expect(await latestStudioExperiment("demo-shop")).toBeNull();
    expect(await latestStudioExperiment(SHOP)).toBeNull();
  });

  it("shapes the newest row and attaches a fresh report", async () => {
    // First maybeSingle read is the overdue-expiry sweep's running-row check.
    queue(
      "store_experiment:select.maybeSingle",
      {},
      {
        data: {
          id: EXP_ID,
          name: "Sharper headline",
          why: "w",
          state: "decided_keep",
          started_at: "2026-07-01T00:00:00Z",
          decided_at: "2026-07-04T00:00:00Z",
        },
      },
    );
    const exp = await latestStudioExperiment(SHOP);
    expect(exp).toMatchObject({ id: EXP_ID, state: "decided_keep", pageKey: "home" });
    expect(exp?.report).toEqual(EMPTY_REPORT);
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
    // Each latestStudioExperiment call reads twice: the expiry sweep's
    // running-row check ({} = nothing running), then the newest-row read.
    queue("store_experiment:select.maybeSingle", {}, { data: decidedRow }, {}, { data: decidedRow });
    queue("storefront_event:range", { data: [] });
    queue("orders:range", { data: [] });

    await latestStudioExperiment(SHOP);
    await latestStudioExperiment(SHOP);

    expect(fromMock.mock.calls.filter((c) => c[0] === "storefront_event")).toHaveLength(1);
  });

  it("decide invalidates the shop's cached report so the next read sweeps the DB again", async () => {
    // {} = the expiry sweep's running-row check finds nothing running.
    queue("store_experiment:select.maybeSingle", {}, { data: decidedRow }, { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    queue("storefront_event:range", { data: [] }, { data: [] });
    queue("orders:range", { data: [] }, { data: [] });

    await latestStudioExperiment(SHOP); // primes the report cache (sweep 1)
    await decideExperiment(SHOP, EXP_ID, "keep"); // invalidates, then re-sweeps for its own report (sweep 2)

    expect(fromMock.mock.calls.filter((c) => c[0] === "storefront_event")).toHaveLength(2);
  });
});

describe("pdp_copy challenger", () => {
  const PDP_DOC = {
    kind: "template",
    pageKey: "pdp",
    blocks: [
      { id: "g", type: "productGallery", layout: { x: 0, y: 0, w: 6, h: 6 }, props: {} },
      { id: "t", type: "productTitle", layout: { x: 6, y: 0, w: 6, h: 1 }, props: {} },
      { id: "p", type: "price", layout: { x: 6, y: 1, w: 6, h: 1 }, props: {} },
      { id: "v", type: "variantPicker", layout: { x: 6, y: 2, w: 6, h: 1 }, props: {} },
      { id: "a", type: "addToCart", layout: { x: 6, y: 3, w: 6, h: 1 }, props: {} },
      { id: "r", type: "richText", layout: { x: 6, y: 4, w: 6, h: 2 }, props: { html: "Existing blurb" } },
    ],
  };
  const insertedRow = {
    id: EXP_ID,
    page_key: "pdp",
    name: "Buy-box reassurance",
    why: "w",
    state: "running",
    started_at: "2026-07-09T00:00:00Z",
    decided_at: null,
  };

  it("pdp_copy clones the published PDP and inserts a reassurance line directly under Add to cart", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue(PDP_DOC);
    queue("store_experiment:insert.single", { data: insertedRow });
    const exp = await startExperiment(SHOP, { kind: "pdp_copy" });
    expect(exp.pageKey).toBe("pdp");
    expect(pageDoc.loadPublishedDoc).toHaveBeenCalledWith(SHOP, "pdp");
    const payload = rpcMock.mock.calls.find((c) => c[0] === "start_store_experiment")?.[1] as { p_page_key: string; p_variant_doc: typeof PDP_DOC };
    expect(payload.p_page_key).toBe("pdp");
    // The reassurance line sits directly under Add to cart ON THE GRID (renderers place by
    // layout, not array order): addToCart ends at y=4, reassurance occupies x:6 y:4.
    const reassurance = payload.p_variant_doc.blocks.find((b) => b.id === "pdp-experiment-reassurance")!;
    expect(reassurance).toMatchObject({ type: "richText", layout: expect.objectContaining({ x: 6, y: 4 }) });
    // Blocks at/below the insertion row are pushed down; nothing overlaps.
    const blurb = payload.p_variant_doc.blocks.find((b) => b.id === "r")!;
    expect(blurb.layout.y).toBe(5);
    // The champion doc is untouched — the challenger is a patched clone.
    expect(PDP_DOC.blocks).toHaveLength(6);
  });

  it("pdp_copy shifts by GRID position (not array order) and strips a previously shipped trust line", async () => {
    // The below-the-fold featureRow is listed FIRST in the array but sits at y:6 — it must
    // still be pushed down. A reassurance block shipped by an earlier test must be replaced,
    // never stacked twice.
    pageDoc.loadPublishedDoc.mockResolvedValue({
      kind: "template",
      pageKey: "pdp",
      blocks: [
        { id: "f", type: "featureRow", layout: { x: 0, y: 6, w: 12, h: 2 }, props: { heading: "Why" } },
        { id: "pdp-experiment-reassurance", type: "richText", layout: { x: 6, y: 4, w: 6, h: 1 }, props: { html: "Old trust line" } },
        { id: "a", type: "addToCart", layout: { x: 6, y: 3, w: 6, h: 1 }, props: {} },
      ],
    });
    queue("store_experiment:insert.single", { data: insertedRow });
    await startExperiment(SHOP, { kind: "pdp_copy" });
    const start = rpcMock.mock.calls.find((c) => c[0] === "start_store_experiment")?.[1] as { p_variant_doc: { blocks: { id: string; layout: { y: number } }[] } };
    const blocks = start.p_variant_doc.blocks;
    expect(blocks.filter((b) => b.id === "pdp-experiment-reassurance")).toHaveLength(1);
    // The early-array featureRow at y:6 moved down despite preceding addToCart in the array.
    expect(blocks.find((b) => b.id === "f")!.layout.y).toBe(7);
  });

  it("pdp_copy 422s when the published PDP has no Add to cart block", async () => {
    pageDoc.loadPublishedDoc.mockResolvedValue({ ...PDP_DOC, blocks: PDP_DOC.blocks.filter((b) => b.type !== "addToCart") });
    await expect(startExperiment(SHOP, { kind: "pdp_copy" })).rejects.toMatchObject({
      status: 422,
      code: "no_buy_box",
    });
  });

});

describe("ship-on-loss guard", () => {
  const runningRow = {
    id: EXP_ID,
    page_key: "home",
    name: "Sharper headline",
    why: "w",
    state: "running",
    started_at: "2026-07-01T00:00:00Z",
    decided_at: null,
    variant_doc: HOME_DOC,
    variant_settings: null,
  };

  function exposureRows(): { session_id: string; variant_key: string; type: string }[] {
    const rows: { session_id: string; variant_key: string; type: string }[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ session_id: `a-${i}`, variant_key: "a", type: "page_view" });
      rows.push({ session_id: `b-${i}`, variant_key: "b", type: "page_view" });
    }
    // Arm A converts at 50%, arm B at ~3% — a statistically certain loss for B.
    for (let i = 0; i < 30; i++) rows.push({ session_id: `a-${i}`, variant_key: "a", type: "checkout_complete" });
    for (let i = 0; i < 2; i++) rows.push({ session_id: `b-${i}`, variant_key: "b", type: "checkout_complete" });
    return rows;
  }

  it("refuses to ship a variant that is losing at high confidence", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("storefront_event:range", { data: exposureRows() });
    queue("orders:range", { data: [] });
    await expect(decideExperiment(SHOP, EXP_ID, "ship")).rejects.toMatchObject({
      status: 422,
      code: "variant_losing",
    });
    // Refused BEFORE the guarded state flip: the experiment is still running and undecided.
    expect(calls.find((c) => c.table === "store_experiment" && c.verb === "update")).toBeUndefined();
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("keep is always allowed on the same losing data", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });
    const exp = await decideExperiment(SHOP, EXP_ID, "keep");
    expect(exp.state).toBe("decided_keep");
  });
});

describe("expireOverdueExperiment (max duration + lazy auto-decide)", () => {
  const OVERDUE_START = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const overdueRow = {
    id: EXP_ID,
    page_key: "home",
    name: "Sharper headline",
    why: "w",
    state: "running",
    started_at: OVERDUE_START,
    decided_at: null,
    variant_doc: HOME_DOC,
    variant_settings: null,
  };

  // 60 page_view sessions per arm plus per-arm checkout_complete conversions:
  // enough exposure for the z-test to reach >= 95% confidence either way.
  function armRows(aConv: number, bConv: number): { session_id: string; variant_key: string; type: string }[] {
    const rows: { session_id: string; variant_key: string; type: string }[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({ session_id: `a-${i}`, variant_key: "a", type: "page_view" });
      rows.push({ session_id: `b-${i}`, variant_key: "b", type: "page_view" });
    }
    for (let i = 0; i < aConv; i++) rows.push({ session_id: `a-${i}`, variant_key: "a", type: "checkout_complete" });
    for (let i = 0; i < bConv; i++) rows.push({ session_id: `b-${i}`, variant_key: "b", type: "checkout_complete" });
    return rows;
  }

  it("ships an overdue confident winner", async () => {
    queue(
      "store_experiment:select.maybeSingle",
      { data: { id: EXP_ID, started_at: OVERDUE_START } }, // expiry's direct running read
      { data: overdueRow }, // decideExperiment's row read
    );
    // Two sweeps: the expiry decision's report, then decideExperiment's ship guard.
    queue("storefront_event:range", { data: armRows(2, 30) }, { data: armRows(2, 30) });
    queue("orders:range", { data: [] }, { data: [] });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });

    await expireOverdueExperiment(SHOP);

    const updates = calls.filter((c) => c.table === "store_experiment" && c.verb === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ state: "decided_ship" });
    expect(rpcMock).toHaveBeenCalledWith("transition_store_experiment", expect.objectContaining({ p_state: "decided_ship" }));
  });

  it("keeps the champion when the overdue variant is not a confident winner", async () => {
    queue(
      "store_experiment:select.maybeSingle",
      { data: { id: EXP_ID, started_at: OVERDUE_START } },
      { data: overdueRow },
    );
    // Confident LOSS for B: keep, decided without the ship guard's second sweep.
    queue("storefront_event:range", { data: armRows(30, 2) });
    queue("orders:range", { data: [] });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });

    await expireOverdueExperiment(SHOP);

    const updates = calls.filter((c) => c.table === "store_experiment" && c.verb === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ state: "decided_keep" });
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("falls back to keep when the ship guard's own sweep refuses the winner (variant_losing)", async () => {
    queue(
      "store_experiment:select.maybeSingle",
      { data: { id: EXP_ID, started_at: OVERDUE_START } },
      { data: overdueRow }, // ship attempt's row read
      { data: overdueRow }, // keep fallback's row read
    );
    // Expiry sweep sees a winner; the guard's re-sweep sees a confident loss.
    queue("storefront_event:range", { data: armRows(2, 30) }, { data: armRows(30, 2) });
    queue("orders:range", { data: [] }, { data: [] });
    queue("store_experiment:update", { data: [{ id: EXP_ID }] });

    await expireOverdueExperiment(SHOP);

    const updates = calls.filter((c) => c.table === "store_experiment" && c.verb === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ state: "decided_keep" });
    expect(pageDoc.publishDoc).not.toHaveBeenCalled();
  });

  it("leaves an experiment inside the max duration untouched", async () => {
    queue("store_experiment:select.maybeSingle", {
      data: { id: EXP_ID, started_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    });
    await expireOverdueExperiment(SHOP);
    expect(calls.find((c) => c.table === "store_experiment" && c.verb === "update")).toBeUndefined();
    expect(fromMock.mock.calls.filter((c) => c[0] === "storefront_event")).toHaveLength(0);
  });

  it("honors STORE_EXPERIMENT_MAX_DAYS from the environment", async () => {
    process.env.STORE_EXPERIMENT_MAX_DAYS = "30";
    queue("store_experiment:select.maybeSingle", { data: { id: EXP_ID, started_at: OVERDUE_START } });
    await expireOverdueExperiment(SHOP);
    expect(calls.find((c) => c.table === "store_experiment" && c.verb === "update")).toBeUndefined();
  });

  it("an expiry failure logs and never breaks latestStudioExperiment", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    queue(
      "store_experiment:select.maybeSingle",
      { error: new Error("supabase down") }, // expiry sweep fails
      {
        data: {
          id: EXP_ID,
          name: "Sharper headline",
          why: "w",
          state: "decided_keep",
          started_at: "2026-07-01T00:00:00Z",
          decided_at: "2026-07-04T00:00:00Z",
        },
      },
    );
    const exp = await latestStudioExperiment(SHOP);
    expect(exp).toMatchObject({ id: EXP_ID, state: "decided_keep" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("resolveServedExperiment (one bucketing rule for every surface)", () => {
  const runningRow = {
    id: EXP_ID,
    page_key: "home",
    name: "n",
    why: "",
    started_at: "2026-07-01T00:00:00Z",
    variant_doc: HOME_DOC,
    variant_settings: null,
  };
  const req = () => new Request("https://shop.example/storefront");

  it("buckets off the cookie id and stamps the treated surface", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    visitorMock.peekVisitorId.mockResolvedValue("vid-1");
    const served = await resolveServedExperiment(SHOP, req(), "home");
    expect(served.experimentId).toBe(EXP_ID);
    expect(served.variantKey).toBe(assignArm("vid-1", EXP_ID));
    expect(served.experiment?.pageKey).toBe("home");
  });

  it("first-ever visit (no cookie): not served, not stamped", async () => {
    queue("store_experiment:select.maybeSingle", { data: runningRow });
    visitorMock.peekVisitorId.mockResolvedValue(null);
    const served = await resolveServedExperiment(SHOP, req(), "home");
    expect(served).toEqual({ experiment: null, experimentId: null, variantKey: null });
  });

  it("a home doc experiment does not treat pdp/collection/layout, but checkout always participates", async () => {
    visitorMock.peekVisitorId.mockResolvedValue("vid-1");
    for (const [surface, expected] of [["pdp", null], ["collection", null], ["layout", null], ["checkout", EXP_ID]] as const) {
      clearStoreExperimentCache();
      queue("store_experiment:select.maybeSingle", { data: runningRow });
      const served = await resolveServedExperiment(SHOP, req(), surface);
      expect(served.experimentId).toBe(expected);
    }
  });

  it("a vibe experiment treats every surface (the layout restyles the whole site)", async () => {
    visitorMock.peekVisitorId.mockResolvedValue("vid-1");
    for (const surface of ["home", "pdp", "collection", "layout", "checkout"] as const) {
      clearStoreExperimentCache();
      queue("store_experiment:select.maybeSingle", { data: { ...runningRow, variant_settings: { vibe: "bold" } } });
      const served = await resolveServedExperiment(SHOP, req(), surface);
      expect(served.experimentId).toBe(EXP_ID);
    }
  });

  it("failure-isolated: a lookup error degrades to not-served, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    queue("store_experiment:select.maybeSingle", { error: new Error("supabase down") });
    visitorMock.peekVisitorId.mockResolvedValue("vid-1");
    const served = await resolveServedExperiment(SHOP, req(), "home");
    expect(served.experimentId).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
