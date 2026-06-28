import { useEffect, useRef, useState } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  FormLayout,
  InlineGrid,
  InlineStack,
  Page,
  Spinner,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { Scorecard } from "~/components/Scorecard";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { isUuid } from "~/lib/ids";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { metaClientForShop } from "~/lib/meta/client.server";
import { listCampaigns } from "~/lib/meta/campaigns.server";
import {
  listCampaignCreatives,
  type CampaignCreative,
} from "~/lib/meta/creatives.server";
import { googleClientForShop } from "~/lib/google/client.server";
import { listGoogleCampaignCreatives } from "~/lib/google/creatives.server";
import {
  listCampaignAdInsights,
  type AdMetrics,
} from "~/lib/meta/ad-insights.server";
import {
  buildCampaignPerformance,
  type CampaignPerformance,
} from "~/lib/ads/campaign-detail.server";
import { resolveCampaignDirection, type CampaignDirection } from "~/lib/actions/direction-reason.server";
import { executeAction } from "~/lib/actions/execute.server";
import { metaDraftPushEnabled } from "~/lib/meta/ad-create.server";
import { parsePushDraftCreative, pushCreativeDraftKey } from "~/lib/actions/push-draft.server";
import type { Direction, DirectionActionKind } from "~/lib/actions/direction.server";
import {
  loadCachedAdScorecards,
  type AdScorecard,
} from "~/lib/screener/campaign-ads.server";
import {
  resolveCampaignScore,
  gradeRowFromPerformance,
} from "~/lib/campaign-score/resolve.server";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
} from "~/lib/screener/types";
import type { ScoreActionPayload } from "./app.campaigns.$campaignId.score";
import type { RegenActionPayload } from "./app.campaigns.$campaignId.regenerate";
import type { ScreenActionPayload } from "./app.campaigns.$campaignId.screen";
import { fmtMoney } from "~/lib/format";
import { scaleReason } from "~/lib/scale-reason";
import type { Campaign } from "~/lib/types";

const DIRECTION_BADGE: Record<Direction, { label: string; tone: "success" | "attention" | "critical" | undefined }> = {
  scale_up: { label: "Scale up", tone: "success" },
  keep: { label: "Keep", tone: undefined },
  scale_down: { label: "Scale down", tone: "attention" },
  pause: { label: "Pause", tone: "critical" },
};

const SCORE_BADGE_TONE: Record<CampaignCalderynScore["band"], "success" | "warning" | "critical" | undefined> = {
  strong: "success",
  fair: "warning",
  weak: "critical",
  nodata: undefined,
};

type ScaleOpportunity = {
  reason: string;
  upsideCents: number; // projected incremental monthly margin (cents)
  currentBudgetCents: number;
  newBudgetCents: number;
  pct: number;
};

type CampaignDetail = {
  /** id to use for actions: dim uuid if ingested, else the platform external id. */
  id: string;
  externalId: string;
  /**
   * Confirmed Meta external id, or null. Set ONLY when idFromUrl is known to be a
   * real Meta external id (external→dim resolve, or live Meta identity match) —
   * NOT for ingested-only rows where v_campaigns_flat.id is not a Meta id. Drives
   * the creative fetch so we never silently show an empty creatives state.
   */
  metaExternalId: string | null;
  name: string;
  platform: Campaign["platform"];
  status: "active" | "paused";
  performance: CampaignPerformance;
};

type LoaderPayload = {
  detail: CampaignDetail | null;
  error: { code: string; message: string } | null;
  creatives: CampaignCreative[];
  creativesError: { code: string; message: string } | null;
  /** Real, live per-ad performance (last 7d) from Meta Insights at the ad level. */
  adMetrics: AdMetrics[];
  adMetricsError: { code: string; message: string } | null;
  /** Cache-only scorecards (no Claude in the loader); uncached ads stream in. */
  scorecards: AdScorecard[];
  /** Clamped spend basis the client passes to the score route per ad. */
  assumedSpendCents: number;
  /** The id this page was loaded under (params.campaignId) — the score route path. */
  campaignIdParam: string;
  /** Open scale opportunity for this campaign (why-to-scale), or null. */
  scale: ScaleOpportunity | null;
  direction: CampaignDirection | null;
  /** Blended Calderyn score for this campaign (full P+C — creatives are loaded). */
  calderynScore: CampaignCalderynScore | null;
  /** Whether the stored Meta token has ads_management scope for the push gate. */
  metaCanPushDrafts: boolean;
};

// The list page sources campaigns two ways (see app.campaigns.tsx): the live
// platform path keys off the platform EXTERNAL id, while ingested rows in
// v_campaigns_flat key off the dim UUID. The detail loader bridges both: try the
// id as a dim uuid first, then resolve an external id → dim uuid, and finally
// fall back to a live Meta lookup for identity-only when no metrics are ingested
// yet (performance marked unavailable rather than faked — rule 12).
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const idFromUrl = String(params.campaignId ?? "");
  const url = new URL(request.url);
  const rawPlatform = url.searchParams.get("platform");
  const platformParam =
    rawPlatform === "Google" ? "Google" : rawPlatform === "TikTok" ? "TikTok" : "Meta";
  const client = calderynClient(session.shop);

  if (!idFromUrl) {
    return json<LoaderPayload>(
      emptyPayload(idFromUrl, { code: "INVALID_REQUEST", message: "Missing campaign id" }),
    );
  }

  try {
    // 1) Ingested perf row, addressed directly by dim uuid. Here idFromUrl is
    // v_campaigns_flat.id, which is NOT guaranteed to be a Meta external id, so
    // confirmedExternalId stays null. v_campaigns_flat.id is a uuid column, so we
    // only attempt the direct lookup when idFromUrl is uuid-shaped — a platform
    // external id (e.g. a long numeric Meta id) would otherwise make Postgres
    // throw 22P02 and abort the resolution chain before steps 2/3 can run.
    let campaign: Campaign | null = isUuid(idFromUrl)
      ? await getOrNull(client, idFromUrl)
      : null;
    let actionId = idFromUrl;
    let confirmedExternalId: string | null = null;

    // 2) Live external id → dim uuid → perf row. idFromUrl resolved as a real
    // external id, so it is a confirmed Meta external id.
    if (!campaign) {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const platform =
        platformParam === "Google" ? "google" : platformParam === "TikTok" ? "tiktok" : "meta";
      const dimId = await resolveCampaignDimId(sb, shopId, platform, idFromUrl);
      if (dimId) {
        campaign = await getOrNull(client, dimId);
        if (campaign) {
          actionId = dimId;
          confirmedExternalId = idFromUrl;
        }
      }
    }

    if (campaign) {
      const detail: CampaignDetail = {
        id: actionId,
        externalId: idFromUrl,
        metaExternalId: confirmedExternalId,
        name: campaign.name,
        platform: campaign.platform,
        status: campaign.status,
        performance: buildCampaignPerformance(campaign),
      };
      return respondForDetail(session.shop, detail, idFromUrl);
    }

    // 3) Identity-only fallback from the live Meta account (no ingested metrics).
    if (platformParam === "Meta") {
      const meta = await metaClientForShop(session.shop);
      if (meta) {
        const owned = (await listCampaigns(meta.client, meta.adAccountId)).find(
          (c) => c.id === idFromUrl,
        );
        if (owned) {
          const detail: CampaignDetail = {
            id: idFromUrl,
            externalId: idFromUrl,
            metaExternalId: idFromUrl,
            name: owned.name,
            platform: "Meta",
            status: owned.status === "PAUSED" ? "paused" : "active",
            performance: buildCampaignPerformance(null),
          };
          return respondForDetail(session.shop, detail, idFromUrl);
        }
      }
    }

    return json<LoaderPayload>(
      emptyPayload(idFromUrl, {
        code: "CAMPAIGN_NOT_FOUND",
        message: `Campaign ${idFromUrl} not found`,
      }),
    );
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>(
      emptyPayload(idFromUrl, { code: e.code ?? "ERROR", message: e.message }),
    );
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  if (String(form.get("intent")) === "push_creative_draft") {
    const campaignId = String(form.get("campaign_id") ?? "");
    if (!campaignId) return json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
    const parsed = parsePushDraftCreative({
      headline: form.get("headline"),
      primaryText: form.get("primaryText"),
      cta: form.get("cta"),
      destinationUrl: form.get("destinationUrl"),
      imageUrl: form.get("imageUrl"),
      audience: form.get("audience"),
    });
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, { status: 400 });
    const shopId = await resolveShopId(session.shop);
    const res = await executeAction(
      shopId,
      {
        alertId: null,
        kind: "push_creative_draft",
        campaignId,
        idempotencyKey: pushCreativeDraftKey(campaignId, parsed.creative),
        creative: parsed.creative,
        actor: "merchant:admin-detail",
      },
      getSupabase(),
    );
    return json({ ok: res.outcome !== "failed", outcome: res.outcome });
  }

  if (String(form.get("intent")) !== "apply_direction") {
    return json({ ok: false, error: "unknown_intent" }, { status: 400 });
  }
  const kind = String(form.get("action_kind")) as DirectionActionKind;
  const allowed: DirectionActionKind[] = ["pause_campaign", "reduce_campaign_budget", "increase_campaign_budget"];
  if (!allowed.includes(kind)) return json({ ok: false, error: "invalid_action_kind" }, { status: 400 });
  const dailyRaw = form.get("daily_budget_cents");
  const dailyBudgetCents = dailyRaw != null && dailyRaw !== "" ? Number(dailyRaw) : undefined;
  if (
    (kind === "reduce_campaign_budget" || kind === "increase_campaign_budget") &&
    (!dailyBudgetCents || !Number.isFinite(dailyBudgetCents) || dailyBudgetCents <= 0)
  ) {
    return json({ ok: false, error: "missing_daily_budget_cents" }, { status: 400 });
  }
  const campaignId = String(form.get("campaign_id") ?? "");
  if (!campaignId) return json({ ok: false, error: "missing_campaign_id" }, { status: 400 });
  const shopId = await resolveShopId(session.shop);
  try {
    const res = await executeAction(
      shopId,
      {
        alertId: null,
        kind,
        campaignId,
        // Include the target budget: the Recommended-direction card and the
        // Scale-opportunity card both POST increase_campaign_budget for this
        // campaign but with DIFFERENT budgets. Without the budget in the key they
        // collide on the same day and the second (distinct) budget silently
        // no-ops via priorExecutionForKey — a phantom success (rule 12). With it,
        // distinct budgets get distinct keys (both apply) while an identical
        // double-submit still dedups.
        idempotencyKey: `direction:${campaignId}:${kind}:${dailyBudgetCents ?? "none"}:${new Date().toISOString().slice(0, 10)}`,
        dailyBudgetCents,
        actor: "merchant:admin-detail",
      },
      getSupabase(),
    );
    return json({ ok: res.outcome !== "failed", outcome: res.outcome });
  } catch (err) {
    console.error(`[campaign-direction] action failed for ${campaignId}`, err);
    return json({ ok: false, error: "not_actionable" }, { status: 409 });
  }
};

/** Best-effort recommended direction for the detail view. calderynClient + alerts +
 *  guardrails feed the shared recommender; any failure yields null (page still renders). */
async function resolveDirectionForDetail(
  shop: string,
  detail: CampaignDetail,
): Promise<CampaignDirection | null> {
  const perf = detail.performance;
  const client = calderynClient(shop);
  const [shopId, openAlerts, guardrails] = await Promise.all([
    resolveShopId(shop),
    client.alerts.list({ status: "open" }).catch(() => []),
    client.guardrails.get().catch(() => null),
  ]);
  return resolveCampaignDirection({
    shopId,
    campaignId: detail.id,
    roas: perf.reportedRoas,
    breakEvenRoas: perf.breakEvenRoas,
    status: detail.status,
    currentBudgetCents: perf.dailyBudgetCents,
    alerts: openAlerts.map((a) => ({ detector_id: a.detector_id, status: a.status, campaign_id: a.campaign_id })),
    guardrails: guardrails ?? {},
    sb: getSupabase(),
  });
}

/** Resolve a detail's creatives + live ad metrics (independent Meta fetches, run
 * in parallel) plus cached scorecards, into the LoaderPayload. Shared by the
 * ingested and live-identity success branches so the post-resolution pipeline
 * lives in one place. */
async function respondForDetail(
  shop: string,
  detail: CampaignDetail,
  campaignIdParam: string,
) {
  const [{ creatives, creativesError }, { adMetrics, adMetricsError }, scale, direction, metaCanPushDrafts] = await Promise.all([
    loadCreatives(shop, detail),
    loadAdMetrics(shop, detail),
    loadScaleOpportunity(shop, detail),
    resolveDirectionForDetail(shop, detail).catch(() => null),
    resolveShopId(shop).then((shopId) => metaDraftPushEnabled(getSupabase(), shopId)).catch(() => false),
  ]);
  const assumedSpendCents = spendBasis(detail.performance);
  const scorecards = await loadCachedScorecards(shop, creatives);
  const gradeRow = gradeRowFromPerformance({
    campaignId: detail.id,
    name: detail.name,
    roas: detail.performance.reportedRoas ?? 0,
    breakEvenRoas: detail.performance.breakEvenRoas ?? 0,
    spendCents: detail.performance.spend7dCents ?? 0,
  });
  const calderynScore = await resolveCampaignScore(
    shop,
    {
      id: detail.id,
      ads: creatives.map((cr) => ({
        adId: cr.adId,
        status: cr.status.toUpperCase() === "PAUSED" ? "paused" : "active",
      })),
    },
    gradeRow,
    // Reuse the scorecards already loaded above — no second cache read (D3).
    { loadCachedAdScorecards: async (_s, ids) => scorecards.filter((sc) => ids.includes(sc.adId)) },
  );
  return json<LoaderPayload>({
    detail,
    error: null,
    creatives,
    creativesError,
    adMetrics,
    adMetricsError,
    scorecards,
    assumedSpendCents,
    campaignIdParam,
    scale,
    direction,
    calderynScore,
    metaCanPushDrafts,
  });
}

/** Empty/error LoaderPayload (no detail) — every non-success return uses this so
 * the full payload shape stays in one place. */
function emptyPayload(
  campaignIdParam: string,
  error: { code: string; message: string } | null,
): LoaderPayload {
  return {
    detail: null,
    error,
    creatives: [],
    creativesError: null,
    adMetrics: [],
    adMetricsError: null,
    scorecards: [],
    assumedSpendCents: DEFAULT_SPEND_CENTS,
    campaignIdParam,
    scale: null,
    direction: null,
    calderynScore: null,
    metaCanPushDrafts: false,
  };
}

/** Open "scale this winner" opportunity for the detail page (the why-to-scale).
 * Advisory: any failure returns null so it never breaks the detail page. Matches
 * the open campaign_scaling_opportunity alert to this campaign by dim id (or the
 * platform external id for a live-only Meta detail). */
async function loadScaleOpportunity(
  shop: string,
  detail: CampaignDetail,
): Promise<ScaleOpportunity | null> {
  try {
    const client = calderynClient(shop);
    const [alerts, gr] = await Promise.all([
      client.alerts.list({ status: "open", detector: "campaign_scaling_opportunity" }),
      client.guardrails.get(),
    ]);
    const a = alerts.find(
      (x) =>
        (x.campaign_id != null && x.campaign_id === detail.id) ||
        (x.campaign_external_id != null && x.campaign_external_id === detail.externalId),
    );
    if (!a) return null;
    const pct = Number(a.evidence?.increase_pct) || gr.autopilot_max_budget_increase_pct || 20;
    const roas = Number(a.evidence?.roas);
    const currentBudgetCents = Math.round((Number(a.evidence?.daily_budget_usd) || 0) * 100);
    return {
      reason: scaleReason(Number.isFinite(roas) ? roas : null, pct, a.dollar_impact),
      upsideCents: a.dollar_impact, // already cents (rowToAlert converts dollars→cents)
      currentBudgetCents,
      newBudgetCents: Math.round(currentBudgetCents * (1 + pct / 100)),
      pct,
    };
  } catch {
    return null;
  }
}

/** Clamp the 7-day spend (or DEFAULT) to [MIN, MAX] — the per-ad score basis. */
function spendBasis(performance: CampaignPerformance): number {
  const raw = performance.spend7dCents ?? DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(raw, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

// Cache-ONLY read of persisted scorecards — NO Claude in the loader, so the page
// paints immediately. Each uncached ad streams its score afterwards via the score
// resource route. Isolated in its own try/catch so a cache-read failure NEVER
// breaks the rest of the detail page (rule 12: on failure return [] and let every
// ad stream, rather than a blank/500).
async function loadCachedScorecards(
  shop: string,
  creatives: CampaignCreative[],
): Promise<AdScorecard[]> {
  if (creatives.length === 0) return [];
  try {
    return await loadCachedAdScorecards(
      shop,
      creatives.map((c) => c.adId),
    );
  } catch {
    return [];
  }
}

// Fetch Meta ad creatives for the detail. Isolated in its own try/catch so a
// creative-fetch failure NEVER breaks the performance card (rule 12: surface the
// gap honestly via creativesError rather than failing the whole loader). Only
// fetches when we hold a CONFIRMED Meta external id — for ingested-only campaigns
// (detail.metaExternalId == null) the URL id is not a Meta id, so we surface an
// explicit gap rather than relying on the Graph API to error (it can return 200
// {data:[]}, which would silently look like "no creatives").
type CreativesResult = {
  creatives: CampaignCreative[];
  creativesError: { code: string; message: string } | null;
};

async function loadCreatives(
  shop: string,
  detail: CampaignDetail,
): Promise<CreativesResult> {
  if (detail.platform === "Meta") return loadMetaCreatives(shop, detail);
  if (detail.platform === "Google") return loadGoogleCreatives(shop, detail);
  return { creatives: [], creativesError: null };
}

async function loadMetaCreatives(
  shop: string,
  detail: CampaignDetail,
): Promise<CreativesResult> {
  if (!detail.metaExternalId) {
    return {
      creatives: [],
      creativesError: {
        code: "CREATIVE_ID_UNAVAILABLE",
        message:
          "Creative preview needs this campaign's live Meta id, which isn't available for ingested-only campaigns yet.",
      },
    };
  }
  try {
    const meta = await metaClientForShop(shop);
    if (!meta) {
      return {
        creatives: [],
        creativesError: { code: "META_NOT_CONNECTED", message: "Meta account not connected" },
      };
    }
    const creatives = await listCampaignCreatives(meta.client, detail.metaExternalId);
    return { creatives, creativesError: null };
  } catch (err) {
    const e = err as CalderynError;
    return {
      creatives: [],
      creativesError: { code: e.code ?? "CREATIVES_ERROR", message: e.message },
    };
  }
}

// Fetch Google ad creatives for the detail. Same isolated-try/catch contract as
// the Meta path (rule 12: surface the gap honestly via creativesError rather than
// failing the whole loader). Unlike Meta, Google has no live-identity confirmation
// step, so the URL id (detail.externalId) IS the campaign id from the ingested/
// list row. NOTE: Google Ads API access is currently broken (token lacks
// permission), so this WILL error today — that's the honest degraded state, not a
// fake-success (rule 12).
async function loadGoogleCreatives(
  shop: string,
  detail: CampaignDetail,
): Promise<CreativesResult> {
  try {
    const shopId = await resolveShopId(shop);
    const conn = await googleClientForShop(shopId);
    if (!conn) {
      return {
        creatives: [],
        creativesError: {
          code: "GOOGLE_NOT_CONNECTED",
          message: "Google Ads account not connected",
        },
      };
    }
    const creatives = await listGoogleCampaignCreatives(conn.client, detail.externalId);
    return { creatives, creativesError: null };
  } catch (err) {
    const e = err as CalderynError;
    return {
      creatives: [],
      creativesError: { code: e.code ?? "CREATIVES_ERROR", message: e.message },
    };
  }
}

// Fetch REAL per-ad performance (last 7d) from Meta Insights at the ad level.
// Isolated in its own try/catch so a metrics-fetch failure NEVER breaks the perf
// card, creatives, or scorecards (rule 12: on failure return [] + an HONEST
// adMetricsError rather than silently empty). Only runs for a CONFIRMED Meta
// external id; for ingested-only campaigns (metaExternalId == null) there is no
// live id to query, so we return [] with no error and each ad row shows
// "— (no data)".
async function loadAdMetrics(
  shop: string,
  detail: CampaignDetail,
): Promise<{ adMetrics: AdMetrics[]; adMetricsError: { code: string; message: string } | null }> {
  if (detail.platform !== "Meta" || !detail.metaExternalId) {
    return { adMetrics: [], adMetricsError: null };
  }
  try {
    const meta = await metaClientForShop(shop);
    if (!meta) {
      return {
        adMetrics: [],
        adMetricsError: { code: "META_NOT_CONNECTED", message: "Meta account not connected" },
      };
    }
    const adMetrics = await listCampaignAdInsights(meta.client, detail.metaExternalId);
    return { adMetrics, adMetricsError: null };
  } catch (err) {
    const e = err as CalderynError;
    return {
      adMetrics: [],
      adMetricsError: { code: e.code ?? "AD_METRICS_ERROR", message: e.message },
    };
  }
}

/** campaigns.get but null (not throw) on CAMPAIGN_NOT_FOUND, rethrow otherwise. */
async function getOrNull(
  client: ReturnType<typeof calderynClient>,
  id: string,
): Promise<Campaign | null> {
  try {
    return await client.campaigns.get(id);
  } catch (err) {
    if ((err as CalderynError).code === "CAMPAIGN_NOT_FOUND") return null;
    throw err;
  }
}

export default function CampaignDetailPage() {
  const navigate = useEmbeddedNavigate();
  const {
    detail,
    error,
    creatives,
    creativesError,
    adMetrics,
    adMetricsError,
    scorecards,
    assumedSpendCents,
    campaignIdParam,
    scale,
    direction,
    calderynScore,
    metaCanPushDrafts,
  } = useLoaderData<typeof loader>();
  const directionFetcher = useFetcher<typeof action>();
  const scaleFetcher = useFetcher<typeof action>();

  if (!detail) {
    return (
      <Page
        title="Campaign"
        backAction={{ content: "Campaigns", onAction: () => navigate("/app/campaigns") }}
      >
        <Banner tone="critical" title="Couldn't load campaign">
          <p>{error?.message ?? "Unknown error."}</p>
        </Banner>
      </Page>
    );
  }

  const perf = detail.performance;
  const scorecardByAd = new Map(scorecards.map((s) => [s.adId, s]));
  const metricsByAd = new Map(adMetrics.map((m) => [m.adId, m]));
  return (
    <Page
      title={detail.name}
      titleMetadata={
        <InlineStack gap="200" blockAlign="center">
          <Badge tone={detail.status === "active" ? "success" : "attention"}>
            {detail.status === "active" ? "Active" : "Paused"}
          </Badge>
          <Badge tone={SCORE_BADGE_TONE[calderynScore?.band ?? "nodata"]}>
            {calderynScore?.value != null ? `Score ${calderynScore.value}` : "Score pending"}
          </Badge>
        </InlineStack>
      }
      subtitle={`${detail.platform} campaign`}
      backAction={{ content: "Campaigns", onAction: () => navigate("/app/campaigns") }}
    >
      <BlockStack gap="400">
        {direction && (() => {
          const badge = DIRECTION_BADGE[direction.direction];
          const directionActable =
            direction.actionKind != null &&
            (direction.actionKind === "pause_campaign" || direction.suggestedBudgetCents != null);
          return (
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">Recommended direction</Text>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </InlineStack>
                <Text as="p">{direction.reason}</Text>
                {directionActable && (
                  <directionFetcher.Form method="post">
                    <input type="hidden" name="intent" value="apply_direction" />
                    <input type="hidden" name="campaign_id" value={detail.id} />
                    <input type="hidden" name="action_kind" value={direction.actionKind!} />
                    {direction.suggestedBudgetCents != null && (
                      <input type="hidden" name="daily_budget_cents" value={String(direction.suggestedBudgetCents)} />
                    )}
                    <Button variant="primary" submit loading={directionFetcher.state !== "idle"}>
                      {badge.label}
                    </Button>
                  </directionFetcher.Form>
                )}
                {directionFetcher.data && (
                  <Banner tone={directionFetcher.data.ok ? "success" : "critical"}>
                    {directionFetcher.data.ok
                      ? "Applied — the change is live and reversible from the Campaigns list."
                      : "Couldn't apply that change. Please try again."}
                  </Banner>
                )}
              </BlockStack>
            </Card>
          );
        })()}
        {scale && (
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Scale opportunity
                </Text>
                <Badge tone="success">Suggested: scale</Badge>
              </InlineStack>
              <Text as="p">{scale.reason}</Text>
              <InlineGrid columns={{ xs: 2, sm: 3 }} gap="400">
                <Stat label="Today's budget" value={fmtMoney(scale.currentBudgetCents)} />
                <Stat label={`Proposed (+${scale.pct}%)`} value={fmtMoney(scale.newBudgetCents)} />
                <Stat label="Projected upside" value={`+${fmtMoney(scale.upsideCents)}/mo`} />
              </InlineGrid>
              <scaleFetcher.Form method="post">
                <input type="hidden" name="intent" value="apply_direction" />
                <input type="hidden" name="campaign_id" value={detail.id} />
                <input type="hidden" name="action_kind" value="increase_campaign_budget" />
                <input type="hidden" name="daily_budget_cents" value={String(scale.newBudgetCents)} />
                <Button variant="primary" submit loading={scaleFetcher.state !== "idle"}>
                  {`Scale budget +${scale.pct}%`}
                </Button>
              </scaleFetcher.Form>
              {scaleFetcher.data &&
                (() => {
                  // Gate on outcome, not ok: a `retrying` outcome is queued, NOT
                  // applied — showing "scaled" for it is a phantom success (rule 12).
                  const outcome = (scaleFetcher.data as { outcome?: string }).outcome;
                  if (outcome === "succeeded") {
                    return (
                      <Banner tone="success">
                        Budget scaled — live and reversible from the Campaigns list.
                      </Banner>
                    );
                  }
                  if (outcome === "retrying") {
                    return (
                      <Banner tone="warning">
                        Couldn&apos;t reach the ad platform — queued, will retry automatically.
                      </Banner>
                    );
                  }
                  return <Banner tone="critical">Couldn&apos;t scale the budget. Please try again.</Banner>;
                })()}
              <Text as="p" tone="subdued" variant="bodySm">
                Reversible from the Campaigns list.
              </Text>
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Real performance
            </Text>
            {perf.available ? (
              <InlineGrid columns={{ xs: 2, sm: 5 }} gap="400">
                <Stat label="Daily budget" value={moneyOrDash(detail.status === "paused" ? null : perf.dailyBudgetCents)} />
                <Stat label="7-day spend" value={moneyOrDash(perf.spend7dCents)} />
                <Stat
                  label="Ad return"
                  value={perf.reportedRoas != null ? `${perf.reportedRoas.toFixed(1)}×` : "—"}
                  help="Reported ROAS — revenue ÷ ad spend, before product costs"
                />
                <Stat
                  label="Break-even ROAS"
                  value={perf.breakEvenRoas != null ? `${perf.breakEvenRoas.toFixed(1)}×` : "—"}
                  help="The ROAS this campaign must clear to break even (1 ÷ margin)"
                />
                <Stat
                  label="Profit ROAS (POAS)"
                  value={perf.realRoas != null ? `${perf.realRoas.toFixed(1)}×` : "—"}
                  help="Profit on ad spend — margin-adjusted ROAS (return after product costs)"
                  critical={perf.realRoas != null && perf.realRoas < 1}
                />
              </InlineGrid>
            ) : (
              <Banner tone="info">
                No performance data ingested for this campaign yet. Metrics appear once its
                spend and revenue have synced.
              </Banner>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Calderyn score</Text>
            <InlineStack gap="400" blockAlign="center" wrap>
              <Badge tone={SCORE_BADGE_TONE[calderynScore?.band ?? "nodata"]}>
                {calderynScore?.value != null ? `Score ${calderynScore.value}` : "Score pending"}
              </Badge>
              <Text as="span" tone="subdued">
                Performance {calderynScore?.performance != null ? calderynScore.performance : "—"}
              </Text>
              <Text as="span" tone="subdued">
                Creative {calderynScore?.creative != null ? calderynScore.creative : "—"}
              </Text>
              <Text as="span" tone="subdued">Confidence: {calderynScore?.confidence ?? "low"}</Text>
              <Text as="span" tone="subdued">
                Ads scored {calderynScore?.adsCovered ?? 0}/{calderynScore?.adsTotal ?? 0}
              </Text>
            </InlineStack>
            {(calderynScore?.performance == null || calderynScore?.creative == null) && (
              <Text as="p" tone="subdued">
                {calderynScore?.performance == null ? "Performance pending — attribution. " : ""}
                {calderynScore?.creative == null ? "Connect Meta to score this campaign's creatives." : ""}
              </Text>
            )}
          </BlockStack>
        </Card>

        {calderynScore && (calderynScore.weakDimensions.length > 0 || calderynScore.tips.length > 0) && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">How to improve</Text>
              {calderynScore.weakDimensions.map((d, i) => (
                <InlineStack key={`wd-${d.adId}-${i}`} gap="200" align="space-between">
                  <Text as="span">{d.label}</Text>
                  <Badge tone="warning">{String(d.score)}</Badge>
                </InlineStack>
              ))}
              {calderynScore.tips.map((t, i) => (
                <Text as="p" key={`tip-${i}`}>{t}</Text>
              ))}
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Ad creatives
            </Text>
            {creatives.length > 0 ? (
              // Tile creatives 2-up on wide screens so each ad's preview +
              // scorecard uses the horizontal space instead of a tall column.
              <InlineGrid columns={{ xs: 1, lg: 2 }} gap="500">
                {creatives.map((c, i) => (
                  <CreativeWithScorecard
                    key={c.adId || `ad-${i}`}
                    creative={c}
                    cached={c.adId ? scorecardByAd.get(c.adId) : undefined}
                    metrics={c.adId ? metricsByAd.get(c.adId) : undefined}
                    metricsError={adMetricsError}
                    assumedSpendCents={assumedSpendCents}
                    campaignIdParam={campaignIdParam}
                  />
                ))}
              </InlineGrid>
            ) : (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">
                  No ad creatives found for this campaign.
                </Text>
                {creativesError && (
                  <Banner tone="info" title="Couldn't load ad creatives">
                    <p>{creativesError.message}</p>
                  </Banner>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
        {detail && (
          <RegenerateCard
            campaignIdParam={campaignIdParam}
            adIds={creatives.map((c) => c.adId).filter(Boolean)}
            assumedSpendCents={assumedSpendCents}
            metaCanPushDrafts={metaCanPushDrafts}
          />
        )}
        {detail && <ScreenNewCreativeCard campaignIdParam={campaignIdParam} />}
      </BlockStack>
    </Page>
  );
}

function RegenerateCard({
  campaignIdParam,
  adIds,
  assumedSpendCents,
  metaCanPushDrafts,
}: {
  campaignIdParam: string;
  adIds: string[];
  assumedSpendCents: number;
  metaCanPushDrafts: boolean;
}) {
  const fetcher = useFetcher<RegenActionPayload>();
  const pushFetcher = useFetcher<{ ok: boolean; outcome?: string }>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const variants = data && data.ok ? data.variants : [];
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">Regenerate copy</Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Rewrites the campaign&apos;s weakest creative, re-scores each rewrite, and keeps only ones that beat it.
        </Text>
        <fetcher.Form
          method="post"
          action={`/app/campaigns/${encodeURIComponent(campaignIdParam)}/regenerate`}
        >
          <input type="hidden" name="adIds" value={JSON.stringify(adIds)} />
          <input type="hidden" name="assumedSpendCents" value={String(assumedSpendCents)} />
          <Button submit variant="primary" loading={busy} disabled={busy || adIds.length === 0}>
            Regenerate
          </Button>
        </fetcher.Form>
        {data && !data.ok && <Banner tone="warning">{data.error.message}</Banner>}
        {!metaCanPushDrafts && variants.length > 0 && (
          <Banner tone="info">
            Reconnect Meta with ad-management access to push drafts.
          </Banner>
        )}
        {pushFetcher.data?.ok === false && (
          <Banner tone="critical">Couldn&apos;t push the draft — see action history.</Banner>
        )}
        {variants.map((v, i) => (
          <div key={i} style={{ background: "var(--p-color-bg-surface-secondary)", borderRadius: 12, padding: "12px 14px" }}>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="info">{v.mode}</Badge>
              <Text as="span" variant="bodyMd" fontWeight="semibold">{String(v.composite)}</Text>
              <Text as="span" variant="bodySm" tone="success">{`+${v.delta}`}</Text>
            </InlineStack>
            <Box paddingBlockStart="150">
              <Text as="p" variant="bodyMd">&ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}</Text>
            </Box>
            <Text as="p" variant="bodySm" tone="subdued">{v.rationale}</Text>
            {metaCanPushDrafts && (
              <Box paddingBlockStart="200">
                <pushFetcher.Form method="post">
                  <input type="hidden" name="intent" value="push_creative_draft" />
                  <input type="hidden" name="campaign_id" value={campaignIdParam} />
                  <input type="hidden" name="headline" value={v.input.headline} />
                  <input type="hidden" name="primaryText" value={v.input.primaryText} />
                  <input type="hidden" name="cta" value={v.input.cta} />
                  <input type="hidden" name="destinationUrl" value={v.input.destinationUrl} />
                  <input type="hidden" name="imageUrl" value={v.input.imageUrl ?? ""} />
                  <input type="hidden" name="audience" value={v.input.audience ?? ""} />
                  <Button submit loading={pushFetcher.state !== "idle"}>
                    Push to Meta as paused draft
                  </Button>
                </pushFetcher.Form>
              </Box>
            )}
          </div>
        ))}
      </BlockStack>
    </Card>
  );
}

function ScreenNewCreativeCard({ campaignIdParam }: { campaignIdParam: string }) {
  const fetcher = useFetcher<ScreenActionPayload>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;
  const card = data && data.ok && data.run.scorecard ? data.run.scorecard : null;
  const [imageUrl, setImageUrl] = useState("");
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">Screen a new creative</Text>
        <fetcher.Form
          method="post"
          action={`/app/campaigns/${encodeURIComponent(campaignIdParam)}/screen`}
        >
          <FormLayout>
            <TextField label="Headline" name="headline" autoComplete="off" />
            <TextField label="Primary text" name="primaryText" multiline={3} autoComplete="off" />
            <FormLayout.Group>
              <TextField label="Call to action" name="cta" autoComplete="off" placeholder="Shop now" />
              <TextField label="Audience" name="audience" autoComplete="off" />
            </FormLayout.Group>
            <TextField label="Where the click goes" name="destinationUrl" autoComplete="off" />
            <TextField label="Image URL (https)" name="imageUrl" autoComplete="off" value={imageUrl} onChange={setImageUrl} />
            <input type="hidden" name="mediaKind" value="image" />
            <Button submit variant="primary" loading={busy} disabled={busy || !imageUrl}>
              Score creative
            </Button>
          </FormLayout>
        </fetcher.Form>
        {data && !data.ok && <Banner tone="critical">{data.error.message}</Banner>}
        {data && data.ok && data.run.status === "error" && (
          <Banner tone="critical">{data.run.error}</Banner>
        )}
        {card && <Scorecard card={card} />}
      </BlockStack>
    </Card>
  );
}

// One ad: its creative preview (paints immediately), then its predictive
// scorecard slot beneath it. The slot uses a cached scorecard when the loader
// already had one, else streams it from the score resource route.
function CreativeWithScorecard({
  creative,
  cached,
  metrics,
  metricsError,
  assumedSpendCents,
  campaignIdParam,
}: {
  creative: CampaignCreative;
  cached: AdScorecard | undefined;
  metrics: AdMetrics | undefined;
  metricsError: { code: string; message: string } | null;
  assumedSpendCents: number;
  campaignIdParam: string;
}) {
  return (
    <BlockStack gap="300">
      <CreativeCard creative={creative} />
      <LiveMetricsRow metrics={metrics} metricsError={metricsError} />
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h4" variant="headingXs">
            Predicted score
          </Text>
          <Badge tone="attention">Predicted</Badge>
        </InlineStack>
        <AdScorecardSlot
          creative={creative}
          cached={cached}
          assumedSpendCents={assumedSpendCents}
          campaignIdParam={campaignIdParam}
        />
      </BlockStack>
    </BlockStack>
  );
}

// Real, ACTUAL per-ad performance over the last 7 days (vs the PREDICTED scorecard
// below). Every metric renders its real value OR "— (no data)" when the field is
// null or there's no metrics row for this ad at all — NEVER a fabricated 0
// (rule 12). If the whole fetch failed, one honest subdued line says so.
function LiveMetricsRow({
  metrics,
  metricsError,
}: {
  metrics: AdMetrics | undefined;
  metricsError: { code: string; message: string } | null;
}) {
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h4" variant="headingXs">
          Live performance (7d)
        </Text>
        <Badge tone="info">Actual</Badge>
      </InlineStack>
      {metricsError && (
        <Text as="p" variant="bodySm" tone="subdued">
          Live metrics unavailable: {metricsError.message}
        </Text>
      )}
      <InlineGrid columns={{ xs: 2, sm: 5 }} gap="300">
        <Metric label="7d spend" value={moneyOrNoData(metrics?.spendCents ?? null)} />
        <Metric label="Impressions" value={intOrNoData(metrics?.impressions ?? null)} />
        <Metric label="Clicks" value={intOrNoData(metrics?.clicks ?? null)} />
        <Metric label="CTR" value={pctOrNoData(metrics?.ctr ?? null)} />
        <Metric label="CPM" value={moneyOrNoData(metrics?.cpmCents ?? null)} />
      </InlineGrid>
    </BlockStack>
  );
}

// Predictive scorecard for a single ad. If the loader already cached a done
// scorecard we render it with NO fetch. Otherwise each slot owns its OWN fetcher
// and POSTs once on mount to /app/campaigns/:campaignId/score, so ads stream in
// independently. A ref keyed off adId guards React strict-mode's double-invoke so
// we never double-submit the same ad. While in flight we show a Polaris spinner;
// on failure we show an honest "unavailable" line (rule 12), never a blank.
function AdScorecardSlot({
  creative,
  cached,
  assumedSpendCents,
  campaignIdParam,
}: {
  creative: CampaignCreative;
  cached: AdScorecard | undefined;
  assumedSpendCents: number;
  campaignIdParam: string;
}) {
  const fetcher = useFetcher<ScoreActionPayload>();
  const submittedFor = useRef<string | null>(null);

  const hasCache = !!(cached && cached.status === "done" && cached.scorecard);
  // No adId → we can't key a score run to it; surface honestly, never fetch.
  const missingAdId = !creative.adId;

  useEffect(() => {
    if (hasCache || missingAdId) return;
    if (submittedFor.current === creative.adId) return;
    submittedFor.current = creative.adId;
    const fd = new FormData();
    fd.set("adId", creative.adId);
    fd.set("assumedSpendCents", String(assumedSpendCents));
    fd.set("imageUrl", creative.creative.imageUrl ?? "");
    fd.set("headline", creative.creative.headline);
    fd.set("primaryText", creative.creative.primaryText);
    fd.set("cta", creative.creative.cta);
    fd.set("destinationUrl", creative.creative.destinationUrl);
    fd.set("audience", creative.creative.audience);
    fetcher.submit(fd, {
      method: "post",
      action: `/app/campaigns/${encodeURIComponent(campaignIdParam)}/score`,
    });
    // Fire exactly once per ad; fetcher identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creative.adId, hasCache, missingAdId]);

  if (hasCache && cached?.scorecard) {
    return <Scorecard card={cached.scorecard} />;
  }

  if (missingAdId) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Analysis unavailable: ad is missing an ad id.
      </Text>
    );
  }

  const data = fetcher.data;
  if (data) {
    if (data.ok && data.scorecard.status === "done" && data.scorecard.scorecard) {
      return <Scorecard card={data.scorecard.scorecard} />;
    }
    const message = data.ok
      ? (data.scorecard.error ?? "Scoring produced no scorecard.")
      : data.error.message;
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        Analysis unavailable: {message}
      </Text>
    );
  }

  return (
    <InlineStack gap="200" blockAlign="center">
      <Spinner size="small" accessibilityLabel="Analyzing creative" />
      <Text as="span" variant="bodySm" tone="subdued">
        Analyzing creative…
      </Text>
    </InlineStack>
  );
}

function CreativeCard({ creative }: { creative: CampaignCreative }) {
  const c = creative.creative;
  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="300" blockAlign="start" wrap={false}>
          {c.imageUrl ? (
            <Thumbnail source={c.imageUrl} alt={c.headline || creative.adName} size="large" />
          ) : (
            <Thumbnail source={ImageIcon} alt="No image" size="large" />
          )}
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm" fontWeight="semibold">
              {c.headline || creative.adName || "Untitled ad"}
            </Text>
            {c.primaryText && (
              <Text as="p" variant="bodySm" tone="subdued">
                {c.primaryText}
              </Text>
            )}
          </BlockStack>
        </InlineStack>
        <InlineStack gap="200" blockAlign="center">
          {c.cta && <Badge>{c.cta}</Badge>}
          {c.destinationUrl && (
            <Text as="span" variant="bodySm" tone="subdued">
              {c.destinationUrl}
            </Text>
          )}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function moneyOrDash(cents: number | null): string {
  return cents == null ? "—" : fmtMoney(cents);
}

// Live-metrics gap marker (rule 12): an em dash means "no data synced", never a
// fabricated 0. (The parenthetical "(no data)" read as clutter at table scale.)
const NO_DATA = "—";

function moneyOrNoData(cents: number | null): string {
  return cents == null ? NO_DATA : fmtMoney(cents);
}

function intOrNoData(n: number | null): string {
  return n == null ? NO_DATA : new Intl.NumberFormat("en-US").format(n);
}

function pctOrNoData(ctr: number | null): string {
  return ctr == null ? NO_DATA : `${ctr.toFixed(2)}%`;
}

// A single live-metric cell: subdued label above the actual value (or gap marker).
function Metric({ label, value }: { label: string; value: string }) {
  const noData = value === NO_DATA;
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodyXs" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodyMd" tone={noData ? "subdued" : undefined}>
        {value}
      </Text>
    </BlockStack>
  );
}

function Stat({
  label,
  value,
  help,
  critical,
}: {
  label: string;
  value: string;
  help?: string;
  critical?: boolean;
}) {
  return (
    <BlockStack gap="100">
      <InlineStack gap="100" blockAlign="center">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
      </InlineStack>
      <Text as="span" variant="headingLg" tone={critical ? "critical" : undefined}>
        {value}
      </Text>
      {help && (
        <Text as="span" variant="bodySm" tone="subdued">
          {help}
        </Text>
      )}
    </BlockStack>
  );
}
