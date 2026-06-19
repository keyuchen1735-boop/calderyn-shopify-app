import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { getPeerBenchmarks } from "~/lib/benchmarks/peer-benchmarks.server";
import { PeerBenchmarksCard } from "~/components/calderyn/PeerBenchmarksCard";
import type { PeerBenchmarks } from "~/lib/benchmarks/types";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import { trueRoas } from "~/lib/roas";
import { recoveredWithin } from "~/lib/recovered";
import { ACTION_LABELS, ACTION_VERBS, recommendedAction } from "~/lib/labels";
import type { Alert, AuditEntry, Campaign, GuardrailConfig } from "~/lib/types";
import { autopilotToasts, autopilotFailureLines, type AutopilotDecisionVM } from "~/lib/autopilot-banner";
import {
  AlertCard,
  AmbientAlertBanner,
  GuardrailMeter,
  Icon,
  StatTile,
} from "~/components/calderyn";

type LoaderPayload = {
  alerts: Alert[];
  audit: AuditEntry[];
  campaigns: Campaign[];
  guardrails: GuardrailConfig | null;
  error: { code: string; message: string } | null;
  dashboardLoginUrl: string;
  // Recovered impact over the trailing 7 days — windowed server-side so the
  // "Recovered (7d)" tile matches its label (audit.list returns up to 90d).
  recovered7d: { cents: number; count: number };
  benchmarks: PeerBenchmarks;
};

// Browser-safe shape of /app/autopilot/run's reply (the server AutopilotSummary).
// Only the fields the home page reads — landed `decisions` for the banner lines,
// `acted` to decide whether to revalidate.
type AutopilotRunResult = {
  acted: number;
  decisions: AutopilotDecisionVM[];
  /** Set when the run failed server-side — surfaced quietly, parity with the
   * dashboard's error toast (rule 12: fail visibly). */
  error?: string;
};

const RECOVERED_WINDOW_DAYS = 7;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Carried onto the onboarding redirect below so the embedded iframe keeps its
  // shop/host/embedded params and can re-authenticate on the document request.
  const url = new URL(request.url);

  // Sign-in-with-Shopify entry point of the external merchant dashboard; the
  // merchant's live admin session completes the OAuth round-trip silently.
  const dashboardLoginUrl = `${
    process.env.DASHBOARD_PUBLIC_URL ?? "https://calderyncompany.com"
  }/dashboard/login?shop=${encodeURIComponent(session.shop)}`;

  const client = calderynClient(session.shop);

  // Gate on onboarding FIRST, decisively, and server-side — the old client-side
  // useEffect bump flashed the empty dashboard before redirecting. An unreadable
  // state almost always means the shops row isn't provisioned yet (afterAuth
  // swallows provisioning errors): route to onboarding, which provisions
  // defensively and shows its own error UI, rather than render a broken
  // dashboard. An incomplete state likewise belongs in the wizard. url.search
  // preserves shop/host/embedded so the embedded document request re-auths.
  let onboardingDone: boolean;
  try {
    onboardingDone = (await client.onboarding.getState(request.signal)).done;
  } catch {
    throw redirect(`/app/onboarding${url.search}`);
  }
  if (!onboardingDone) {
    throw redirect(`/app/onboarding${url.search}`);
  }

  // Onboarded: load dashboard data, failing soft (error banner) on a transient
  // error instead of trapping the merchant.
  try {
    const [alerts, audit, campaigns, guardrails, benchmarks] = await Promise.all([
      client.alerts.list({ status: "open" }, request.signal),
      client.audit.list(request.signal),
      client.campaigns.list(request.signal),
      client.guardrails.get(request.signal),
      getPeerBenchmarks(session.shop),
    ]);
    const sinceIso = new Date(
      Date.now() - RECOVERED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    return json<LoaderPayload>({
      alerts,
      audit,
      campaigns,
      guardrails,
      error: null,
      dashboardLoginUrl,
      recovered7d: recoveredWithin(audit, sinceIso),
      benchmarks,
    });
  } catch (err) {
    // Any auth bounce thrown as a Response must propagate, not be misread as a
    // data-load failure.
    if (err instanceof Response) throw err;
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alerts: [],
      audit: [],
      campaigns: [],
      guardrails: null,
      error: { code: e.code ?? "ERROR", message: e.message },
      dashboardLoginUrl,
      recovered7d: { cents: 0, count: 0 },
      benchmarks: { niche: "cat:uncategorized", consented: false, kpis: [] },
    });
  }
};

export default function Dashboard() {
  const navigate = useEmbeddedNavigate();
  const { smDown } = useBreakpoints();
  const {
    alerts,
    audit,
    campaigns,
    guardrails,
    error,
    dashboardLoginUrl,
    recovered7d,
    benchmarks,
  } = useLoaderData<typeof loader>();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // ----- autopilot: act immediately on load (extension parity) -----
  // When autopilot is on, run it the moment the embedded home opens — draining
  // every actionable alert now instead of at the next cron tick. /cron/autopilot
  // is the same engine for when the admin is closed. Fires once per mount; the
  // run is idempotent server-side. Each landed action becomes a line in an info
  // Banner, and a run that changed something revalidates so "Recent actions" and
  // the alert list reflect the new autopilot rows.
  const autopilotEnabled = Boolean(guardrails?.autopilot_enabled);
  const autopilotFetcher = useFetcher<AutopilotRunResult>();
  const revalidator = useRevalidator();
  const autopilotFiredRef = useRef(false);
  const autopilotRevalidatedRef = useRef(false);
  const [autopilotDismissed, setAutopilotDismissed] = useState(false);

  useEffect(() => {
    if (autopilotFiredRef.current || !autopilotEnabled) return;
    autopilotFiredRef.current = true;
    autopilotFetcher.submit(null, { method: "post", action: "/app/autopilot/run" });
  }, [autopilotEnabled, autopilotFetcher]);

  useEffect(() => {
    if (
      autopilotFetcher.state === "idle" &&
      autopilotFetcher.data &&
      ((autopilotFetcher.data.acted ?? 0) > 0 ||
        (autopilotFetcher.data.decisions ?? []).some((d) => d.outcome === "failed")) &&
      !autopilotRevalidatedRef.current
    ) {
      autopilotRevalidatedRef.current = true;
      revalidator.revalidate();
    }
  }, [autopilotFetcher.state, autopilotFetcher.data, revalidator]);

  const autopilotLines = autopilotFetcher.data
    ? autopilotToasts(
        autopilotFetcher.data.decisions ?? [],
        (id) => campaigns.find((c) => c.id === id)?.name ?? "",
      ).map((b) => b.text)
    : [];
  const autopilotFailures = autopilotFetcher.data
    ? autopilotFailureLines(
        autopilotFetcher.data.decisions ?? [],
        (id) => campaigns.find((c) => c.id === id)?.name ?? "",
      )
    : [];
  const autopilotError = autopilotFetcher.data?.error ?? null;

  const openAlerts = alerts.filter((a) => a.status === "open");
  const critical = openAlerts.filter((a) => a.severity === "critical");
  const { cents: recovered7dCents, count: recoveredCount } = recovered7d;
  const atRisk = critical.reduce((s, a) => s + a.dollar_impact, 0);
  const top = [...openAlerts].sort((a, b) => a.claude_rank - b.claude_rank).slice(0, 5);
  const recentAudit = audit.slice(0, 4);

  const focus = top[0];
  // Campaign-aware so a no-campaign SKU alert never recommends "Pause campaign";
  // null means no direct fix — the card offers Review instead (P2-14).
  const focusActionKind = focus
    ? recommendedAction(focus.detector_id, { hasCampaign: Boolean(focus.campaign) })
    : null;

  const reviewAlert = (a: Alert) => navigate(`/app/alerts/${a.id}`);

  const budgetLeft = guardrails
    ? guardrails.daily_action_budget_cents - guardrails.daily_action_budget_used_cents
    : 0;

  return (
    <Page
      title="Calderyn"
      subtitle="Catching money leaks across your ad spend and inventory — before they compound."
      primaryAction={{ content: "All alerts", onAction: () => navigate("/app/alerts") }}
      secondaryActions={[
        { content: "Settings", onAction: () => navigate("/app/settings") },
        // New tab is required: the dashboard sends frame-ancestors 'none', so
        // it cannot render inside the admin iframe. window.open instead of
        // url/external because Polaris's url rendering loses the new-tab
        // intent at two layers in embedded apps (the AppProvider link shim
        // drops `external`; the narrow-viewport rollup menu drops `target`) —
        // see dashboard-link-target.test.ts. App Bridge v4 has no external
        // redirect API; its docs prescribe standard web APIs for this.
        {
          content: "Open web dashboard",
          onAction: () => window.open(dashboardLoginUrl, "_blank", "noopener,noreferrer"),
        },
      ]}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load dashboard data">
            <p>{error.message}</p>
          </Banner>
        )}

        {/* Autopilot just acted on load — one line per landed action (the
            embedded-admin mirror of the dashboard's per-action toasts). */}
        {!autopilotDismissed && autopilotLines.length > 0 && (
          <Banner
            tone="info"
            title={`Autopilot handled ${autopilotLines.length} alert${
              autopilotLines.length === 1 ? "" : "s"
            }`}
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <BlockStack gap="100">
              <BlockStack gap="050">
                {autopilotLines.map((line, i) => (
                  <Text as="p" variant="bodySm" key={`${i}:${line}`}>
                    {line}
                  </Text>
                ))}
              </BlockStack>
              <Button variant="plain" onClick={() => navigate("/app/audit")}>
                View action history
              </Button>
            </BlockStack>
          </Banner>
        )}

        {!autopilotDismissed && autopilotError && (
          <Banner
            tone="warning"
            title="Autopilot couldn't run just now"
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <p>
              {autopilotError} It runs again on your next visit, and the scheduled
              backstop keeps watching.
            </p>
          </Banner>
        )}

        {/* Failed autopilot actions — surfaced so a silent failed run (e.g. a
            disconnected ad platform) reads as a clear signal, not "nothing
            happened". The reason lives in Action history. */}
        {!autopilotDismissed && autopilotFailures.length > 0 && (
          <Banner
            tone="warning"
            title={`Autopilot couldn't finish ${autopilotFailures.length} action${
              autopilotFailures.length === 1 ? "" : "s"
            }`}
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <BlockStack gap="100">
              <BlockStack gap="050">
                {autopilotFailures.map((line, i) => (
                  <Text as="p" variant="bodySm" key={`${i}:${line}`}>
                    {line}
                  </Text>
                ))}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Often a disconnected ad platform — check the connection in Settings.
              </Text>
              <Button variant="plain" onClick={() => navigate("/app/audit")}>
                View action history
              </Button>
            </BlockStack>
          </Banner>
        )}

        {/* The "Today's focus" card below is the single hero CTA when an alert is
            in focus; showing the critical banner too would stack two near-identical
            Review actions. Only surface the banner when there's no focus card. */}
        {!bannerDismissed && !focus && (
          <AmbientAlertBanner
            criticalCount={critical.length}
            atRiskCents={atRisk}
            onReview={() => navigate("/app/alerts")}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}

        {/* Stat row */}
        <div className="cdn-stat-row">
          <InlineGrid columns={{ xs: 2, sm: 2, md: 4 }} gap="400">
            <StatTile
              label="Open alerts"
              value={String(openAlerts.length)}
              tone={critical.length ? "critical" : undefined}
              caption={critical.length ? `${critical.length} critical` : "all clear of critical"}
              onClick={() => navigate("/app/alerts")}
            />
            <StatTile
              label="Recovered (7d)"
              value={fmtMoney(recovered7dCents)}
              tone="success"
              caption={`across ${recoveredCount} action${recoveredCount === 1 ? "" : "s"}`}
              onClick={() => navigate("/app/audit")}
            />
            <StatTile
              label="Daily action budget"
              caption={guardrails ? `${fmtMoney(budgetLeft)} left today` : "unavailable"}
              onClick={() => navigate("/app/settings")}
            >
              {guardrails && (
                <GuardrailMeter
                  usedCents={guardrails.daily_action_budget_used_cents}
                  totalCents={guardrails.daily_action_budget_cents}
                  compact
                />
              )}
            </StatTile>
            <StatTile
              label="Real ad return (7d)"
              value={trueRoas(campaigns)}
              caption="margin-adjusted ROAS, all campaigns"
              onClick={() => navigate("/app/campaigns")}
            />
          </InlineGrid>
        </div>

        {/* Peer Benchmarks */}
        <PeerBenchmarksCard data={benchmarks} />

        {/* Today's focus */}
        {focus && (
          <div className="cdn-card cdn-accent-left cdn-accent-left--primary">
            {(() => {
              const textBlock = (
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
                    / 30d
                  </Text>
                </BlockStack>
              );
              const buttons = [
                <Button
                  key="review"
                  variant={focusActionKind ? undefined : "primary"}
                  fullWidth={smDown}
                  onClick={() => navigate(`/app/alerts/${focus.id}`)}
                >
                  Review
                </Button>,
                focusActionKind ? (
                  <Button
                    key="act"
                    variant="primary"
                    fullWidth={smDown}
                    onClick={() => navigate(`/app/alerts/${focus.id}?action=${focusActionKind}`)}
                  >
                    {ACTION_LABELS[focusActionKind]}
                  </Button>
                ) : null,
              ];
              return smDown ? (
                <BlockStack gap="300">
                  {textBlock}
                  <BlockStack gap="200">{buttons}</BlockStack>
                </BlockStack>
              ) : (
                <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
                  {textBlock}
                  <InlineStack gap="200" wrap={false}>{buttons}</InlineStack>
                </InlineStack>
              );
            })()}
          </div>
        )}

        {/* Two columns */}
        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Tooltip content="Ranked by estimated dollar impact, severity, and how recently the problem appeared.">
                  <Text as="h2" variant="headingSm">
                    Top alerts — ranked by priority
                  </Text>
                </Tooltip>
                <Button variant="plain" onClick={() => navigate("/app/alerts")}>
                  View all
                </Button>
              </InlineStack>
              {top.length === 0 ? (
                <Card>
                  <Box padding="400">
                    {/* A shop with no alerts AND no action history is almost
                        certainly a fresh install whose first scan hasn't
                        finished — "All clear" there reads as "the app does
                        nothing". Show a syncing state instead. Not on a loader
                        error, though: the empty arrays are the failure, not a
                        fresh install. */}
                    {audit.length === 0 && !error ? (
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="p" variant="headingMd">
                          First scan in progress
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Calderyn is analyzing your orders, inventory, and ad spend. Alerts
                          appear here as detections complete — usually within a few hours of
                          setup.
                        </Text>
                      </BlockStack>
                    ) : (
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="p" variant="headingMd">
                          All clear
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          You&apos;ve cleared everything Calderyn is watching. We&apos;ll surface
                          the next problem the moment it appears.
                        </Text>
                      </BlockStack>
                    )}
                  </Box>
                </Card>
              ) : (
                <BlockStack gap="300">
                  {top.map((a) => (
                    <AlertCard key={a.id} alert={a} onReview={reviewAlert} compact />
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingSm">
                  Recent actions
                </Text>
                <Button variant="plain" onClick={() => navigate("/app/audit")}>
                  Action history
                </Button>
              </InlineStack>
              <Card padding="0">
                {recentAudit.length === 0 ? (
                  <Box padding="400">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Nothing yet. Execute an alert recommendation or pause a campaign to start.
                    </Text>
                  </Box>
                ) : (
                  <BlockStack gap="0">
                    {recentAudit.map((a, i) => (
                      <Box
                        key={a.id}
                        padding="300"
                        borderColor="border"
                        borderBlockStartWidth={i === 0 ? undefined : "025"}
                      >
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <span
                            className={`cdn-check ${
                              a.outcome === "succeeded" ? "cdn-check--ok" : "cdn-check--no"
                            }`}
                          >
                            <Icon
                              name={a.outcome === "succeeded" ? "check" : "x"}
                              size={12}
                              strokeWidth={2.4}
                            />
                          </span>
                          <BlockStack gap="050">
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {ACTION_VERBS[a.action_kind]}{" "}
                              <Text as="span" tone="subdued" fontWeight="regular">
                                · {a.target}
                              </Text>
                            </Text>
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="bodyXs" tone="subdued">
                                {fmtRelTime(a.created_at)}
                              </Text>
                              {a.dollar_impact_at_exec > 0 && (
                                <Text as="span" variant="bodyXs" tone="success" fontWeight="semibold">
                                  +{fmtMoney(a.dollar_impact_at_exec)}
                                </Text>
                              )}
                              {a.undo_eligible && !a.undo_of && (
                                <Form method="post" action="/app/audit">
                                  <input type="hidden" name="intent" value="undo" />
                                  <input type="hidden" name="auditId" value={a.id} />
                                  <Button submit variant="plain" size="micro">
                                    Undo
                                  </Button>
                                </Form>
                              )}
                            </InlineStack>
                          </BlockStack>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
