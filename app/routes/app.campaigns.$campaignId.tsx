import { useNavigate, useLoaderData } from "@remix-run/react";
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
  Text,
  Thumbnail,
} from "@shopify/polaris";
import { ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
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
import { fmtMoney } from "~/lib/format";
import type { Campaign } from "~/lib/types";

type CampaignDetail = {
  /** id to use for actions: dim uuid if ingested, else the platform external id. */
  id: string;
  externalId: string;
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
    });
  }

  try {
    // 1) Ingested perf row, addressed directly by dim uuid.
    let campaign: Campaign | null = await getOrNull(client, idFromUrl);
    let actionId = idFromUrl;

    // 2) Live external id → dim uuid → perf row.
    if (!campaign) {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const platform = platformParam === "Google" ? "google" : "meta";
      const dimId = await resolveCampaignDimId(sb, shopId, platform, idFromUrl);
      if (dimId) {
        campaign = await getOrNull(client, dimId);
        if (campaign) actionId = dimId;
      }
    }

    if (campaign) {
      const detail: CampaignDetail = {
        id: actionId,
        externalId: idFromUrl,
        name: campaign.name,
        platform: campaign.platform,
        status: campaign.status,
        performance: buildCampaignPerformance(campaign),
      };
      const { creatives, creativesError } = await loadCreatives(session.shop, detail);
      return json<LoaderPayload>({ detail, error: null, creatives, creativesError });
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
            name: owned.name,
            platform: "Meta",
            status: owned.status === "PAUSED" ? "paused" : "active",
            performance: buildCampaignPerformance(null),
          };
          const { creatives, creativesError } = await loadCreatives(session.shop, detail);
          return json<LoaderPayload>({ detail, error: null, creatives, creativesError });
        }
      }
    }

    return json<LoaderPayload>({
      detail: null,
      error: { code: "CAMPAIGN_NOT_FOUND", message: `Campaign ${idFromUrl} not found` },
      creatives: [],
      creativesError: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      detail: null,
      error: { code: e.code ?? "ERROR", message: e.message },
      creatives: [],
      creativesError: null,
    });
  }
};

// Fetch Meta ad creatives for the detail. Isolated in its own try/catch so a
// creative-fetch failure NEVER breaks the performance card (rule 12: surface the
// gap honestly via creativesError rather than failing the whole loader). When a
// campaign was resolved by dim UUID (ingested), detail.externalId may be a dim
// UUID rather than a Meta external id, so the /ads call errors — that's expected
// and lands here as creativesError, rendering the empty state.
async function loadCreatives(
  shop: string,
  detail: CampaignDetail,
): Promise<{ creatives: CampaignCreative[]; creativesError: { code: string; message: string } | null }> {
  if (detail.platform !== "Meta") {
    return { creatives: [], creativesError: null };
  }
  try {
    const meta = await metaClientForShop(shop);
    if (!meta) {
      return {
        creatives: [],
        creativesError: { code: "META_NOT_CONNECTED", message: "Meta account not connected" },
      };
    }
    const creatives = await listCampaignCreatives(meta.client, detail.externalId);
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
  const { detail, error, creatives, creativesError } = useLoaderData<typeof loader>();

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
              <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
                {creatives.map((c) => (
                  <CreativeCard key={c.adId || c.adName} creative={c} />
                ))}
              </InlineGrid>
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
