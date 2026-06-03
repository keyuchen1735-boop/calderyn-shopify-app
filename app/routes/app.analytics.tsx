import { useEffect, useState } from "react";
import { useNavigate, useLoaderData, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge, Banner, BlockStack, Button, ButtonGroup, Card, DataTable,
  InlineGrid, Page, Text,
} from "@shopify/polaris";
import { PolarisVizProvider, LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney } from "~/lib/format";
import type { AnalyticsSummary, CampaignInsight, TrendPoint } from "~/lib/types";

type LoaderPayload = {
  window: 30 | 90;
  summary: AnalyticsSummary | null;
  trend: TrendPoint[];
  campaigns: CampaignInsight[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const window = url.searchParams.get("window") === "90" ? 90 : 30;
  const client = calderynClient(session.shop);
  try {
    const [summary, trend, campaigns] = await Promise.all([
      client.analytics.summary(window),
      client.analytics.trend(window),
      client.analytics.campaigns(window),
    ]);
    return json<LoaderPayload>({ window, summary, trend, campaigns, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({ window, summary: null, trend: [], campaigns: [], error: { code: e.code ?? "ERROR", message: e.message } });
  }
};

const GRADE_TONE = { winning: "success", okay: "attention", poor: "critical" } as const;

export default function Analytics() {
  const navigate = useNavigate();
  const { window, summary, trend, campaigns, error } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const setWindow = (w: 30 | 90) => {
    params.set("window", String(w));
    setParams(params);
  };

  const series = [
    { name: "Spend", data: trend.map((p) => ({ key: p.day_bucket, value: p.spend_cents / 100 })) },
    { name: "ROAS", data: trend.map((p) => ({ key: p.day_bucket, value: p.roas })) },
  ];

  const rows = campaigns.map((c) => [
    <Text key={`n-${c.campaign_id}`} as="span" fontWeight="semibold">{c.name}</Text>,
    <Badge key={`g-${c.campaign_id}`} tone={GRADE_TONE[c.grade]}>{c.grade}</Badge>,
    fmtMoney(c.spend_cents),
    c.roas.toFixed(2),
    c.break_even_roas.toFixed(2),
    String(c.engagement.reactions + c.engagement.comments + c.engagement.shares + c.engagement.saves),
    c.linked_alert_ids.length ? (
      <Button key={`a-${c.campaign_id}`} variant="plain" onClick={() => navigate("/app/campaigns")}>Take action</Button>
    ) : "-",
  ]);

  return (
    <Page
      title="Analytics"
      subtitle="Real Meta ad-spend, ROAS and engagement"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load analytics"><p>{error.code}: {error.message}</p></Banner>
        )}
        {summary && (summary.margin_confidence === "low" || summary.margin_confidence === "default") ? (
          <Banner tone="warning" title="Margin estimate is low-confidence">
            <p>Set your gross margin in Settings for accurate break-even grading.</p>
          </Banner>
        ) : null}

        <ButtonGroup variant="segmented">
          <Button pressed={window === 30} onClick={() => setWindow(30)}>30 days</Button>
          <Button pressed={window === 90} onClick={() => setWindow(90)}>90 days</Button>
        </ButtonGroup>

        {summary && (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Stat label="Account ROAS" value={summary.account_roas.toFixed(2)} />
            <Stat label="Break-even ROAS" value={summary.break_even_roas.toFixed(2)} />
            <Stat label="Spend" value={fmtMoney(summary.total_spend_cents)} />
            <Stat label="Engagement" value={String(summary.total_engagement)} />
          </InlineGrid>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">Spend &amp; ROAS trend</Text>
            <div style={{ height: 280 }}>
              {mounted ? (
                <PolarisVizProvider>
                  <LineChart data={series} />
                </PolarisVizProvider>
              ) : null}
            </div>
          </BlockStack>
        </Card>

        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "text"]}
            headings={["Campaign", "Grade", "Spend", "ROAS", "Break-even", "Engagement", "Next step"]}
            rows={rows}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
      </BlockStack>
    </Card>
  );
}
