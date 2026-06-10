import { useMemo, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  Box,
  Card,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import type { Alert, SKU } from "~/lib/types";

type SortKey = "days_of_cover" | "on_hand" | "velocity" | "title";
type SortDir = "asc" | "desc";

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
  const navigate = useEmbeddedNavigate();
  const { skus, alerts, error } = useLoaderData<typeof loader>();

  const [sortKey, setSortKey] = useState<SortKey>("days_of_cover");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const alertsBySku = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of alerts) {
      if (!a.sku) continue;
      map.set(a.sku, (map.get(a.sku) ?? 0) + 1);
    }
    return map;
  }, [alerts]);

  const sorted = useMemo(() => {
    const compare = (a: SKU, b: SKU) => {
      if (sortKey === "title") return a.title.localeCompare(b.title);
      return (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    };
    const arr = [...skus].sort(compare);
    return sortDir === "asc" ? arr : arr.reverse();
  }, [skus, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "title" ? "asc" : "asc");
    }
  };

  return (
    <Page
      title="Inventory"
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
        <div className="cdn-skutable" role="table" aria-label="SKUs">
          <div className="cdn-skutable__head" role="row">
            <div role="columnheader" className="cdn-skutable__cell">SKU</div>
            <SortHeader
              label="Title"
              active={sortKey === "title"}
              dir={sortDir}
              onClick={() => toggleSort("title")}
            />
            <SortHeader
              label="On hand"
              align="end"
              active={sortKey === "on_hand"}
              dir={sortDir}
              onClick={() => toggleSort("on_hand")}
            />
            <SortHeader
              label="Days of cover"
              align="end"
              active={sortKey === "days_of_cover"}
              dir={sortDir}
              onClick={() => toggleSort("days_of_cover")}
            />
            <SortHeader
              label="Velocity"
              align="end"
              active={sortKey === "velocity"}
              dir={sortDir}
              onClick={() => toggleSort("velocity")}
            />
            <div role="columnheader" className="cdn-skutable__cell">Locations</div>
            <div role="columnheader" className="cdn-skutable__cell cdn-skutable__cell--center">Alerts</div>
          </div>
          {sorted.map((s) => {
            const alertCount = alertsBySku.get(s.id) ?? 0;
            const onHandTone =
              s.on_hand === 0 ? "critical" : s.on_hand < 10 ? "caution" : undefined;
            const cover = s.days_of_cover ?? 0;
            const coverTone = cover < 2 ? "critical" : cover < 7 ? "caution" : undefined;
            return (
              <div key={s.id} className="cdn-skutable__row" role="row">
                <div className="cdn-skutable__cell" role="cell">
                  <SkuId id={s.id} />
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--truncate" role="cell" title={s.title}>
                  <Text as="span" fontWeight="medium">
                    {s.title}
                  </Text>
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--num" role="cell">
                  <Text as="span" fontWeight="semibold" tone={onHandTone}>
                    <span className="cdn-tnum">{(s.on_hand ?? 0).toLocaleString()}</span>
                  </Text>
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--num" role="cell">
                  <Text as="span" fontWeight={coverTone ? "semibold" : undefined} tone={coverTone}>
                    <span className="cdn-tnum">{cover.toFixed(1)}</span>
                  </Text>
                  <Text as="span" tone="subdued"> d</Text>
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--num" role="cell">
                  <Text as="span">
                    <span className="cdn-tnum">{(s.velocity ?? 0).toFixed(1)}</span>
                  </Text>
                  <Text as="span" tone="subdued"> /day</Text>
                </div>
                <div className="cdn-skutable__cell" role="cell">
                  <LocationCell locations={s.locations ?? {}} />
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--center" role="cell">
                  {alertCount ? (
                    <Badge tone="warning">{String(alertCount)}</Badge>
                  ) : (
                    <Text as="span" tone="subdued">—</Text>
                  )}
                </div>
              </div>
            );
          })}
          {sorted.length === 0 && !error && (
            <div className="cdn-skutable__empty">
              <Text as="p" tone="subdued">No SKUs yet. They appear here as soon as Shopify syncs your catalog.</Text>
            </div>
          )}
        </div>
      </Card>
    </Page>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = "start",
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "start" | "end";
}) {
  const arrow = active ? (dir === "asc" ? "▲" : "▼") : "";
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`cdn-skutable__cell cdn-skutable__sort ${
        align === "end" ? "cdn-skutable__cell--num" : ""
      } ${active ? "cdn-skutable__sort--active" : ""}`}
      onClick={onClick}
    >
      <span>{label}</span>
      <span aria-hidden="true" className="cdn-skutable__sort-arrow">{arrow}</span>
    </button>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SkuId({ id }: { id: string }) {
  const isUuid = UUID_RE.test(id);
  const display = isUuid ? id.slice(-6).toUpperCase() : id;
  return (
    <code className="cdn-skuid" title={id}>
      {display}
    </code>
  );
}

function LocationCell({ locations }: { locations: Record<string, number> }) {
  const entries = Object.entries(locations);
  if (entries.length === 0) {
    return (
      <Text as="span" tone="subdued" variant="bodySm">
        No locations
      </Text>
    );
  }
  // Show the top 3 locations by stock (most useful info first), with "+N more"
  // when there are extras. Tooltip lists every location with its exact count.
  const sorted = [...entries].sort(([, a], [, b]) => b - a);
  const visible = sorted.slice(0, 3);
  const hidden = sorted.length - visible.length;
  const fullLabel = sorted.map(([l, v]) => `${l}: ${v.toLocaleString()}`).join("\n");
  return (
    <span className="cdn-loccell-inline" title={fullLabel}>
      {visible.map(([loc, qty], i) => (
        <span key={loc} className="cdn-loccell-item">
          <Text as="span" variant="bodySm" tone="subdued">
            {shortLoc(loc)}{" "}
          </Text>
          <Text
            as="span"
            variant="bodySm"
            tone={qty === 0 ? "critical" : undefined}
            fontWeight={qty === 0 ? "semibold" : undefined}
          >
            <span className="cdn-tnum">{qty.toLocaleString()}</span>
          </Text>
          {i < visible.length - 1 || hidden > 0 ? (
            <Text as="span" variant="bodySm" tone="subdued">
              {" · "}
            </Text>
          ) : null}
        </span>
      ))}
      {hidden > 0 && (
        <Text as="span" variant="bodySm" tone="subdued">
          +{hidden} more
        </Text>
      )}
    </span>
  );
}

function shortLoc(name: string): string {
  const afterDash = name.split(/[—–-]/).pop() ?? name;
  const city = afterDash.split(",")[0]?.trim() || name;
  return city.length > 12 ? city.slice(0, 11) + "…" : city;
}
