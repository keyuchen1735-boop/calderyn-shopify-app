import { useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Badge, Banner, Box, Card, DataTable, Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import type { Alert, SKU } from "~/lib/types";

type LoaderPayload = {
  skus: SKU[];
  alerts: Alert[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [skus, alerts] = await Promise.all([
      client.skus.list(request.signal),
      client.alerts.list({}, request.signal),
    ]);
    return json<LoaderPayload>({ skus, alerts, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      skus: [],
      alerts: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export default function SKUs() {
  const navigate = useNavigate();
  const { skus, alerts, error } = useLoaderData<typeof loader>();

  const rows = skus.map((s) => {
    const linked = alerts.filter((a) => a.sku === s.id);
    const locations = s.locations ?? {};
    return [
      <Text key={`id-${s.id}`} as="span" fontWeight="semibold">
        {s.id}
      </Text>,
      s.title,
      <Text key={`oh-${s.id}`} as="span" tone={s.on_hand === 0 ? "critical" : undefined}>
        {(s.on_hand ?? 0).toLocaleString()}
      </Text>,
      (s.days_of_cover ?? 0).toFixed(1),
      String(s.velocity ?? 0),
      String(locations["CA-1"] ?? 0),
      String(locations["NJ-1"] ?? 0),
      String(locations["TX-1"] ?? 0),
      linked.length ? <Badge tone="warning">{String(linked.length)}</Badge> : "—",
    ];
  });

  return (
    <Page
      title="SKUs"
      subtitle={`${skus.length} active SKUs synced from Shopify · inventory across locations`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" title="Couldn't load SKUs">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        </Box>
      )}
      <Card padding="0">
        <DataTable
          columnContentTypes={[
            "text",
            "text",
            "numeric",
            "numeric",
            "numeric",
            "numeric",
            "numeric",
            "numeric",
            "text",
          ]}
          headings={[
            "SKU",
            "Title",
            "On hand",
            "Days of cover",
            "Velocity (u/d)",
            "CA-1",
            "NJ-1",
            "TX-1",
            "Alerts",
          ]}
          rows={rows}
        />
      </Card>
    </Page>
  );
}
