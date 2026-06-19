// Analytics — account ROAS trend + per-campaign winning/okay/poor grade
// (computed by the engine) + top ads by engagement + the linked
// campaign_below_breakeven alert as the "next step".
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Fragment } from "react";
import { useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  DataTable,
  Divider,
  InlineStack,
  Link,
  Page,
  Text,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { MarginChart } from "~/components/MarginChart";
import { toRoasSeries, formatRoas, gradeTone } from "~/lib/analytics-view";
import { gradeFromRow, gradeLabel } from "~/lib/campaign-grade";
import { fmtMoneyDec } from "~/lib/format";
import type { CampaignGradeRow, DailyRoasRow, TopAdRow } from "~/lib/types";

const WINDOW_DAYS = 30;

type LoaderPayload = {
  roasSeries: DailyRoasRow[];
  grades: CampaignGradeRow[];
  topAds: TopAdRow[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [roasSeries, grades, topAds] = await Promise.all([
      client.analytics.dailyRoasSeries(WINDOW_DAYS, request.signal),
      client.analytics.campaignGrades(request.signal),
      client.analytics.topAdsByEngagement(WINDOW_DAYS, 20, request.signal),
    ]);
    return json<LoaderPayload>({
      roasSeries,
      grades,
      topAds,
      error: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      roasSeries: [],
      grades: [],
      topAds: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

/** One label/value pair in a mobile analytics card's metric row. */
function AnalyticsMetric({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodyXs" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodySm" fontWeight="semibold" numeric>
        {value}
      </Text>
    </BlockStack>
  );
}

/** Phone-width render of one campaign-grade row: name + grade badge + the same
 *  four metrics as the desktop table, using the shared formatting helpers. */
function GradeCard({ g }: { g: CampaignGradeRow }) {
  const grade = gradeFromRow(g);
  return (
    <Box padding="400">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="span" fontWeight="semibold">
            {g.name || g.campaign_id}
          </Text>
          <Badge tone={gradeTone(grade)}>{gradeLabel(grade)}</Badge>
        </InlineStack>
        <InlineStack gap="400">
          <AnalyticsMetric label="Ad return" value={formatRoas(g.roas)} />
          <AnalyticsMetric label="Break-even" value={formatRoas(g.break_even_roas)} />
          <AnalyticsMetric label="Spend" value={fmtMoneyDec(g.spend_cents)} />
          <AnalyticsMetric label="Revenue" value={fmtMoneyDec(g.revenue_cents)} />
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

/** Phone-width render of one top-ad row: ad name + campaign + engagement total
 *  (with the same hover breakdown as the table). */
function AdCard({ a }: { a: TopAdRow }) {
  return (
    <Box padding="400">
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
        <BlockStack gap="050">
          <Text as="span" fontWeight="semibold">
            {a.ad_name || a.ad_external_id}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {a.campaign_name}
          </Text>
        </BlockStack>
        <Tooltip
          content={`${a.reactions.toLocaleString()} reactions · ${a.comments.toLocaleString()} comments · ${a.shares.toLocaleString()} shares · ${a.saves.toLocaleString()} saves`}
        >
          <Text as="span" fontWeight="semibold" numeric>
            {a.engagement.toLocaleString()}
          </Text>
        </Tooltip>
      </InlineStack>
    </Box>
  );
}

export default function Analytics() {
  const navigate = useEmbeddedNavigate();
  const { roasSeries, grades, topAds, error } = useLoaderData<typeof loader>();
  const series = toRoasSeries(roasSeries);
  // Phones get stacked cards instead of the multi-column DataTables.
  const { smDown } = useBreakpoints();

  // Derive the "losing money" count from the same grades the table below renders,
  // so the banner can't disagree with the on-page list (a poor-grade campaign may
  // have no open alert — acknowledged, under the min-spend guardrail, etc.). Same
  // rule as the web dashboard's Analytics screen.
  const losing = grades.filter(
    (g) => g.break_even_roas > 0 && g.roas < g.break_even_roas,
  );
  const breakevenCount = losing.length;

  const gradeRows = grades.map((g) => [
    <Text key={`n-${g.campaign_id}`} as="span" fontWeight="semibold">
      {g.name || g.campaign_id}
    </Text>,
    <Badge key={`g-${g.campaign_id}`} tone={gradeTone(gradeFromRow(g))}>
      {gradeLabel(gradeFromRow(g))}
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
    <Tooltip
      key={`e-${a.ad_external_id}`}
      content={`${a.reactions.toLocaleString()} reactions · ${a.comments.toLocaleString()} comments · ${a.shares.toLocaleString()} shares · ${a.saves.toLocaleString()} saves`}
    >
      <Text as="span" fontWeight="semibold">
        {a.engagement.toLocaleString()}
      </Text>
    </Tooltip>,
  ]);

  return (
    <Page
      fullWidth
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
          ) : smDown ? (
            grades.map((g, i) => (
              <Fragment key={g.campaign_id}>
                {i > 0 && <Divider />}
                <GradeCard g={g} />
              </Fragment>
            ))
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
          ) : smDown ? (
            topAds.map((a, i) => (
              <Fragment key={a.ad_external_id}>
                {i > 0 && <Divider />}
                <AdCard a={a} />
              </Fragment>
            ))
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "numeric"]}
              headings={[
                "Ad",
                "Campaign",
                <Tooltip
                  key="eng"
                  content="Reactions + comments + shares + saves over the window. Hover a row for the breakdown."
                >
                  <span>Engagement</span>
                </Tooltip>,
              ]}
              rows={adRows}
            />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
