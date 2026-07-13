import { getSupabase } from "~/lib/supabase.server";
import { isFullyEnabledAccount, type ConnectedAccountRow } from "~/lib/payments/connect.server";
import { tenantDomain } from "~/lib/storefront/vercel-domain.server";
import type { MilestoneKey } from "~/lib/dashboard/journey-model";
import { deriveDone, type JourneySignals } from "./journey-derive";

const SALE_STATES = ["paid", "fulfilled", "refunded", "partially_refunded"];
const MARKER_KEYS = ["live_card_dismissed", "recap_dismissed"] as const;

// shops.id is a uuid for real/demo shops provisioned through the normal path;
// showcase fixtures may carry non-uuid ids. Same guard as
// studio.server.ts's shopOrgSlug — a URL nicety must never fail the load.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readSignals(shopId: string): Promise<JourneySignals> {
  const sb = getSupabase();
  const count = (q: PromiseLike<{ count: number | null; error: unknown }>) =>
    q.then(({ count: c, error }) => {
      if (error) throw error;
      return c ?? 0;
    });
  const [products, stripeRow, published, origin, flatRates, carrier, testOrders, realOrders, guardrail, convos] =
    await Promise.all([
      count(sb.from("product_dim").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      sb.from("stripe_connected_account").select("charges_enabled, payouts_enabled, details_submitted").eq("shop_id", shopId).maybeSingle(),
      sb.from("page_document").select("published_json").eq("shop_id", shopId).eq("page_key", "home").maybeSingle(),
      sb.from("shop_origin").select("shop_id").eq("shop_id", shopId).maybeSingle(),
      count(sb.from("ship_flat_rate").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      count(sb.from("ship_carrier_service_registration").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
      count(sb.from("orders").select("id", { count: "exact", head: true }).eq("shop_id", shopId).eq("channel", "test").in("state", SALE_STATES)),
      count(sb.from("orders").select("id", { count: "exact", head: true }).eq("shop_id", shopId).neq("channel", "test").in("state", SALE_STATES)),
      sb.from("guardrail_config").select("autopilot_enabled").eq("shop_id", shopId).maybeSingle(),
      count(sb.from("assistant_conversations").select("id", { count: "exact", head: true }).eq("shop_id", shopId)),
    ]);
  for (const r of [stripeRow, published, origin, guardrail]) {
    if (r.error) throw r.error;
  }
  const stripeData = stripeRow.data as Pick<
    ConnectedAccountRow,
    "charges_enabled" | "payouts_enabled" | "details_submitted"
  > | null;
  const publishedData = published.data as { published_json: unknown } | null;
  const guardrailData = guardrail.data as { autopilot_enabled: boolean } | null;
  return {
    productCount: products,
    payoutsReady: stripeData ? isFullyEnabledAccount(stripeData) : false,
    originSet: origin.data != null,
    rateCount: flatRates + carrier,
    storefrontPublished: publishedData?.published_json != null,
    testOrderCount: testOrders,
    realOrderCount: realOrders,
    autopilotEnabled: Boolean(guardrailData?.autopilot_enabled),
    assistantConvoCount: convos,
  };
}

/** Insert-only materialization: stamps newly-derived milestones, never deletes.
 *  Failures log and return — a broken write must not break the Home read. */
export async function recomputeJourney(shopId: string): Promise<void> {
  try {
    const sb = getSupabase();
    const [signals, existing] = await Promise.all([
      readSignals(shopId),
      sb.from("shop_setup_progress").select("milestone_key").eq("shop_id", shopId),
    ]);
    if (existing.error) throw existing.error;
    const have = new Set((existing.data ?? []).map((r) => r.milestone_key as string));
    const missing = [...deriveDone(signals)].filter((k) => !have.has(k));
    if (!missing.length) return;
    const { error } = await sb
      .from("shop_setup_progress")
      .upsert(missing.map((k) => ({ shop_id: shopId, milestone_key: k })), {
        onConflict: "shop_id,milestone_key",
        ignoreDuplicates: true,
      });
    if (error) throw error;
  } catch (err) {
    console.error("[journey] recompute failed", { shopId, err });
  }
}

export interface JourneyProgress {
  completed: Partial<Record<MilestoneKey, string>>;
  liveCardDismissed: boolean;
  recapDismissed: boolean;
  storefrontUrl: string | null;
}

// shops.org_slug — same fail-soft as studio.server.ts's shopOrgSlug: a
// storefront-URL nicety must never fail the whole journey read.
async function shopOrgSlug(shopId: string): Promise<string | null> {
  if (!UUID_RE.test(shopId)) return null;
  const { data, error } = await getSupabase()
    .from("shops")
    .select("org_slug")
    .eq("id", shopId)
    .maybeSingle();
  if (error) {
    console.error("[journey] org_slug lookup failed", { shopId, error });
    return null;
  }
  const orgSlug = data as { org_slug: unknown } | null;
  return typeof orgSlug?.org_slug === "string" && orgSlug.org_slug ? orgSlug.org_slug : null;
}

export async function getJourneyProgress(shopId: string): Promise<JourneyProgress> {
  await recomputeJourney(shopId);
  const sb = getSupabase();
  const [{ data, error }, orgSlug] = await Promise.all([
    sb.from("shop_setup_progress").select("milestone_key, completed_at").eq("shop_id", shopId),
    shopOrgSlug(shopId),
  ]);
  if (error) throw error;
  const completed: Partial<Record<MilestoneKey, string>> = {};
  let liveCardDismissed = false;
  let recapDismissed = false;
  for (const row of data ?? []) {
    if (row.milestone_key === "live_card_dismissed") liveCardDismissed = true;
    else if (row.milestone_key === "recap_dismissed") recapDismissed = true;
    else completed[row.milestone_key as MilestoneKey] = row.completed_at as string;
  }
  const storefrontUrl =
    orgSlug && process.env.NODE_ENV !== "development"
      ? `https://${tenantDomain(orgSlug)}/storefront`
      : "/storefront";
  return { completed, liveCardDismissed, recapDismissed, storefrontUrl };
}

export async function dismissJourneyCard(
  shopId: string,
  key: (typeof MARKER_KEYS)[number],
): Promise<void> {
  const { error } = await getSupabase()
    .from("shop_setup_progress")
    .upsert([{ shop_id: shopId, milestone_key: key }], {
      onConflict: "shop_id,milestone_key",
      ignoreDuplicates: true,
    });
  if (error) throw error;
}
