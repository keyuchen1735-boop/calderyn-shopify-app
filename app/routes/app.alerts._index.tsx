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
  ChoiceList,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney } from "~/lib/format";
import type { Alert, AlertStatus, Severity } from "~/lib/types";
import { AlertCard } from "~/components/calderyn";

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
  const navigate = useEmbeddedNavigate();
  const { alerts, error } = useLoaderData<typeof loader>();
  const [severity, setSeverity] = useState<("all" | Severity)[]>(["all"]);
  const [status, setStatus] = useState<("all" | AlertStatus)[]>(["open"]);

  const sev = severity[0];
  const st = status[0];

  const filtered = useMemo(() => {
    const next = alerts.filter((a) => {
      if (sev !== "all" && a.severity !== sev) return false;
      if (st !== "all" && a.status !== st) return false;
      return true;
    });
    return next.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  }, [alerts, sev, st]);

  const openAlerts = alerts.filter((a) => a.status === "open");
  const projectedImpact = openAlerts.reduce((s, a) => s + a.dollar_impact, 0);

  return (
    <Page
      title="Alerts"
      subtitle={`${openAlerts.length} open · ranked by priority · ${fmtMoney(
        projectedImpact,
      )} total projected 30-day impact`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" title="Couldn't load alerts">
            <p>{error.message}</p>
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
                onChange={(v) => setSeverity(v as ("all" | Severity)[])}
              />
              <ChoiceList
                title="Status"
                choices={[
                  { label: "All", value: "all" },
                  { label: "Open", value: "open" },
                  { label: "Acknowledged", value: "acknowledged" },
                  { label: "Resolved", value: "resolved" },
                ]}
                selected={status}
                onChange={(v) => setStatus(v as ("all" | AlertStatus)[])}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {filtered.length === 0 ? (
            <Card>
              <Box padding="400">
                <BlockStack gap="100" inlineAlign="center">
                  <Text as="p" variant="headingMd">
                    {st === "open" ? "All clear" : "Nothing here"}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {st === "open"
                      ? "No open alerts match these filters. Calderyn will surface the next money-losing problem the moment it appears."
                      : "No alerts match these filters."}
                  </Text>
                </BlockStack>
              </Box>
            </Card>
          ) : (
            <BlockStack gap="300">
              {filtered.map((a) => (
                <AlertCard key={a.id} alert={a} onReview={(al) => navigate(`/app/alerts/${al.id}`)} />
              ))}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
