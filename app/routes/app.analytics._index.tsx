// Analytics — account ROAS trend + per-campaign winning/okay/poor grade
// (computed by the engine) + top ads by engagement + the linked
// campaign_below_breakeven alert as the "next step". The lower section carries
// the at-a-glance money tiles, today's focus, and peer benchmarks that used to
// live on the home page (which is now the Live Engine).
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
  Button,
  Card,
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
import { fmtMoney, fmtMoneyDec, fmtRelTime } from "~/lib/format";
import { recoveredWithin } from "~/lib/recovered";
import { getPeerBenchmarks } from "~/lib/benchmarks/peer-benchmarks.server";
import { PeerBenchmarksCard } from "~/components/calderyn/PeerBenchmarksCard";
import { ACTION_LABELS, recommendedAction } from "~/lib/labels";
import { Icon } from "~/components/calderyn";
import type { PeerBenchmarks } from "~/lib/benchmarks/types";
import type {
  Alert,
  CampaignGradeRow,
  DailyRoasRow,
  GuardrailConfig,
  TopAdRow,
} from "~/lib/types";

const WINDOW_DAYS = 30;
// Recovered impact over the trailing 7 days — windowed server-side so the
// "Money we've saved you" tile matches its label (audit.list returns up to 90d).
const RECOVERED_WINDOW_DAYS = 7;

type LoaderPayload = {
  roasSeries: DailyRoasRow[];
  grades: CampaignGradeRow[];
  topAds: TopAdRow[];
  // Relocated-from-home: drive the focus alert, money tiles, and benchmarks.
  alerts: Alert[];
  guardrails: GuardrailConfig | null;
  recovered7d: { cents: number; count: number };
  benchmarks: PeerBenchmarks;
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [roasSeries, grades, topAds, alerts, audit, guardrails, benchmarks] =
      await Promise.all([
        client.analytics.dailyRoasSeries(WINDOW_DAYS, request.signal),
        client.analytics.campaignGrades(request.signal),
        client.analytics.topAdsByEngagement(WINDOW_DAYS, 20, request.signal),
        client.alerts.list({ status: "open" }, request.signal),
        client.audit.list(request.signal),
        client.guardrails.get(request.signal),
        getPeerBenchmarks(session.shop),
      ]);
    const sinceIso = new Date(
      Date.now() - RECOVERED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    return json<LoaderPayload>({
      roasSeries,
      grades,
      topAds,
      alerts,
      guardrails,
      recovered7d: recoveredWithin(audit, sinceIso),
      benchmarks,
      error: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      roasSeries: [],
      grades: [],
      topAds: [],
      alerts: [],
      guardrails: null,
      recovered7d: { cents: 0, count: 0 },
      benchmarks: { niche: "cat:uncategorized", consented: false, kpis: [] },
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

/** Tiny filled sparkline for the blended-ROAS KPI tile. Reads the same window
 *  the chart card below renders; no external chart lib (matches MarginChart's
 *  inline-SVG approach). Points are normalised to the tile's own min/max so a
 *  flat-ish series still reads as a line. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const W = 120;
  const H = 30;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * (H - 4) - 2;
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `0,${H} ${line} ${W},${H}`;
  return (
    <svg
      className="anx-spark"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={area} className="anx-spark-fill" />
      <polyline points={line} className="anx-spark-line" />
    </svg>
  );
}

export default function Analytics() {
  const navigate = useEmbeddedNavigate();
  const {
    roasSeries,
    grades,
    topAds,
    alerts,
    guardrails,
    recovered7d,
    benchmarks,
    error,
  } = useLoaderData<typeof loader>();
  const series = toRoasSeries(roasSeries);
  // Phones get stacked cards instead of the multi-column DataTables.
  const { smDown } = useBreakpoints();

  // Derive the "losing money" set from the same grades the table below renders,
  // so the banner/KPIs can't disagree with the on-page list (a poor-grade
  // campaign may have no open alert — acknowledged, under the min-spend
  // guardrail, etc.). Same rule as the web dashboard's Analytics screen.
  const losing = grades.filter(
    (g) => g.break_even_roas > 0 && g.roas < g.break_even_roas,
  );
  const breakevenCount = losing.length;

  // KPI strip — all derived from existing loader data (never the design's
  // sample numbers). The window totals come from the daily ROAS series; the
  // per-campaign counts/wasted spend come from the grade rows.
  const totalSpendCents = roasSeries.reduce((s, r) => s + r.spend_cents, 0);
  const totalRevenueCents = roasSeries.reduce((s, r) => s + r.revenue_cents, 0);
  const blendedRoas = totalSpendCents > 0 ? totalRevenueCents / totalSpendCents : 0;
  const wastedSpendCents = losing.reduce((s, g) => s + g.spend_cents, 0);
  const campaignCount = grades.length;
  // ROAS delta: last point vs first point of the rendered series. Positive =
  // improving. Null when there aren't two points to compare.
  const sparkValues = series.map((p) => p.margin_pct);
  const roasDelta =
    sparkValues.length >= 2
      ? sparkValues[sparkValues.length - 1] - sparkValues[0]
      : null;

  // ----- relocated from the old home: money tiles + today's focus -----
  const openAlerts = alerts.filter((a) => a.status === "open");
  const critical = openAlerts.filter((a) => a.severity === "critical");
  const { cents: recovered7dCents, count: recoveredCount } = recovered7d;
  const atRisk = critical.reduce((s, a) => s + a.dollar_impact, 0);
  const ranked = [...openAlerts].sort((a, b) => a.claude_rank - b.claude_rank);
  const focus = ranked[0];
  // Campaign-aware so a no-campaign SKU alert never recommends "Pause campaign";
  // null means no direct fix — the card offers Review instead.
  const focusActionKind = focus
    ? recommendedAction(focus.detector_id, { hasCampaign: Boolean(focus.campaign) })
    : null;
  const budgetLeft = guardrails
    ? guardrails.daily_action_budget_cents - guardrails.daily_action_budget_used_cents
    : 0;

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

        {/* ===== KPI STRIP ===== */}
        <div className="anx-kpis">
          <div className="anx-kpi">
            <div className="anx-kpi-rail anx-rail-accent" />
            <div className="anx-kpi-body">
              <div className="anx-kpi-top">
                <span className="anx-kpi-label">Blended ROAS</span>
                <span className="anx-kpi-note">{WINDOW_DAYS}-day trend</span>
              </div>
              <div className="anx-kpi-value">{formatRoas(blendedRoas)}</div>
              <Sparkline values={sparkValues} />
              {roasDelta !== null && Math.abs(roasDelta) >= 0.005 ? (
                <div
                  className={
                    roasDelta >= 0 ? "anx-kpi-delta anx-up" : "anx-kpi-delta anx-down"
                  }
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                    {roasDelta >= 0 ? (
                      <path
                        d="M12 19V5M6 11l6-6 6 6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : (
                      <path
                        d="M12 5v14M6 13l6 6 6-6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    )}
                  </svg>
                  {`${formatRoas(Math.abs(roasDelta))} ${roasDelta >= 0 ? "higher" : "lower"} than ${WINDOW_DAYS} days ago`}
                </div>
              ) : (
                <div className="anx-kpi-sub">over the last {WINDOW_DAYS} days</div>
              )}
            </div>
          </div>

          <div className="anx-kpi">
            <div className="anx-kpi-rail anx-rail-muted" />
            <div className="anx-kpi-body">
              <span className="anx-kpi-label">Ad spend</span>
              <div className="anx-kpi-value">{fmtMoney(totalSpendCents)}</div>
              <div className="anx-kpi-sub">
                {campaignCount > 0
                  ? `across ${campaignCount} graded campaign${campaignCount === 1 ? "" : "s"}`
                  : `last ${WINDOW_DAYS} days`}
              </div>
            </div>
          </div>

          <div className="anx-kpi">
            <div className="anx-kpi-rail anx-rail-accent" />
            <div className="anx-kpi-body">
              <span className="anx-kpi-label">Ad-driven revenue</span>
              <div className="anx-kpi-value anx-value-accent">
                {fmtMoney(totalRevenueCents)}
              </div>
              <div className="anx-kpi-sub">attributed by Calderyn</div>
            </div>
          </div>

          <div className="anx-kpi">
            <div className="anx-kpi-rail anx-rail-critical" />
            <div className="anx-kpi-body">
              <span className="anx-kpi-label">Wasted spend</span>
              <div className="anx-kpi-value">{fmtMoney(wastedSpendCents)}</div>
              <div className={breakevenCount > 0 ? "anx-kpi-sub anx-down" : "anx-kpi-sub"}>
                {breakevenCount > 0
                  ? `${breakevenCount} campaign${breakevenCount === 1 ? "" : "s"} below break-even`
                  : "every campaign above break-even"}
              </div>
            </div>
          </div>
        </div>

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
                Return on ad spend across the last {WINDOW_DAYS} days. Higher is better; 1.0x means every dollar in came back as a dollar of revenue.
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
          <div className="anx-card-head">
            <Text as="h2" variant="headingMd">
              Campaign grades
            </Text>
            {grades.length > 0 && (
              <span className="anx-card-note">
                {grades.length} campaign{grades.length === 1 ? "" : "s"} · ranked by ad return
              </span>
            )}
          </div>
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
            <div className="anx-table">
              <div className="anx-grade-head">
                <span>Campaign</span>
                <span>Grade</span>
                <Tooltip content="ROAS — return on ad spend (revenue ÷ ad spend)">
                  <span className="anx-r">Ad return</span>
                </Tooltip>
                <Tooltip content="Break-even — the ad return you need just to not lose money">
                  <span className="anx-r">Break-even</span>
                </Tooltip>
                <span className="anx-r">Spend</span>
                <span className="anx-r">Revenue</span>
              </div>
              {grades.map((g) => {
                const grade = gradeFromRow(g);
                const tone = gradeTone(grade);
                const isLosing = g.break_even_roas > 0 && g.roas < g.break_even_roas;
                return (
                  <div
                    key={g.campaign_id}
                    className="anx-grade-row"
                    data-losing={isLosing}
                  >
                    <span className="anx-grade-name" title={g.name || g.campaign_id}>
                      {g.name || g.campaign_id}
                    </span>
                    <span>
                      <span className={`anx-grade-badge anx-grade-${tone ?? "neutral"}`}>
                        <span className="anx-grade-dot" />
                        {gradeLabel(grade)}
                      </span>
                    </span>
                    <span
                      className="anx-r anx-grade-return"
                      data-losing={isLosing}
                    >
                      {formatRoas(g.roas)}
                    </span>
                    <span className="anx-r anx-grade-be">{formatRoas(g.break_even_roas)}</span>
                    <span className="anx-r anx-grade-spend">{fmtMoneyDec(g.spend_cents)}</span>
                    <span className="anx-r anx-grade-rev">{fmtMoneyDec(g.revenue_cents)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card padding="0">
          <div className="anx-card-head">
            <Text as="h2" variant="headingMd">
              Top ads by engagement
            </Text>
            {topAds.length > 0 && <span className="anx-card-note">last {WINDOW_DAYS} days</span>}
          </div>
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
            (() => {
              const maxEng = Math.max(...topAds.map((a) => a.engagement), 1);
              return (
                <div className="anx-table">
                  <div className="anx-ad-head">
                    <span>Ad</span>
                    <span>Campaign</span>
                    <Tooltip content="Reactions + comments + shares + saves over the window. Hover a row for the breakdown.">
                      <span className="anx-r">Engagement</span>
                    </Tooltip>
                  </div>
                  {topAds.map((a) => {
                    const pct = Math.max(4, Math.round((a.engagement / maxEng) * 100));
                    return (
                      <Tooltip
                        key={a.ad_external_id}
                        content={`${a.reactions.toLocaleString()} reactions · ${a.comments.toLocaleString()} comments · ${a.shares.toLocaleString()} shares · ${a.saves.toLocaleString()} saves`}
                      >
                        <div className="anx-ad-row">
                          <span className="anx-ad-name" title={a.ad_name || a.ad_external_id}>
                            {a.ad_name || a.ad_external_id}
                          </span>
                          <span className="anx-ad-campaign" title={a.campaign_name}>
                            {a.campaign_name}
                          </span>
                          <div className="anx-ad-meter">
                            <div className="anx-ad-bar">
                              <div className="anx-ad-bar-fill" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="anx-ad-value">{a.engagement.toLocaleString()}</span>
                          </div>
                        </div>
                      </Tooltip>
                    );
                  })}
                </div>
              );
            })()
          )}
        </Card>

        {/* ===== At a glance — relocated from the old home page ===== */}
        <Divider />

        <div className="cdn-stat-row">
          <InlineStack gap="400" wrap>
            <Box minWidth="220px">
              <Card>
                <BlockStack gap="150">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Money at risk now
                  </Text>
                  <Text as="p" variant="heading2xl" tone={critical.length ? "critical" : undefined}>
                    {fmtMoney(atRisk)}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    from {openAlerts.length} thing{openAlerts.length === 1 ? "" : "s"} we found
                  </Text>
                </BlockStack>
              </Card>
            </Box>
            <Box minWidth="220px">
              <Card>
                <BlockStack gap="150">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Money we&apos;ve saved you
                  </Text>
                  <Text as="p" variant="heading2xl" tone="success">
                    {fmtMoney(recovered7dCents)}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    last 7 days, across {recoveredCount} fix{recoveredCount === 1 ? "" : "es"}
                  </Text>
                </BlockStack>
              </Card>
            </Box>
            <Box minWidth="220px">
              <Card>
                <BlockStack gap="150">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Budget left today
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {guardrails ? fmtMoney(budgetLeft) : "—"}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {guardrails
                      ? `of ${fmtMoney(guardrails.daily_action_budget_cents)} for fixes Calderyn makes on its own`
                      : "unavailable"}
                  </Text>
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </div>

        {focus && (
          <div className="cdn-card cdn-accent-left cdn-accent-left--primary">
            <BlockStack gap="300">
              <BlockStack gap="150">
                <InlineStack gap="100" blockAlign="center">
                  <span style={{ color: "var(--cdn-success)", display: "inline-flex" }}>
                    <Icon name="spark" size={14} fill />
                  </span>
                  <Text as="span" variant="headingXs" tone="success">
                    TODAY&apos;S FOCUS
                  </Text>
                </InlineStack>
                <Text as="h3" variant="headingMd">
                  {focus.title}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {focusActionKind
                    ? `Recommended: ${ACTION_LABELS[focusActionKind]} · protects `
                    : "Protects "}
                  <Text as="span" tone="success" fontWeight="semibold">
                    {fmtMoney(focus.dollar_impact)}
                  </Text>{" "}
                  / 30d · flagged {fmtRelTime(focus.created_at)}
                </Text>
              </BlockStack>
              <InlineStack gap="200">
                <Button onClick={() => navigate(`/app/alerts/${focus.id}`)}>Review</Button>
                {focusActionKind && (
                  <Button
                    variant="primary"
                    onClick={() => navigate(`/app/alerts/${focus.id}?action=${focusActionKind}`)}
                  >
                    {ACTION_LABELS[focusActionKind]}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </div>
        )}

        <PeerBenchmarksCard data={benchmarks} />
      </BlockStack>
    </Page>
  );
}
