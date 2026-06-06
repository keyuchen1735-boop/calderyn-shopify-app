import { useEffect, useState } from "react";
import { Form, useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import { ACTION_LABELS, ACTION_VERBS, DETECTOR_TO_ACTIONS } from "~/lib/labels";
import type { Alert, AuditEntry, Campaign, GuardrailConfig } from "~/lib/types";
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
  onboardingDone: boolean;
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [alerts, audit, campaigns, guardrails, onboarding] = await Promise.all([
      client.alerts.list({ status: "open" }, request.signal),
      client.audit.list(request.signal),
      client.campaigns.list(request.signal),
      client.guardrails.get(request.signal),
      client.onboarding.getState(request.signal),
    ]);
    return json<LoaderPayload>({
      alerts,
      audit,
      campaigns,
      guardrails,
      onboardingDone: onboarding.done,
      error: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alerts: [],
      audit: [],
      campaigns: [],
      guardrails: null,
      onboardingDone: true,
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

/** Spend-weighted, margin-adjusted blended ROAS — the "true" return on ad spend. */
function trueRoas(campaigns: Campaign[]): string {
  const withData = campaigns.filter(
    (c) => c.spend_7d > 0 && c.roas_7d > 0 && c.contribution_margin > 0,
  );
  const totalSpend = withData.reduce((s, c) => s + c.spend_7d, 0);
  if (totalSpend === 0) return "—";
  const weighted = withData.reduce(
    (s, c) => s + c.spend_7d * c.roas_7d * c.contribution_margin,
    0,
  );
  return `${(weighted / totalSpend).toFixed(1)}×`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { alerts, audit, campaigns, guardrails, onboardingDone, error } =
    useLoaderData<typeof loader>();
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    if (!onboardingDone) navigate("/app/onboarding");
  }, [onboardingDone, navigate]);

  const openAlerts = alerts.filter((a) => a.status === "open");
  const critical = openAlerts.filter((a) => a.severity === "critical");
  const succeeded = audit.filter((a) => a.outcome === "succeeded" && !a.undo_of);
  const recovered7d = succeeded.reduce((s, a) => s + (a.dollar_impact_at_exec || 0), 0);
  const atRisk = critical.reduce((s, a) => s + a.dollar_impact, 0);
  const top = [...openAlerts].sort((a, b) => a.claude_rank - b.claude_rank).slice(0, 5);
  const recentAudit = audit.slice(0, 4);

  const focus = top[0];
  const focusActionKind = focus
    ? (DETECTOR_TO_ACTIONS[focus.detector_id]?.[0] ?? "snooze_alert")
    : null;

  const reviewAlert = (a: Alert) => navigate(`/app/alerts/${a.id}`);

  const budgetLeft = guardrails
    ? guardrails.daily_action_budget_cents - guardrails.daily_action_budget_used_cents
    : 0;

  return (
    <Page
      title="Calderyn"
      subtitle="Watching ad spend and inventory — together."
      primaryAction={{ content: "All alerts", onAction: () => navigate("/app/alerts") }}
      secondaryActions={[{ content: "Settings", onAction: () => navigate("/app/settings") }]}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load dashboard data">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}

        {!bannerDismissed && (
          <AmbientAlertBanner
            criticalCount={critical.length}
            atRiskCents={atRisk}
            onReview={() => navigate("/app/alerts")}
            onDismiss={() => setBannerDismissed(true)}
          />
        )}

        {/* Stat row */}
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatTile
            label="Open alerts"
            value={String(openAlerts.length)}
            tone={critical.length ? "critical" : undefined}
            caption={critical.length ? `${critical.length} critical` : "all clear of critical"}
            onClick={() => navigate("/app/alerts")}
          />
          <StatTile
            label="Recovered (7d)"
            value={fmtMoney(recovered7d)}
            tone="success"
            caption={`across ${succeeded.length} action${succeeded.length === 1 ? "" : "s"}`}
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

        {/* Today's focus */}
        {focus && focusActionKind && (
          <div className="cdn-card cdn-accent-left cdn-accent-left--primary">
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
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
                  Recommended: {ACTION_LABELS[focusActionKind]} · protects{" "}
                  <Text as="span" tone="success" fontWeight="semibold">
                    {fmtMoney(focus.dollar_impact)}
                  </Text>{" "}
                  / 30d
                </Text>
              </BlockStack>
              <InlineStack gap="200" wrap={false}>
                <Button onClick={() => navigate(`/app/alerts/${focus.id}`)}>Review</Button>
                <Button
                  variant="primary"
                  onClick={() => navigate(`/app/alerts/${focus.id}?action=${focusActionKind}`)}
                >
                  {ACTION_LABELS[focusActionKind]}
                </Button>
              </InlineStack>
            </InlineStack>
          </div>
        )}

        {/* Two columns */}
        <Layout>
          <Layout.Section>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingSm">
                  Top alerts — ranked by Claude
                </Text>
                <Button variant="plain" onClick={() => navigate("/app/alerts")}>
                  View all
                </Button>
              </InlineStack>
              {top.length === 0 ? (
                <Card>
                  <Box padding="400">
                    <BlockStack gap="100" inlineAlign="center">
                      <Text as="p" variant="headingMd">
                        All clear
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        You&apos;ve cleared everything Calderyn is watching. We&apos;ll surface the
                        next problem the moment it appears.
                      </Text>
                    </BlockStack>
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
                  Audit log
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
