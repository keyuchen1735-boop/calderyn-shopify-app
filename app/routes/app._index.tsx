import { useEffect } from "react";
import { Link as RemixLink, useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
  Badge,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import { ACTION_VERBS, DETECTOR_LABELS } from "~/lib/labels";
import type { Alert, AuditEntry, GuardrailConfig } from "~/lib/types";

type LoaderPayload = {
  alerts: Alert[];
  audit: AuditEntry[];
  guardrails: GuardrailConfig | null;
  onboardingDone: boolean;
  trueRoas: number | null;
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [alerts, audit, guardrails, onboarding, summary] = await Promise.all([
      client.alerts.list({ status: "open" }, request.signal),
      client.audit.list(request.signal),
      client.guardrails.get(request.signal),
      client.onboarding.getState(request.signal),
      client.analytics.summary(7).catch(() => null),
    ]);
    return json<LoaderPayload>({
      alerts,
      audit,
      guardrails,
      onboardingDone: onboarding.done,
      trueRoas: summary?.account_roas ?? null,
      error: null,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alerts: [],
      audit: [],
      guardrails: null,
      onboardingDone: true,
      trueRoas: null,
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { alerts, audit, guardrails, onboardingDone, trueRoas, error } = useLoaderData<typeof loader>();

  useEffect(() => {
    if (!onboardingDone) navigate("/app/onboarding");
  }, [onboardingDone, navigate]);

  const openAlerts = alerts.filter((a) => a.status === "open");
  const critical = openAlerts.filter((a) => a.severity === "critical");
  const recovered7d = audit
    .filter((a) => a.outcome === "succeeded" && !a.undo_of)
    .reduce((s, a) => s + (a.dollar_impact_at_exec || 0), 0);
  const top = [...openAlerts].sort((a, b) => a.claude_rank - b.claude_rank).slice(0, 5);
  const recentAudit = audit.slice(0, 4);

  return (
    <Page
      title="Calderyn"
      subtitle="Watching ad spend and inventory · live data from Calderyn engine"
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

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <StatCard
            label="Open alerts"
            value={String(openAlerts.length)}
            tone={critical.length ? "critical" : undefined}
            caption={`${critical.length} critical`}
            to="/app/alerts"
          />
          <StatCard
            label="Recovered (7d)"
            value={fmtMoney(recovered7d)}
            caption="across executed actions"
            tone="success"
            to="/app/audit"
          />
          {guardrails ? (
            <StatCard
              label="Daily action budget"
              value={`${fmtMoney(guardrails.daily_action_budget_used_cents)} / ${fmtMoney(guardrails.daily_action_budget_cents)}`}
              caption={`${
                guardrails.daily_action_budget_cents > 0
                  ? Math.round(
                      (guardrails.daily_action_budget_used_cents / guardrails.daily_action_budget_cents) * 100,
                    )
                  : 0
              }% used today`}
              to="/app/settings"
            />
          ) : (
            <StatCard
              label="Daily action budget"
              value="—"
              caption="unavailable"
              to="/app/settings"
            />
          )}
          <StatCard
            label="True ROAS (7d)"
            value={trueRoas != null ? trueRoas.toFixed(2) : "—"}
            caption="margin-adjusted"
            to="/app/campaigns"
          />
        </InlineGrid>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    Top alerts — ranked by Claude
                  </Text>
                  <Button variant="plain" onClick={() => navigate("/app/alerts")}>
                    See all
                  </Button>
                </InlineStack>
                <BlockStack gap="0">
                  {top.length === 0 ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      No open alerts. Calderyn is watching.
                    </Text>
                  ) : (
                    top.map((a) => (
                      <Box
                        key={a.id}
                        padding="300"
                        borderColor="border"
                        borderBlockStartWidth="025"
                      >
                        <InlineStack align="space-between" blockAlign="start" gap="400">
                          <BlockStack gap="100">
                            <RemixLink to={`/app/alerts/${a.id}`} style={{ textDecoration: "none", color: "inherit" }}>
                              <Text as="p" variant="bodyMd" fontWeight="semibold">
                                {a.title}
                              </Text>
                            </RemixLink>
                            <InlineStack gap="200">
                              <Badge tone={a.severity === "critical" ? "critical" : a.severity === "high" ? "warning" : "attention"}>
                                {a.severity}
                              </Badge>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {DETECTOR_LABELS[a.detector_id]} · {fmtRelTime(a.created_at)}
                              </Text>
                            </InlineStack>
                          </BlockStack>
                          <Text as="span" variant="headingMd" alignment="end">
                            {fmtMoney(a.dollar_impact)}
                          </Text>
                        </InlineStack>
                      </Box>
                    ))
                  )}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingSm">
                    Recent actions
                  </Text>
                  <Button variant="plain" onClick={() => navigate("/app/audit")}>
                    Audit log
                  </Button>
                </InlineStack>
                {recentAudit.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Nothing yet. Execute an alert recommendation or pause a campaign to start.
                  </Text>
                ) : (
                  <BlockStack gap="200">
                    {recentAudit.map((a) => (
                      <InlineStack key={a.id} align="space-between">
                        <BlockStack gap="050">
                          <Text as="p" variant="bodySm" fontWeight="semibold">
                            {ACTION_VERBS[a.action_kind]}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {a.target} · {fmtRelTime(a.created_at)}
                          </Text>
                        </BlockStack>
                        <Text as="span" variant="bodySm" fontWeight="semibold">
                          {fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
                        </Text>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function StatCard({
  label,
  value,
  caption,
  tone,
  to,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: "critical" | "success";
  to?: string;
}) {
  const navigate = useNavigate();
  const inner = (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="heading2xl" tone={tone}>
          {value}
        </Text>
        {caption && (
          <Text as="p" variant="bodySm" tone="subdued">
            {caption}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
  if (!to) return inner;
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      aria-label={`${label}: ${value}. Go to ${to}`}
      style={{
        all: "unset",
        display: "block",
        width: "100%",
        cursor: "pointer",
        borderRadius: 8,
      }}
    >
      {inner}
    </button>
  );
}
