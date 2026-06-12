import { useMemo, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Banner,
  BlockStack,
  Box,
  Card,
  InlineStack,
  Page,
  ResourceItem,
  ResourceList,
  Tabs,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import type { Alert, AlertStatus, Severity } from "~/lib/types";
import { DetectorTag, SeverityBadge } from "~/components/calderyn";

// Triage order: criticals first, then down. The page groups by this so a
// merchant sees "I have 2 fires" before scrolling a wall.
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SEV_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Status is the only filter (severity is handled by the grouping below), surfaced
// as a compact tab bar so the alerts themselves are the first thing on screen.
const STATUS_TABS: { id: AlertStatus | "all"; content: string }[] = [
  { id: "open", content: "Open" },
  { id: "acknowledged", content: "Acknowledged" },
  { id: "resolved", content: "Resolved" },
  { id: "all", content: "All" },
];

type LoaderPayload = {
  alerts: Alert[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const alerts = await client.alerts.list({}, request.signal);
    return json<LoaderPayload>({ alerts, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      alerts: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export default function AlertList() {
  const navigate = useEmbeddedNavigate();
  const { alerts, error } = useLoaderData<typeof loader>();
  const [statusIdx, setStatusIdx] = useState(0); // default: Open
  const status = STATUS_TABS[statusIdx].id;

  const visible = useMemo(
    () => alerts.filter((a) => status === "all" || a.status === status),
    [alerts, status],
  );

  // One section per severity that has alerts, each sorted by Claude's rank.
  const groups = useMemo(
    () =>
      SEVERITIES.map((sev) => {
        const items = visible
          .filter((a) => a.severity === sev)
          .sort((a, b) => a.claude_rank - b.claude_rank);
        return {
          sev,
          items,
          impact: items.reduce((s, a) => s + a.dollar_impact, 0),
        };
      }).filter((g) => g.items.length > 0),
    [visible],
  );

  const totalImpact = visible.reduce((s, a) => s + a.dollar_impact, 0);
  const review = (a: Alert) => navigate(`/app/alerts/${a.id}`);

  return (
    <Page
      fullWidth
      title="Alerts"
      subtitle="Ranked by priority — clear the criticals first."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load alerts">
            <p>{error.message}</p>
          </Banner>
        )}

        <Card padding="0">
          <Tabs tabs={STATUS_TABS} selected={statusIdx} onSelect={setStatusIdx} />
        </Card>

        {/* Summary strip — per-severity counts + total at risk, reflecting the
            active status tab. Reads faster than a sentence. */}
        {visible.length > 0 && (
          <Box paddingInlineStart="100">
            <InlineStack gap="300" blockAlign="center" wrap>
              {groups.map((g) => (
                <Text
                  key={g.sev}
                  as="span"
                  variant="bodySm"
                  tone={g.sev === "critical" ? "critical" : "subdued"}
                >
                  <Text as="span" fontWeight="semibold">
                    {g.items.length}
                  </Text>{" "}
                  {SEV_LABEL[g.sev].toLowerCase()}
                </Text>
              ))}
              <Text as="span" variant="bodySm" tone="subdued">
                ·
              </Text>
              <Text as="span" variant="bodySm" fontWeight="semibold">
                {fmtMoney(totalImpact)} at risk
              </Text>
            </InlineStack>
          </Box>
        )}

        {groups.length === 0 ? (
          <Card>
            <Box padding="400">
              <BlockStack gap="100" inlineAlign="center">
                <Text as="p" variant="headingMd">
                  {status === "open" ? "All clear" : "Nothing here"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {status === "open"
                    ? "No open alerts. Calderyn will surface the next money-losing problem the moment it appears."
                    : "No alerts match this filter."}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        ) : (
          <BlockStack gap="400">
            {groups.map((g) => (
              <Card key={g.sev} padding="0">
                <Box
                  padding="300"
                  paddingInlineStart="400"
                  paddingInlineEnd="400"
                  borderBlockEndWidth="025"
                  borderColor="border"
                >
                  <InlineStack gap="200" blockAlign="center">
                    <SeverityBadge severity={g.sev} />
                    <Text as="h2" variant="headingSm">
                      {g.items.length} {SEV_LABEL[g.sev]}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      · {fmtMoney(g.impact)} at risk
                    </Text>
                  </InlineStack>
                </Box>
                <ResourceList
                  resourceName={{ singular: "alert", plural: "alerts" }}
                  items={g.items}
                  renderItem={(a) => (
                    <ResourceItem
                      id={a.id}
                      onClick={() => review(a)}
                      accessibilityLabel={`Review ${a.title}`}
                    >
                      <InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="semibold">
                            {a.title}
                          </Text>
                          <InlineStack gap="150" blockAlign="center">
                            <DetectorTag detectorId={a.detector_id} />
                            <Text as="span" variant="bodyXs" tone="subdued">
                              {fmtRelTime(a.created_at)}
                            </Text>
                          </InlineStack>
                        </BlockStack>
                        <Box minWidth="120px">
                          <Text as="span" alignment="end" variant="headingSm" tone="critical">
                            <span className="cdn-tnum">{fmtMoney(a.dollar_impact)}</span>
                          </Text>
                        </Box>
                      </InlineStack>
                    </ResourceItem>
                  )}
                />
              </Card>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Page>
  );
}
