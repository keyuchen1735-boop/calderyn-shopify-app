import { useMemo, useState } from "react";
import { useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  ChoiceList,
  InlineStack,
  Layout,
  Page,
  Text,
  Badge,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime } from "~/lib/format";
import { DETECTOR_LABELS } from "~/lib/labels";
import type { Alert, Severity } from "~/lib/types";

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

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
  const navigate = useNavigate();
  const { alerts, error } = useLoaderData<typeof loader>();
  const [severity, setSeverity] = useState<("all" | Severity)[]>(["all"]);
  const [status, setStatus] = useState<("open" | "all")[]>(["open"]);

  const sev = severity[0];
  const st = status[0];

  const filtered = useMemo(() => {
    let next = alerts.filter((a) => {
      if (sev !== "all" && a.severity !== sev) return false;
      if (st === "open" && a.status !== "open") return false;
      return true;
    });
    return next.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }, [alerts, sev, st]);

  return (
    <Page
      title="Alerts"
      subtitle={`${filtered.length} alerts · ranked by Claude · dollar impact reflects 30-day projection`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" title="Couldn't load alerts">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        </Box>
      )}
      <Layout>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <ChoiceList
                title="Severity"
                choices={[
                  { label: "All", value: "all" },
                  { label: "Critical", value: "critical" },
                  { label: "High", value: "high" },
                  { label: "Medium", value: "medium" },
                  { label: "Low", value: "low" },
                ]}
                selected={severity}
                onChange={(v) => setSeverity(v as any)}
              />
              <ChoiceList
                title="Status"
                choices={[
                  { label: "Open only", value: "open" },
                  { label: "All", value: "all" },
                ]}
                selected={status}
                onChange={(v) => setStatus(v as any)}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <BlockStack gap="0">
              {filtered.length === 0 ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    No alerts match the current filters.
                  </Text>
                </Box>
              ) : (
                filtered.map((a) => (
                  <Box
                    key={a.id}
                    padding="400"
                    borderColor="border"
                    borderBlockStartWidth="025"
                    background="bg-surface"
                  >
                    <InlineStack align="space-between" blockAlign="start" gap="400">
                      <BlockStack gap="100">
                        <Button
                          variant="plain"
                          textAlign="left"
                          onClick={() => navigate(`/app/alerts/${a.id}`)}
                        >
                          {a.title}
                        </Button>
                        <InlineStack gap="200">
                          <Badge
                            tone={
                              a.severity === "critical"
                                ? "critical"
                                : a.severity === "high"
                                  ? "warning"
                                  : "attention"
                            }
                          >
                            {a.severity}
                          </Badge>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {DETECTOR_LABELS[a.detector_id]} · {fmtRelTime(a.created_at)}
                          </Text>
                          {a.status !== "open" && <Badge>{a.status}</Badge>}
                        </InlineStack>
                      </BlockStack>
                      <Text as="span" variant="headingMd">
                        {fmtMoney(a.dollar_impact)}
                      </Text>
                    </InlineStack>
                  </Box>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
