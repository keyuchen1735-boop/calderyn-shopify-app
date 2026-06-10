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
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { Icon } from "~/components/calderyn";
import type { Alert, SKU } from "~/lib/types";
import { isUuid } from "~/lib/ids";

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

/** A SKU with no recent sales has no meaningful velocity or days-of-cover
 * (the engine caps cover at 999 in that case). */
const hasSales = (s: SKU) => (s.velocity ?? 0) > 0;

export default function SKUs() {
  const navigate = useEmbeddedNavigate();
  const { skus, alerts, error } = useLoaderData<typeof loader>();

  const [sortKey, setSortKey] = useState<SortKey>("days_of_cover");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [query, setQuery] = useState("");

  const alertsBySku = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of alerts) {
      if (!a.sku) continue;
      map.set(a.sku, (map.get(a.sku) ?? 0) + 1);
    }
    return map;
  }, [alerts]);

  const totalUnits = useMemo(
    () => skus.reduce((sum, s) => sum + (s.on_hand ?? 0), 0),
    [skus],
  );

  const attentionCount = useMemo(
    () =>
      skus.filter(
        (s) =>
          (alertsBySku.get(s.id) ?? 0) > 0 ||
          (s.on_hand ?? 0) === 0 ||
          (hasSales(s) && (s.days_of_cover ?? 0) < 7),
      ).length,
    [skus, alertsBySku],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
    );
  }, [skus, query]);

  const sorted = useMemo(() => {
    const compare = (a: SKU, b: SKU) => {
      if (sortKey === "title") return a.title.localeCompare(b.title);
      return (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
    };
    const arr = [...filtered].sort(compare);
    return sortDir === "asc" ? arr : arr.reverse();
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const countLabel = query.trim()
    ? `${sorted.length} of ${skus.length} SKUs`
    : `${skus.length} SKUs`;

  return (
    <Page
      title="Inventory"
      titleMetadata={<ShopifySourcePill />}
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
        <Box
          padding="300"
          paddingInlineStart="400"
          paddingInlineEnd="400"
          borderBlockEndWidth="025"
          borderColor="border"
        >
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <InlineStack gap="100" blockAlign="baseline" wrap={false}>
              <Text as="span" fontWeight="semibold">
                {countLabel}
              </Text>
              <Text as="span" tone="subdued">
                · {totalUnits.toLocaleString()} units on hand
              </Text>
              {attentionCount > 0 && (
                <Text as="span" tone="caution" fontWeight="medium">
                  · {attentionCount} need attention
                </Text>
              )}
            </InlineStack>
            <div style={{ minWidth: 220, maxWidth: 280, flexGrow: 1 }}>
              <TextField
                label="Search SKUs"
                labelHidden
                autoComplete="off"
                placeholder="Search by product or SKU"
                value={query}
                onChange={setQuery}
                clearButton
                onClearButtonClick={() => setQuery("")}
                prefix={<Icon name="search" size={14} strokeWidth={2} />}
              />
            </div>
          </InlineStack>
        </Box>
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
            const selling = hasSales(s);
            const onHandTone =
              s.on_hand === 0 ? "critical" : s.on_hand < 10 ? "caution" : undefined;
            const cover = s.days_of_cover ?? 0;
            const coverTone = selling
              ? cover < 2
                ? "critical"
                : cover < 7
                  ? "caution"
                  : undefined
              : undefined;
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
                  {selling ? (
                    <>
                      <Text as="span" fontWeight={coverTone ? "semibold" : undefined} tone={coverTone}>
                        <span className="cdn-tnum">{cover.toFixed(1)}</span>
                      </Text>
                      <Text as="span" tone="subdued"> d</Text>
                    </>
                  ) : (
                    <span title="No recent sales, so days of cover isn't meaningful">
                      <Text as="span" tone="subdued">—</Text>
                    </span>
                  )}
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--num" role="cell">
                  {selling ? (
                    <>
                      <Text as="span">
                        <span className="cdn-tnum">{(s.velocity ?? 0).toFixed(1)}</span>
                      </Text>
                      <Text as="span" tone="subdued"> /day</Text>
                    </>
                  ) : (
                    <Text as="span" tone="subdued" variant="bodySm">
                      No sales
                    </Text>
                  )}
                </div>
                <div className="cdn-skutable__cell" role="cell">
                  <LocationCell locations={s.locations ?? {}} />
                </div>
                <div className="cdn-skutable__cell cdn-skutable__cell--center" role="cell">
                  {alertCount > 0 && <Badge tone="warning">{String(alertCount)}</Badge>}
                </div>
              </div>
            );
          })}
          {sorted.length === 0 && !error && (
            <div className="cdn-skutable__empty">
              <Text as="p" tone="subdued">
                {query.trim()
                  ? `No SKUs match "${query.trim()}".`
                  : "No SKUs yet. They appear here as soon as Shopify syncs your catalog."}
              </Text>
            </div>
          )}
        </div>
      </Card>
    </Page>
  );
}

/** Official Shopify glyph (Simple Icons, CC0). Marks where SKU data syncs from. */
function ShopifySourcePill() {
  return (
    <span className="cdn-source-pill">
      <svg
        className="cdn-source-pill__glyph"
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z" />
      </svg>
      Synced from Shopify
    </span>
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

function SkuId({ id }: { id: string }) {
  const display = isUuid(id) ? id.slice(-6).toUpperCase() : id;
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
