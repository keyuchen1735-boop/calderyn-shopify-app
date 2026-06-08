import { useEffect, useRef } from "react";
import { useNavigate, useLoaderData, useFetcher } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Spinner,
  Text,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { Scorecard } from "~/components/Scorecard";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { metaClientForShop } from "~/lib/meta/client.server";
import { listCampaigns } from "~/lib/meta/campaigns.server";
import {
  listCampaignCreatives,
  type CampaignCreative,
} from "~/lib/meta/creatives.server";
import {
  buildCampaignPerformance,
  type CampaignPerformance,
} from "~/lib/ads/campaign-detail.server";
import {
  loadCachedAdScorecards,
  type AdScorecard,
} from "~/lib/screener/campaign-ads.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
} from "~/lib/screener/types";
import type { ScoreActionPayload } from "./app.campaigns.$campaignId.score";
import { fmtMoney } from "~/lib/format";
import type { Campaign } from "~/lib/types";

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
  platform: "Meta" | "Google";
  status: "active" | "paused";
  performance: CampaignPerformance;
};

type LoaderPayload = {
  detail: CampaignDetail | null;
  error: { code: string; message: string } | null;
  creatives: CampaignCreative[];
  creativesError: { code: string; message: string } | null;
  /** Cache-only scorecards (no Claude in the loader); uncached ads stream in. */
  scorecards: AdScorecard[];
  /** Clamped spend basis the client passes to the score route per ad. */
  assumedSpendCents: number;
  /** The id this page was loaded under (params.campaignId) — the score route path. */
  campaignIdParam: string;
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
  const platformParam = url.searchParams.get("platform") === "Google" ? "Google" : "Meta";
  const client = calderynClient(session.shop);

  if (!idFromUrl) {
    return json<LoaderPayload>({
      detail: null,
      error: { code: "INVALID_REQUEST", message: "Missing campaign id" },
      creatives: [],
      creativesError: null,
      scorecards: [],
      assumedSpendCents: DEFAULT_SPEND_CENTS,
      campaignIdParam: idFromUrl,
    });
  }

  try {
    // 1) Ingested perf row, addressed directly by dim uuid. Here idFromUrl is
    // v_campaigns_flat.id, which is NOT guaranteed to be a Meta external id, so
    // confirmedExternalId stays null.
    let campaign: Campaign | null = await getOrNull(client, idFromUrl);
    let actionId = idFromUrl;
    let confirmedExternalId: string | null = null;

    // 2) Live external id → dim uuid → perf row. idFromUrl resolved as a real
    // external id, so it is a confirmed Meta external id.
    if (!campaign) {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const platform = platformParam === "Google" ? "google" : "meta";
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
      const { creatives, creativesError } = await loadCreatives(session.shop, detail);
      const assumedSpendCents = spendBasis(detail.performance);
      const scorecards = await loadCachedScorecards(session.shop, creatives);
      return json<LoaderPayload>({
        detail,
        error: null,
        creatives,
        creativesError,
        scorecards,
        assumedSpendCents,
        campaignIdParam: idFromUrl,
      });
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
          const { creatives, creativesError } = await loadCreatives(session.shop, detail);
          const assumedSpendCents = spendBasis(detail.performance);
          const scorecards = await loadCachedScorecards(session.shop, creatives);
          return json<LoaderPayload>({
            detail,
            error: null,
            creatives,
            creativesError,
            scorecards,
            assumedSpendCents,
            campaignIdParam: idFromUrl,
          });
        }
      }
    }

    return json<LoaderPayload>({
      detail: null,
      error: { code: "CAMPAIGN_NOT_FOUND", message: `Campaign ${idFromUrl} not found` },
      creatives: [],
      creativesError: null,
      scorecards: [],
      assumedSpendCents: DEFAULT_SPEND_CENTS,
      campaignIdParam: idFromUrl,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      detail: null,
      error: { code: e.code ?? "ERROR", message: e.message },
      creatives: [],
      creativesError: null,
      scorecards: [],
      assumedSpendCents: DEFAULT_SPEND_CENTS,
      campaignIdParam: idFromUrl,
    });
  }
};

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
async function loadCreatives(
  shop: string,
  detail: CampaignDetail,
): Promise<{ creatives: CampaignCreative[]; creativesError: { code: string; message: string } | null }> {
  if (detail.platform !== "Meta") {
    return { creatives: [], creativesError: null };
  }
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
  const navigate = useNavigate();
  const { detail, error, creatives, creativesError, scorecards, assumedSpendCents, campaignIdParam } =
    useLoaderData<typeof loader>();

  if (!detail) {
    return (
      <Page
        title="Campaign"
        backAction={{ content: "Campaigns", onAction: () => navigate("/app/campaigns") }}
      >
        <Banner tone="critical" title="Couldn't load campaign">
          <p>
            {error?.code}: {error?.message}
          </p>
        </Banner>
      </Page>
    );
  }

  const perf = detail.performance;
  const scorecardByAd = new Map(scorecards.map((s) => [s.adId, s]));
  return (
    <Page
      title={detail.name}
      titleMetadata={
        <Badge tone={detail.status === "active" ? "success" : "attention"}>
          {detail.status === "active" ? "Active" : "Paused"}
        </Badge>
      }
      subtitle={`${detail.platform} campaign`}
      backAction={{ content: "Campaigns", onAction: () => navigate("/app/campaigns") }}
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Real performance
            </Text>
            {perf.available ? (
              <InlineGrid columns={{ xs: 2, sm: 4 }} gap="400">
                <Stat label="Daily budget" value={moneyOrDash(detail.status === "paused" ? null : perf.dailyBudgetCents)} />
                <Stat label="7-day spend" value={moneyOrDash(perf.spend7dCents)} />
                <Stat
                  label="Ad return"
                  value={perf.reportedRoas != null ? `${perf.reportedRoas.toFixed(1)}×` : "—"}
                  help="Reported ROAS — revenue ÷ ad spend, before product costs"
                />
                <Stat
                  label="Real return"
                  value={perf.realRoas != null ? `${perf.realRoas.toFixed(1)}×` : "—"}
                  help="Margin-adjusted ROAS — return after product costs are taken out"
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
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Ad creatives
            </Text>
            {creatives.length > 0 ? (
              <BlockStack gap="500">
                {creatives.map((c, i) => (
                  <CreativeWithScorecard
                    key={c.adId || `ad-${i}`}
                    creative={c}
                    cached={c.adId ? scorecardByAd.get(c.adId) : undefined}
                    assumedSpendCents={assumedSpendCents}
                    campaignIdParam={campaignIdParam}
                  />
                ))}
              </BlockStack>
            ) : (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" tone="subdued">
                  No ad creatives found for this campaign.
                </Text>
                {creativesError && (
                  <Banner tone="info" title="Couldn't load ad creatives">
                    <p>
                      {creativesError.code}: {creativesError.message}
                    </p>
                  </Banner>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

// One ad: its creative preview (paints immediately), then its predictive
// scorecard slot beneath it. The slot uses a cached scorecard when the loader
// already had one, else streams it from the score resource route.
function CreativeWithScorecard({
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
  return (
    <BlockStack gap="300">
      <CreativeCard creative={creative} />
      <AdScorecardSlot
        creative={creative}
        cached={cached}
        assumedSpendCents={assumedSpendCents}
        campaignIdParam={campaignIdParam}
      />
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
        Analysis unavailable: ad is missing a Meta ad id.
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
      : `${data.error.code}: ${data.error.message}`;
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
