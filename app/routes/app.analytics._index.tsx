// Analytics — account ROAS trend + per-campaign winning/okay/poor grade
// (computed by the engine) + top ads by engagement + the linked
// campaign_below_breakeven alert as the "next step".
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  DataTable,
  Link,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { MarginChart } from "~/components/MarginChart";
import { toRoasSeries, formatRoas, gradeTone } from "~/lib/analytics-view";
import { fmtMoneyDec } from "~/lib/format";
import type { CampaignGradeRow, DailyRoasRow, TopAdRow } from "~/lib/types";

const WINDOW_DAYS = 30;

type LoaderPayload = {
  roasSeries: DailyRoasRow[];
  grades: CampaignGradeRow[];
  topAds: TopAdRow[];
  breakevenCount: number;
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [roasSeries, grades, topAds, breakevenAlerts] = await Promise.all([
      client.analytics.dailyRoasSeries(WINDOW_DAYS, request.signal),
      client.analytics.campaignGrades(request.signal),
      client.analytics.topAdsByEngagement(WINDOW_DAYS, 20, request.signal),
      client.alerts.list(
        { detector: "campaign_below_breakeven", status: "open" },
        request.signal,
      ),
    ]);
    return json<LoaderPayload>({
      roasSeries,
      grades,
      topAds,
      breakevenCount: breakevenAlerts.length,
      error: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      roasSeries: [],
      grades: [],
      topAds: [],
      breakevenCount: 0,
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export default function Analytics() {
  const navigate = useEmbeddedNavigate();
  const { roasSeries, grades, topAds, breakevenCount, error } =
    useLoaderData<typeof loader>();
  const series = toRoasSeries(roasSeries);

  const gradeRows = grades.map((g) => [
    <Text key={`n-${g.campaign_id}`} as="span" fontWeight="semibold">
      {g.name || g.campaign_id}
    </Text>,
    <Badge key={`g-${g.campaign_id}`} tone={gradeTone(g.grade)}>
      {g.grade}
    </Badge>,
    formatRoas(g.roas),
    formatRoas(g.break_even_roas),
    fmtMoneyDec(g.spend_cents),
    fmtMoneyDec(g.revenue_cents),
  ]);

  const adRows = topAds.map((a) => [
    a.ad_name || a.ad_external_id,
    <Text key={`c-${a.ad_external_id}`} as="span" tone="subdued">
      {a.campaign_name}
    </Text>,
    String(a.reactions),
    String(a.comments),
    String(a.shares),
    String(a.saves),
    <Text key={`t-${a.ad_external_id}`} as="span" fontWeight="semibold">
      {a.engagement}
    </Text>,
  ]);

  return (
    <Page
      title="Analytics"
      subtitle={`Ad performance over the last ${WINDOW_DAYS} days: return on ad spend, per-campaign grade, and the ads driving engagement.`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load analytics">
            <p>{error.message}</p>
          </Banner>
        )}

        {breakevenCount > 0 && (
          <Banner tone="warning" title={`${breakevenCount} campaign${breakevenCount === 1 ? "" : "s"} losing money`}>
            <p>
              These campaigns spent more than the profit they made after product costs.{" "}
              <Link onClick={() => navigate("/app/alerts")}>Review and act →</Link>
            </p>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="050">
              <Text as="h2" variant="headingMd">
                ROAS trend
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                Return on ad spend across the last {WINDOW_DAYS} days. Higher is better; 1.0× means every dollar in came back as a dollar of revenue.
              </Text>
            </BlockStack>
            <MarginChart
              series={series}
              formatValue={formatRoas}
              ariaLabel="Return on ad spend over time"
            />
          </BlockStack>
        </Card>

        <Card padding="0">
          <Box padding="400">
            <Text as="h2" variant="headingMd">
              Campaign grades
            </Text>
          </Box>
          {grades.length === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued">
                No campaign grades yet — they appear after the next engine run
                with spend in the window.
              </Text>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric"]}
              headings={[
                "Campaign",
                "Grade",
                <Tooltip key="roas" content="ROAS — return on ad spend (revenue ÷ ad spend)">
                  <span>Ad return</span>
                </Tooltip>,
                <Tooltip key="be" content="Break-even — the ad return you need just to not lose money">
                  <span>Break-even</span>
                </Tooltip>,
                "Spend",
                "Revenue",
              ]}
              rows={gradeRows}
            />
          )}
        </Card>

        <Card padding="0">
          <Box padding="400">
            <Text as="h2" variant="headingMd">
              Top ads by engagement
            </Text>
          </Box>
          {topAds.length === 0 ? (
            <Box padding="400">
              <Text as="p" tone="subdued">
                No ad engagement synced yet.
              </Text>
            </Box>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Ad", "Campaign", "Reactions", "Comments", "Shares", "Saves", "Total"]}
              rows={adRows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
