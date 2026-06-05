import { useState } from "react";
import { useLoaderData, useNavigate } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  Box,
  Card,
  DataTable,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
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

  // Sortable numeric columns (index → value). Default: days of cover, ascending
  // (most-at-risk first).
  const SORT_KEYS: Record<number, (s: SKU) => number> = {
    2: (s) => s.on_hand,
    3: (s) => s.days_of_cover,
    4: (s) => s.velocity,
  };
  const [sortIndex, setSortIndex] = useState(3);
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("ascending");

  const sorted = [...skus].sort((a, b) => {
    const key = SORT_KEYS[sortIndex] ?? ((s: SKU) => s.days_of_cover);
    return sortDir === "ascending" ? key(a) - key(b) : key(b) - key(a);
  });

  const rows = sorted.map((s) => {
    const linked = alerts.filter((a) => a.sku === s.id);
    return [
      <Text key={`id-${s.id}`} as="span" fontWeight="semibold">
        {s.id}
      </Text>,
      s.title,
      <Text
        key={`oh-${s.id}`}
        as="span"
        fontWeight="semibold"
        tone={s.on_hand === 0 ? "critical" : s.on_hand < 10 ? "caution" : undefined}
      >
        {(s.on_hand ?? 0).toLocaleString()}
      </Text>,
      <Text
        key={`dc-${s.id}`}
        as="span"
        tone={s.days_of_cover < 2 ? "critical" : undefined}
        fontWeight={s.days_of_cover < 2 ? "semibold" : undefined}
      >
        {(s.days_of_cover ?? 0).toFixed(1)}
      </Text>,
      `${s.velocity ?? 0}/day`,
      <LocationBar key={`loc-${s.id}`} locations={s.locations ?? {}} />,
      linked.length ? (
        <Badge key={`al-${s.id}`} tone="warning">
          {String(linked.length)}
        </Badge>
      ) : (
        "—"
      ),
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
          columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "text", "text"]}
          headings={["SKU", "Title", "On hand", "Days of cover", "Velocity", "Locations", "Alerts"]}
          rows={rows}
          sortable={[false, false, true, true, true, false, false]}
          defaultSortDirection="ascending"
          initialSortColumnIndex={3}
          onSort={(index, direction) => {
            setSortIndex(index);
            setSortDir(direction === "ascending" ? "ascending" : "descending");
          }}
        />
      </Card>
    </Page>
  );
}

/**
 * A compact inventory-by-location bar. Renders whatever locations exist on the
 * SKU — never hardcodes a fixed CA/NJ/TX column set. Zero-stock segments show
 * in a faded critical tone so empty warehouses are obvious at a glance.
 */
function LocationBar({ locations }: { locations: Record<string, number> }) {
  const entries = Object.entries(locations);
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  const palette = ["var(--cdn-info)", "var(--cdn-success)", "var(--cdn-warning)"];
  if (entries.length === 0) {
    return (
      <Text as="span" variant="bodyXs" tone="subdued">
        No locations
      </Text>
    );
  }
  return (
    <InlineStack gap="200" blockAlign="center" wrap={false}>
      <span className="cdn-locbar">
        {entries.map(([loc, v], i) => (
          <span
            key={loc}
            className="cdn-locbar-seg"
            title={`${loc}: ${v}`}
            style={{
              width: `${(v / total) * 100}%`,
              background: v === 0 ? "rgba(215,44,13,0.3)" : palette[i % palette.length],
            }}
          />
        ))}
      </span>
      <Text as="span" variant="bodyXs" tone="subdued">
        <span className="cdn-tnum">{entries.map(([l, v]) => `${l} ${v}`).join(" · ")}</span>
      </Text>
    </InlineStack>
  );
}
