// app/lib/experiments/store-experiment.server.ts
// One-at-a-time A/B experiments for the owned storefront (spec
// 2026-07-05-store-studio-v2-design.md D4; extended 2026-07-09 to product-page
// tests + an AI-generated challenger). The champion stays in
// page_document.published_json; the challenger doc and optional settings
// overrides live on the store_experiment row. Server-only: service-role
// client, shop_id threaded on every query. Non-uuid (demo) shops: reads
// return null, writes refuse with a clean 422.
import { getSupabase } from "~/lib/supabase.server";
import { CalderynError } from "~/lib/calderyn.server";
import { isUuid } from "~/lib/ids";
import { peekVisitorId } from "~/lib/storefront/visitor-cookie.server";
import { readPaged } from "~/lib/db/read-paged.server";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { getStoreSettings } from "~/lib/storefront/settings.server";
import { loadPublishedDoc } from "~/lib/storebuilder/page-document.server";
import { sanitizeDocHtml } from "~/lib/storebuilder/sanitize-html.server";
import { validateDocument, type ValidIds } from "~/lib/storebuilder/validate";
import { generateChallengerHome } from "~/lib/storegen/generate.server";
import type { Block, BlockDocument } from "~/lib/storebuilder/types";
import type {
  StudioExperiment,
  StudioExperimentPage,
  StudioExperimentReport,
  StudioExperimentState,
  StudioVibe,
} from "~/lib/storebuilder/studio-types";

export type StoreExperimentKind = "headline" | "vibe" | "pdp_copy" | "ai_page";
export type StoreExperimentDecision = "ship" | "keep" | "stop";
export interface StoreExperimentSpec {
  kind: StoreExperimentKind;
  name?: string;
  /** Runs after the cheap refusals (running test, nothing published) but BEFORE any paid model
   *  call — the route wires the daily designer quota here so a refused start never burns a slot
   *  (quota-last invariant, see storegen/guard.server.ts). Only invoked for AI-backed kinds. */
  onBeforeAiCall?: () => Promise<void>;
}

/** The page a challenger tests against. pdp_copy runs on the PDP template;
 *  every other kind tests the home page. */
export function experimentPageKey(kind: StoreExperimentKind): StudioExperimentPage {
  return kind === "pdp_copy" ? "pdp" : "home";
}

/** What the storefront serving path needs per request: the challenger doc and
 *  any settings overrides for arm B. */
export interface RunningExperiment {
  id: string;
  pageKey: StudioExperimentPage;
  name: string;
  why: string;
  startedAt: string;
  variantDoc: BlockDocument;
  variantSettings: { vibe?: StudioVibe } | null;
}

const VIBES: StudioVibe[] = ["minimal", "bold", "warm"];

// Stable id for the pdp_copy challenger's injected trust line — used to strip a previously
// shipped copy before building a new challenger, so repeat tests never stack duplicates.
const REASSURANCE_BLOCK_ID = "pdp-experiment-reassurance";

// Copy bounds mirror the generator's COPY_BOUNDS (storegen/sanitize.ts) so a
// templated challenger can never exceed what a generated doc may hold.
const HEADLINE_MAX = 120;
const SUBHEAD_MAX = 200;

// Report reads use the shared readPaged pager (app/lib/db/read-paged.server.ts):
// PostgREST clamps every response at 1000 rows regardless of .limit(), so
// window reads page with .range() up to an explicit cap and degrade to a
// floor with a warn.
const EVENT_ROW_CAP = 50_000;
const ORDER_ROW_CAP = 10_000;
const MIN_SESSIONS_PER_ARM = 30;
// An undecided experiment blocks publish/generate, so it cannot run forever:
// past this age the next studio/publish/generate touch auto-decides it (ship
// only a confident winner, otherwise keep the champion).
const DEFAULT_EXPERIMENT_MAX_DAYS = 14;
const DAY_MS = 86_400_000;

function experimentMaxDays(): number {
  const raw = Number(process.env.STORE_EXPERIMENT_MAX_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPERIMENT_MAX_DAYS;
}
// Every order state where the sale happened (order/state.ts vocabulary): a
// partial refund must not make a conversion vanish while a full refund keeps
// counting.
const SALE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"] as const;

// ---------------------------------------------------------------------------
// Arm assignment — deterministic, no cookie, no table.

/**
 * 50/50 arm assignment from a stable hash of (visitorId, experimentId): the
 * same visitor always sees the same arm for a given experiment, and a new
 * experiment reshuffles. FNV-1a with an xor-fold so the decision bit mixes
 * the whole hash, not just the last character.
 *
 * FROZEN: do not touch this hash. It must stay bit-identical forever — any
 * change reshuffles every visitor already bucketed into a live experiment.
 */
export function assignArm(visitorId: string, experimentId: string): "a" | "b" {
  const key = `${visitorId}:${experimentId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h >>>= 0;
  return (((h >>> 16) ^ h) & 1) === 0 ? "a" : "b";
}

// ---------------------------------------------------------------------------
// Serving-time participation — ONE definition of which surfaces an experiment
// treats and how a request buckets, shared by every storefront surface so the
// exposure denominator, the served variant and the checkout attribution can
// never drift apart.

/** Storefront surfaces that resolve an experiment per request. "layout" is the
 *  shell around every page (vibe restyles land there); "checkout" stamps
 *  attribution regardless of which page the experiment tests. */
export type ExperimentSurface = "home" | "pdp" | "collection" | "layout" | "checkout";

/** Whether a running experiment treats (and must be measured on) a surface. A
 *  vibe override restyles the whole site, so every surface participates; a doc
 *  experiment participates only on its own page. Checkout always participates —
 *  a conversion belongs to the buyer's arm no matter where the test runs. */
export function experimentTreatsSurface(exp: RunningExperiment, surface: ExperimentSurface): boolean {
  if (surface === "checkout") return true;
  if (exp.variantSettings?.vibe) return true;
  return exp.pageKey === surface;
}

export interface ServedExperiment {
  /** Non-null only when a running experiment treats this surface AND the request
   *  carried a visitor cookie to bucket on. */
  experiment: RunningExperiment | null;
  experimentId: string | null;
  variantKey: "a" | "b" | null;
}

const NOT_SERVED: ServedExperiment = { experiment: null, experimentId: null, variantKey: null };

/**
 * Resolve the experiment exposure for one storefront request. Bucketing keys
 * off the COOKIE visitor id only (peekVisitorId): a first-ever visit has no
 * cookie yet, sees the champion unstamped, and buckets deterministically from
 * its next request — bucketing off a freshly minted id would let one surface
 * style arm A while another records arm-B exposure. Failure-isolated: any
 * lookup hiccup degrades to "no test running" and never breaks a buyer render.
 */
export async function resolveServedExperiment(
  shopId: string,
  request: Request,
  surface: ExperimentSurface,
): Promise<ServedExperiment> {
  try {
    const experiment = await getRunningExperiment(shopId);
    if (!experiment || !experimentTreatsSurface(experiment, surface)) return NOT_SERVED;
    const visitorId = await peekVisitorId(request);
    if (!visitorId) return NOT_SERVED;
    const variantKey = assignArm(visitorId, experiment.id);
    return { experiment, experimentId: experiment.id, variantKey };
  } catch (err) {
    console.error(`[store-experiment] ${surface} exposure lookup failed for shop ${shopId} (serving the champion):`, err);
    return NOT_SERVED;
  }
}

// ---------------------------------------------------------------------------
// Running-experiment lookup — the per-request storefront hot path.

// Short-TTL cache for hits AND misses, mirroring the slug cache in
// storefront/shop.server.ts: entries expire so a start/decide on another
// instance is visible within a minute, and the size cap bounds the map.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;
const runningCache = new Map<string, { exp: RunningExperiment | null; expiresAt: number }>();

// Short-TTL cache for computed reports, same shape as the running-experiment
// cache above: a report sweep reads two full event/order windows, so a busy
// studio screen polling the same running experiment must not re-sweep on
// every request. Keyed shopId:experimentId so one shop's start/decide never
// stales another's.
const REPORT_CACHE_TTL_MS = 30_000;
const REPORT_CACHE_MAX_ENTRIES = 500;
const reportCache = new Map<string, { report: StudioExperimentReport; expiresAt: number }>();

function reportCacheKey(shopId: string, experimentId: string): string {
  return `${shopId}:${experimentId}`;
}

/** Drop every cached report for this shop (start/decide hooks: the report a
 *  caller sees right after either must reflect the new state, not a stale
 *  pre-change sweep). */
function invalidateReportCache(shopId: string): void {
  const prefix = `${shopId}:`;
  for (const key of reportCache.keys()) {
    if (key.startsWith(prefix)) reportCache.delete(key);
  }
}

/** Drop every cached running-experiment resolution (start/decide hooks, tests). */
export function clearStoreExperimentCache(): void {
  runningCache.clear();
  reportCache.clear();
}

export async function getRunningExperiment(shopId: string): Promise<RunningExperiment | null> {
  if (!isUuid(shopId)) return null;

  const cached = runningCache.get(shopId);
  if (cached && cached.expiresAt > Date.now()) return cached.exp;

  const { data, error } = await getSupabase()
    .from("store_experiment")
    .select("id, page_key, name, why, started_at, variant_doc, variant_settings")
    .eq("shop_id", shopId)
    .eq("state", "running")
    .maybeSingle();
  if (error) throw error;
  const exp: RunningExperiment | null = data
    ? {
        id: String(data.id),
        pageKey: shapePageKey(data.page_key),
        name: String(data.name),
        why: String(data.why ?? ""),
        startedAt: String(data.started_at),
        variantDoc: data.variant_doc as BlockDocument,
        variantSettings: shapeVariantSettings(data.variant_settings),
      }
    : null;

  if (runningCache.size >= CACHE_MAX_ENTRIES) {
    // FIFO-evict the oldest entry (Map preserves insertion order).
    const oldest = runningCache.keys().next().value;
    if (oldest !== undefined) runningCache.delete(oldest);
  }
  runningCache.set(shopId, { exp, expiresAt: Date.now() + CACHE_TTL_MS });

  return exp;
}

/**
 * Auto-decide a running experiment that has outlived the max duration
 * (EXPERIMENT_MAX_DAYS, env STORE_EXPERIMENT_MAX_DAYS): an undecided test
 * blocks publish and generate, so it must not be able to block them forever.
 * Ship only when the report shows a confident WIN (confidence >= 95 and
 * rateB > rateA); anything else keeps the champion. Lazy — invoked from the
 * studio read and the write guards rather than a cron — and failure-isolated:
 * a sweep error logs and returns, it never breaks the caller.
 */
export async function expireOverdueExperiment(shopId: string): Promise<void> {
  try {
    if (!isUuid(shopId)) return;
    // Direct (uncached) read: a stale 60s cache entry must not delay or
    // double-fire an expiry.
    const { data, error } = await getSupabase()
      .from("store_experiment")
      .select("id, started_at")
      .eq("shop_id", shopId)
      .eq("state", "running")
      .maybeSingle();
    if (error) throw error;
    if (!data) return;
    const startedAtMs = Date.parse(String(data.started_at));
    if (!Number.isFinite(startedAtMs)) return;
    if (Date.now() - startedAtMs < experimentMaxDays() * DAY_MS) return;

    const id = String(data.id);
    const report = await experimentReport(shopId, { id, startedAt: String(data.started_at) });
    const rA = report.aSessions > 0 ? report.aConversions / report.aSessions : 0;
    const rB = report.bSessions > 0 ? report.bConversions / report.bSessions : 0;
    const winner = report.confidence != null && report.confidence >= 95 && rB > rA;
    try {
      await decideExperiment(shopId, id, winner ? "ship" : "keep");
    } catch (err) {
      // decideExperiment re-reads the report inside its ship guard; if the
      // picture shifted to a confident loss between the two sweeps, fall back
      // to keeping the champion instead of leaving the test undecided.
      if (winner && err instanceof CalderynError && err.code === "variant_losing") {
        await decideExperiment(shopId, id, "keep");
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error(`[store-experiment] overdue-experiment sweep failed for shop ${shopId} (continuing):`, err);
  }
}

/** The running or most recent experiment as the studio DTO, with a fresh
 *  report attached (report failures degrade to null rather than failing the
 *  studio load — same posture as checkoutReady). */
export async function latestStudioExperiment(shopId: string): Promise<StudioExperiment | null> {
  if (!isUuid(shopId)) return null;
  // A test past its max duration decides itself here, so the studio shows the
  // decided state instead of a stale "running" pill.
  await expireOverdueExperiment(shopId);
  const { data, error } = await getSupabase()
    .from("store_experiment")
    .select("id, page_key, name, why, state, started_at, decided_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const exp = shapeStudioExperiment(data);
  exp.report = await reportOrNull(shopId, exp);
  return exp;
}

/**
 * Direct (uncached) check for write-path guards. Publishing or regenerating
 * mid-test would change arm A under the experiment — and a later "ship" would
 * overwrite that newer work with the frozen challenger clone — so publish and
 * generate refuse while a test is running. Non-uuid (demo) shops never have
 * rows and read as false.
 */
export async function hasRunningExperiment(shopId: string): Promise<boolean> {
  if (!isUuid(shopId)) return false;
  const { data, error } = await getSupabase()
    .from("store_experiment")
    .select("id")
    .eq("shop_id", shopId)
    .eq("state", "running")
    .maybeSingle();
  if (error) throw error;
  return data != null;
}

// ---------------------------------------------------------------------------
// Start — deterministic challenger library, never fake-AI.

export async function startExperiment(
  shopId: string,
  spec: StoreExperimentSpec,
): Promise<StudioExperiment> {
  if (!isUuid(shopId)) {
    throw new CalderynError({
      code: "demo_shop",
      status: 422,
      message: "This demo store can't run experiments.",
    });
  }
  const sb = getSupabase();

  // Direct read (not the 60s cache): a stale cache entry must not block or
  // permit a start — the partial unique index below is the true arbiter.
  if (await hasRunningExperiment(shopId)) {
    throw new CalderynError({
      code: "experiment_running",
      status: 409,
      message: "An experiment is already running — decide it before starting another.",
    });
  }

  const pageKey = experimentPageKey(spec.kind);
  const published = await loadPublishedDoc(shopId, pageKey);
  if (!published) {
    throw new CalderynError({
      code: "nothing_published",
      status: 422,
      message: "Publish your store before starting an experiment.",
    });
  }

  // Quota-last: the cheap refusals above ran; consume the designer allowance only when the
  // paid challenger generation is actually about to happen.
  if (spec.kind === "ai_page" && spec.onBeforeAiCall) await spec.onBeforeAiCall();

  const challenger = await buildChallenger(shopId, spec.kind, published);
  const name = spec.name?.trim() || challenger.name;

  const { data, error } = await sb.rpc("start_store_experiment", {
    p_shop_id: shopId,
    p_page_key: pageKey,
    p_name: name,
    p_why: challenger.why,
    // The shared-lock RPC is the commit point. Sanitize before crossing it.
    p_variant_doc: sanitizeDocHtml(challenger.doc),
    p_variant_settings: challenger.settings,
  });
  if (error) {
    // 23505 = the store_experiment_one_running index caught a racing start.
    if ((error as { code?: string }).code === "23505") {
      throw new CalderynError({
        code: "experiment_running",
        status: 409,
        message: "An experiment is already running — decide it before starting another.",
      });
    }
    // 23514 = the page_key check constraint predates migration 20260709160000 (pdp support).
    if ((error as { code?: string }).code === "23514") {
      throw new CalderynError({
        code: "migration_pending",
        status: 503,
        message: "Product-page tests aren't enabled on this database yet. Try again shortly.",
      });
    }
    if (String(error.message).includes("bundle_storefront_active")) {
      throw new CalderynError({
        code: "bundle_storefront_active",
        status: 409,
        message: "Legacy experiments are unavailable after a bundle storefront is installed.",
      });
    }
    throw error;
  }

  runningCache.delete(shopId);
  invalidateReportCache(shopId);
  return shapeStudioExperiment(data);
}

interface Challenger {
  name: string;
  why: string;
  doc: BlockDocument;
  settings: { vibe: StudioVibe } | null;
}

async function buildChallenger(
  shopId: string,
  kind: StoreExperimentKind,
  published: BlockDocument,
): Promise<Challenger> {
  if (kind === "vibe") {
    const current = (await getStoreSettings(shopId)).vibe;
    const next = VIBES[(VIBES.indexOf(current) + 1) % VIBES.length];
    return {
      name: `Try the ${next} look`,
      why: `Tests the ${next} design vibe against your current ${current} look on the home page.`,
      doc: published,
      settings: { vibe: next },
    };
  }

  if (kind === "ai_page") {
    // A full alternative home designed by the same engine that built the champion — a genuinely
    // different composition/copy angle, never a fake or templated "AI" variant. Unreachable or
    // unusable model output refuses the start honestly (503) instead of starting a sham test.
    const doc = await generateChallengerHome(shopId);
    if (!doc) {
      throw new CalderynError({
        code: "ai_unavailable",
        status: 503,
        message: "The design engine couldn't produce a challenger page right now. Try again later.",
      });
    }
    return {
      name: "AI redesign",
      why: "Tests a fresh AI-designed home page — new composition and copy angle, same brand — against your current one.",
      doc,
      settings: null,
    };
  }

  if (kind === "pdp_copy") {
    // Buy-box reassurance on the PDP template: a short trust line directly under Add to cart.
    // Copy states only what is true for every Calderyn store (Stripe checkout; live delivery
    // estimates via the delivery-promise quote) — never invented claims like "free returns".
    // A previously SHIPPED reassurance line is removed first, so re-running the test never
    // stacks two copies (or duplicates the block id).
    const base = published.blocks.filter((b) => b.id !== REASSURANCE_BLOCK_ID);
    const anchor = base.find((b) => b.type === "addToCart");
    if (!anchor) {
      throw new CalderynError({
        code: "no_buy_box",
        status: 422,
        message: "The published product page has no Add to cart section to test against.",
      });
    }
    const reassurance: Block = {
      id: REASSURANCE_BLOCK_ID,
      type: "richText",
      props: {
        html: "Secure checkout, real delivery estimates before you pay, and every order tracked until it arrives.",
      },
      layout: { x: anchor.layout.x, y: anchor.layout.y + anchor.layout.h, w: anchor.layout.w, h: 1 },
    };
    // Shift by GRID position, not array order — block arrays are not guaranteed y-sorted, and a
    // block stored early but positioned below the insertion row must still move down.
    const blocks: Block[] = [
      ...base.map((b) =>
        b !== anchor && b.layout.y >= reassurance.layout.y ? { ...b, layout: { ...b.layout, y: b.layout.y + 1 } } : b,
      ),
      reassurance,
    ];
    return {
      name: "Buy-box reassurance",
      why: "Tests a short trust line under Add to cart on your product pages against the current layout.",
      doc: { ...published, blocks },
      settings: null,
    };
  }

  // headline: clone the published home doc and patch the hero copy with a
  // curated, product-led headline templated from the real catalog nouns.
  const heroIndex = published.blocks.findIndex((b) => b.type === "hero");
  if (heroIndex === -1) {
    throw new CalderynError({
      code: "no_hero_block",
      status: 422,
      message: "The published home page has no hero section to test — try the AI redesign test instead.",
    });
  }
  const [settings, products] = await Promise.all([
    getStoreSettings(shopId),
    getCatalog().listProducts(shopId),
  ]);
  const topProduct = products[0]?.title?.trim();
  const headline = clip(
    topProduct ? `Start with ${topProduct}` : `New season, new picks at ${settings.storeName}`,
    HEADLINE_MAX,
  );
  const subhead = clip(
    topProduct
      ? `The most-loved pick at ${settings.storeName}, ready to ship today.`
      : "Fresh arrivals, fair prices and fast checkout.",
    SUBHEAD_MAX,
  );
  const blocks: Block[] = published.blocks.map((b, i) =>
    i === heroIndex ? { ...b, props: { ...b.props, headline, subhead } } : b,
  );
  return {
    name: "Sharper headline",
    why: "Tests a product-led hero headline against your current copy on the home page.",
    doc: { ...published, blocks },
    settings: null,
  };
}

// ---------------------------------------------------------------------------
// Report — distinct-session math over exposure rows + the order attribution
// stamp, live-analytics style.

export async function experimentReport(
  shopId: string,
  experiment: Pick<StudioExperiment, "id" | "startedAt">,
): Promise<StudioExperimentReport> {
  if (!isUuid(shopId)) return emptyReport();

  const sinceIso = new Date(experiment.startedAt).toISOString();
  const [events, orders] = await Promise.all([
    readExposureEvents(shopId, experiment.id),
    readStampedOrders(shopId, experiment.id, sinceIso),
  ]);

  // Exposure = distinct page_view sessions per arm.
  const sessions = { a: new Set<string>(), b: new Set<string>() };
  // Mid-funnel steps, same distinct-session math as exposure.
  const cartAdds = { a: new Set<string>(), b: new Set<string>() };
  const checkoutStarts = { a: new Set<string>(), b: new Set<string>() };
  // checkout_complete exposure sessions double as the conversion fallback for
  // orders that predate (or lost) the attribution stamp.
  const purchases = { a: new Set<string>(), b: new Set<string>() };
  for (const e of events) {
    const arm = armKey(e.variant_key);
    if (!arm) continue;
    const sid = String(e.session_id);
    if (e.type === "page_view") sessions[arm].add(sid);
    else if (e.type === "cart_add") cartAdds[arm].add(sid);
    else if (e.type === "checkout_start") checkoutStarts[arm].add(sid);
    else if (e.type === "checkout_complete") purchases[arm].add(sid);
  }

  // Authoritative conversions: orders stamped at checkout origination (the
  // paid-flip webhook has no cookies, so the stamp is written up front and
  // survives the 30-day event trim). Orders without a session id still count
  // once each, keyed by order id. Revenue sums each stamped sale-state order's
  // total once per order; the checkout_complete fallback sessions above carry
  // no order total, so they contribute 0 revenue.
  const revenue = { a: 0, b: 0 };
  for (const o of orders) {
    const attr =
      o.attribution && typeof o.attribution === "object"
        ? (o.attribution as Record<string, unknown>)
        : {};
    const arm = armKey(attr.variant_key);
    if (!arm) continue;
    const sid =
      typeof attr.live_session_id === "string" && attr.live_session_id
        ? attr.live_session_id
        : `order:${o.id}`;
    purchases[arm].add(sid);
    revenue[arm] += Number(o.total_cents ?? 0);
  }

  // Conversions can exceed the page_view exposure count: the retention sweep
  // trims storefront_event rows while stamped orders persist, and the checkout
  // stamp covers every assigned visitor even if they never viewed the tested
  // home page. Clamp sessions to at least the conversions so rates stay <= 1
  // and the z-test never takes sqrt of a negative (NaN confidence).
  const aConversions = purchases.a.size;
  const bConversions = purchases.b.size;
  const aSessions = Math.max(sessions.a.size, aConversions);
  const bSessions = Math.max(sessions.b.size, bConversions);

  const rA = aSessions > 0 ? aConversions / aSessions : 0;
  const rB = bSessions > 0 ? bConversions / bSessions : 0;

  return {
    aSessions,
    bSessions,
    aConversions,
    bConversions,
    aRevenueCents: revenue.a,
    bRevenueCents: revenue.b,
    funnel: {
      aCartAdds: cartAdds.a.size,
      bCartAdds: cartAdds.b.size,
      aCheckoutStarts: checkoutStarts.a.size,
      bCheckoutStarts: checkoutStarts.b.size,
    },
    lift: rA > 0 ? (rB - rA) / rA : null,
    confidence: zConfidence(aSessions, aConversions, bSessions, bConversions),
  };
}

function armKey(v: unknown): "a" | "b" | null {
  return v === "a" || v === "b" ? v : null;
}

function emptyReport(): StudioExperimentReport {
  return {
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
}

interface ExposureEventRow {
  session_id: string;
  variant_key: string | null;
  type: string;
}

async function readExposureEvents(shopId: string, experimentId: string): Promise<ExposureEventRow[]> {
  return readPaged<ExposureEventRow>("storefront_event", shopId, EVENT_ROW_CAP, (from, to) =>
    getSupabase()
      .from("storefront_event")
      .select("session_id, variant_key, type")
      .eq("shop_id", shopId)
      .eq("experiment_id", experimentId)
      .order("created_at", { ascending: false })
      // Stable tiebreak so pagination across the PostgREST 1000-row clamp can't
      // skip or double-count rows that share a created_at at a page boundary.
      .order("id", { ascending: true })
      .range(from, to),
  );
}

interface StampedOrderRow {
  id: string;
  attribution: unknown;
  total_cents: number | null;
}

async function readStampedOrders(
  shopId: string,
  experimentId: string,
  sinceIso: string,
): Promise<StampedOrderRow[]> {
  return readPaged<StampedOrderRow>("orders", shopId, ORDER_ROW_CAP, (from, to) =>
    getSupabase()
      .from("orders")
      .select("id, attribution, total_cents")
      .eq("shop_id", shopId)
      .in("state", [...SALE_STATES])
      .gte("created_at", sinceIso)
      .eq("attribution->>experiment_id", experimentId)
      .order("created_at", { ascending: false })
      // Stable tiebreak so pagination across the PostgREST 1000-row clamp can't
      // skip or double-count rows that share a created_at at a page boundary.
      .order("id", { ascending: true })
      .range(from, to),
  );
}

/**
 * Two-proportion z-test confidence as an integer percentage, clamped to 0-99
 * (a report never claims certainty). Null under 30 sessions per arm — too
 * little exposure for the normal approximation to mean anything.
 */
function zConfidence(aS: number, aC: number, bS: number, bC: number): number | null {
  if (aS < MIN_SESSIONS_PER_ARM || bS < MIN_SESSIONS_PER_ARM) return null;
  const pooled = (aC + bC) / (aS + bS);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / aS + 1 / bS));
  if (se === 0) return 0;
  const z = Math.abs(bC / bS - aC / aS) / se;
  const confidence = Math.round((2 * phi(z) - 1) * 100);
  return Math.max(0, Math.min(99, confidence));
}

function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Abramowitz & Stegun 7.1.26 polynomial approximation (|error| < 1.5e-7),
// plenty for a 0-99 integer confidence readout.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// ---------------------------------------------------------------------------
// Decide — guarded state flip, then apply.

export async function decideExperiment(
  shopId: string,
  experimentId: string,
  decision: StoreExperimentDecision,
): Promise<StudioExperiment> {
  if (!isUuid(shopId)) {
    throw new CalderynError({
      code: "demo_shop",
      status: 422,
      message: "This demo store can't run experiments.",
    });
  }
  const sb = getSupabase();

  const { data: row, error } = await sb
    .from("store_experiment")
    .select("id, page_key, name, why, state, started_at, decided_at, variant_doc, variant_settings")
    .eq("shop_id", shopId)
    .eq("id", experimentId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    throw new CalderynError({
      code: "experiment_not_found",
      status: 404,
      message: "No such experiment.",
    });
  }
  if (row.state !== "running") {
    throw new CalderynError({
      code: "experiment_not_running",
      status: 409,
      message: "This experiment has already been decided.",
    });
  }

  if (decision === "ship") {
    // Never publish a statistically proven LOSER: the z-test is two-sided, so high confidence
    // is reached just as easily when B is losing — a bare confidence gate would offer "Ship"
    // on a variant converting at half the champion's rate. Advisory data (low traffic, no
    // confidence) still ships freely; only a confident loss refuses.
    try {
      const report = await experimentReport(shopId, { id: experimentId, startedAt: String(row.started_at) });
      const rA = report.aSessions > 0 ? report.aConversions / report.aSessions : 0;
      const rB = report.bSessions > 0 ? report.bConversions / report.bSessions : 0;
      if (report.confidence != null && report.confidence >= 95 && rB < rA) {
        throw new CalderynError({
          code: "variant_losing",
          status: 422,
          message:
            "This variant is converting significantly WORSE than your current page — shipping it would hurt sales. Keep the current page (or stop the test) instead.",
        });
      }
    } catch (err) {
      if (err instanceof CalderynError) throw err;
      // A report read hiccup must not block a legitimate ship — the guard is best-effort.
      console.error("[store-experiment] pre-ship report read failed; shipping without the loss guard", err);
    }
  }

  const state: StudioExperimentState =
    decision === "ship" ? "decided_ship" : decision === "keep" ? "decided_keep" : "stopped";
  const decidedAt = new Date().toISOString();

  let validatedVariantDoc: BlockDocument | null = null;
  if (decision === "ship" && !shapeVariantSettings(row.variant_settings)?.vibe) {
    const valid = await catalogValidIds(shopId);
    validatedVariantDoc = validateDocument(row.variant_doc as BlockDocument, valid).doc;
  }
  const { data: flipped, error: flipError } = await sb.rpc("transition_store_experiment", {
    p_shop_id: shopId,
    p_experiment_id: experimentId,
    p_state: state,
    p_validated_variant_doc: validatedVariantDoc,
  });
  if (flipError) throw flipError;
  if (!flipped) {
    throw new CalderynError({
      code: "experiment_not_running",
      status: 409,
      message: "This experiment has already been decided.",
    });
  }
  runningCache.delete(shopId);
  invalidateReportCache(shopId);

  const exp = shapeStudioExperiment({ ...row, state, decided_at: decidedAt });
  exp.report = await reportOrNull(shopId, exp);
  return exp;
}

async function catalogValidIds(shopId: string): Promise<ValidIds> {
  const catalog = getCatalog();
  const [products, collections] = await Promise.all([
    catalog.listProducts(shopId),
    catalog.listCollections(shopId),
  ]);
  return {
    productIds: new Set(products.map((p) => p.id)),
    collectionHandles: new Set(collections.map((c) => c.handle)),
  };
}

function shapeVariantSettings(raw: unknown): { vibe?: StudioVibe } | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).vibe;
  return VIBES.includes(v as StudioVibe) ? { vibe: v as StudioVibe } : null;
}

/** Rows written before the pdp extension carry 'home'; anything unexpected reads as home too
 *  (the serving paths treat an unknown page as the safest, original surface). */
function shapePageKey(raw: unknown): StudioExperimentPage {
  return raw === "pdp" ? "pdp" : "home";
}

function shapeStudioExperiment(row: {
  id: unknown;
  page_key?: unknown;
  name: unknown;
  why: unknown;
  state: unknown;
  started_at: unknown;
  decided_at: unknown;
}): StudioExperiment {
  return {
    id: String(row.id),
    name: String(row.name),
    why: String(row.why ?? ""),
    pageKey: shapePageKey(row.page_key),
    state: row.state as StudioExperimentState,
    startedAt: String(row.started_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    report: null,
  };
}

async function reportOrNull(
  shopId: string,
  exp: Pick<StudioExperiment, "id" | "startedAt">,
): Promise<StudioExperimentReport | null> {
  const key = reportCacheKey(shopId, exp.id);
  const cached = reportCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.report;
  try {
    const report = await experimentReport(shopId, exp);
    if (reportCache.size >= REPORT_CACHE_MAX_ENTRIES) {
      // FIFO-evict the oldest entry (Map preserves insertion order).
      const oldest = reportCache.keys().next().value;
      if (oldest !== undefined) reportCache.delete(oldest);
    }
    reportCache.set(key, { report, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
    return report;
  } catch (err) {
    console.error("[store-experiment] report read failed; omitting report", err);
    return null;
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}
