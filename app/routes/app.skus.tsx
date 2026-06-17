import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Modal,
  Page,
  Popover,
  Select,
  Text,
  TextField,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { CalderynError, calderynClient } from "~/lib/calderyn.server";
import {
  executeInventoryRelocation,
  RelocationError,
} from "~/lib/actions/inventory-relocate.server";
import {
  executeInventoryAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { useActionToast, type ActionToast } from "~/lib/toast";
import { Icon } from "~/components/calderyn";
import { BrandGlyph } from "~/components/calderyn/brand-icons";
import type { Alert, ShopLocation, SKU, SkuAffinityItem } from "~/lib/types";
import { isUuid } from "~/lib/ids";
import { fmtMoney } from "~/lib/format";
import {
  inventoryAlertActions,
  openAlertsBySku,
} from "~/lib/inventory-alerts";
import { formatDemandUnits } from "~/lib/inventory-demand";
import { shipCostBadge } from "~/lib/ship-cost/provenance";
import { ShipPnlText } from "~/components/calderyn/ship-pnl-text";

function ShipCostBadge({
  source,
  confidence,
}: {
  source: SKU["ship_cost_source"];
  confidence: SKU["ship_cost_confidence"];
}) {
  const badge = shipCostBadge(source);
  if (!badge) {
    return (
      <Text as="span" tone="subdued" variant="bodySm">
        —
      </Text>
    );
  }
  return (
    <Tooltip content={`Source: ${badge.label}${confidence ? ` · confidence ${confidence}` : ""}`}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </Tooltip>
  );
}

type SortKey = "days_of_cover" | "on_hand" | "velocity" | "title";
type SortDir = "asc" | "desc";

type LoaderPayload = {
  skus: SKU[];
  alerts: Alert[];
  locations: ShopLocation[];
  error: { code: string; message: string } | null;
};

export type RelocatePayload = ActionToast & {
  error?: { code: string; message: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [skus, alerts, locations] = await Promise.all([
      client.skus.list(request.signal),
      client.alerts.list({}, request.signal),
      client.locations.list(request.signal),
    ]);
    return json<LoaderPayload>({ skus, alerts, locations, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      skus: [],
      alerts: [],
      locations: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  // Per-row alert actions share the relocate route; everything that drives
  // the mutation is re-derived server-side from the shop-scoped alert.
  if (String(formData.get("intent") ?? "") === "alert_action") {
    return alertAction(formData, session.shop, admin, request.signal);
  }

  // Boundary validation — never trust the modal's FormData (repo rule).
  const skuId = String(formData.get("sku_id") ?? "").trim();
  const fromLocationId = String(formData.get("from_location_id") ?? "").trim();
  const toLocationId = String(formData.get("to_location_id") ?? "").trim();
  const qtyRaw = String(formData.get("quantity") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();

  if (
    !skuId ||
    !fromLocationId ||
    !toLocationId ||
    !idempotencyKey ||
    !/^\d+$/.test(qtyRaw) ||
    Number(qtyRaw) <= 0
  ) {
    return json<RelocatePayload>(
      {
        ok: false,
        error: { code: "INVALID_INPUT", message: "Quantity must be a positive whole number." },
        toast: { message: "Quantity must be a positive whole number.", isError: true },
      },
      { status: 422 },
    );
  }

  try {
    const shopId = await resolveShopId(session.shop);
    const result = await executeInventoryRelocation(
      shopId,
      {
        alertId: null,
        skuId,
        fromLocationId,
        toLocationId,
        quantity: Number(qtyRaw),
        idempotencyKey,
      },
      getSupabase(),
      admin,
    );
    const ok = result.outcome === "succeeded";
    return json<RelocatePayload>({
      ok,
      toast: ok
        ? { message: "Inventory transfer executed — see the audit log" }
        : { message: "Transfer recorded as failed — check the audit log", isError: true },
    });
  } catch (err) {
    if (err instanceof RelocationError) {
      return json<RelocatePayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: 422 },
      );
    }
    const message = err instanceof Error ? err.message : "Inventory transfer failed.";
    return json<RelocatePayload>(
      { ok: false, error: { code: "ACTION_FAILED", message }, toast: { message, isError: true } },
      { status: 500 },
    );
  }
};

/** A SKU with no recent sales has no meaningful velocity or days-of-cover
 * (the engine caps cover at 999 in that case). */
const hasSales = (s: SKU) => (s.velocity ?? 0) > 0;

const ALERT_ACTION_KINDS: InventoryAlertActionKind[] = [
  "reallocate_inventory",
  "snooze_alert",
];

async function alertAction(
  formData: FormData,
  shop: string,
  admin: Parameters<typeof executeInventoryAlertAction>[0]["admin"],
  signal: AbortSignal,
) {
  const alertId = String(formData.get("alert_id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim() as InventoryAlertActionKind;
  const idempotencyKey = String(formData.get("idempotency_key") ?? "").trim();
  if (!alertId || !idempotencyKey || !ALERT_ACTION_KINDS.includes(kind)) {
    const message = "Invalid alert action.";
    return json<RelocatePayload>(
      { ok: false, error: { code: "INVALID_INPUT", message }, toast: { message, isError: true } },
      { status: 422 },
    );
  }

  try {
    const shopId = await resolveShopId(shop);
    const { outcome } = await executeInventoryAlertAction({
      client: calderynClient(shop),
      admin,
      sb: getSupabase(),
      shopId,
      alertId,
      kind,
      idempotencyKey,
      signal,
    });
    const ok = outcome === "succeeded";
    return json<RelocatePayload>({
      ok,
      toast: ok
        ? {
            message:
              kind === "snooze_alert"
                ? "Alert snoozed"
                : "Inventory transfer executed — see the audit log",
          }
        : { message: "Action recorded as failed — check the audit log", isError: true },
    });
  } catch (err) {
    if (err instanceof CalderynError) {
      return json<RelocatePayload>(
        {
          ok: false,
          error: { code: err.code, message: err.message },
          toast: { message: err.message, isError: true },
        },
        { status: err.status },
      );
    }
    const message = err instanceof Error ? err.message : "Alert action failed.";
    return json<RelocatePayload>(
      { ok: false, error: { code: "ACTION_FAILED", message }, toast: { message, isError: true } },
      { status: 500 },
    );
  }
}

export default function SKUs() {
  const navigate = useEmbeddedNavigate();
  const { skus, alerts, locations, error } = useLoaderData<typeof loader>();

  const [sortKey, setSortKey] = useState<SortKey>("on_hand");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");
  const [relocating, setRelocating] = useState<SKU | null>(null);
  const { smDown } = useBreakpoints();
  const fetcher = useFetcher<RelocatePayload>();
  useActionToast(fetcher.data);
  useEffect(() => {
    if (fetcher.data?.ok) setRelocating(null);
  }, [fetcher.data]);

  // Alerts reference SKUs by their human sku code (alerts.sku), NOT the
  // sku_dim uuid — joining on s.id matched nothing and left the column empty.
  const alertsBySku = useMemo(() => openAlertsBySku(alerts), [alerts]);

  const totalUnits = useMemo(
    () => skus.reduce((sum, s) => sum + (s.on_hand ?? 0), 0),
    [skus],
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

  // IndexTable sort ↔ our SortKey. null marks an unsortable column. Kept in
  // lockstep with `headings`/`sortable` — the index-6 null is the Ship P&L column.
  const SORT_COLUMNS: (SortKey | null)[] = [
    null, "title", null, "on_hand", "days_of_cover", "velocity", null, null, null, null,
  ];
  const sortColumnIndex = SORT_COLUMNS.indexOf(sortKey);
  const handleSort = (index: number, direction: "ascending" | "descending") => {
    const key = SORT_COLUMNS[index];
    if (!key) return;
    setSortKey(key);
    setSortDir(direction === "ascending" ? "asc" : "desc");
  };

  const countLabel = query.trim()
    ? `${sorted.length} of ${skus.length} SKUs`
    : `${skus.length} SKUs`;

  return (
    <Page
      fullWidth
      title="Inventory"
      titleMetadata={<ShopifySourcePill />}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      {error && (
        <Box paddingBlockEnd="400">
          <Banner tone="critical" title="Couldn't load SKUs">
            <p>{error.message}</p>
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
        <IndexTable
          condensed={smDown}
          resourceName={{ singular: "SKU", plural: "SKUs" }}
          itemCount={sorted.length}
          selectable={false}
          headings={[
            { title: "SKU" },
            { title: "Title" },
            { title: "Ship cost" },
            { title: "On hand", alignment: "end" },
            { title: "Days of cover", alignment: "end" },
            { title: "Velocity", alignment: "end" },
            { title: "Ship P&L", alignment: "end" },
            { title: "Main demand" },
            { title: "Actions" },
            { title: "Alerts", alignment: "center" },
          ]}
          sortable={[false, true, false, true, true, true, false, false, false, false]}
          sortColumnIndex={sortColumnIndex === -1 ? undefined : sortColumnIndex}
          sortDirection={sortDir === "asc" ? "ascending" : "descending"}
          defaultSortDirection="ascending"
          onSort={handleSort}
          emptyState={
            <Box padding="400">
              <Text as="p" tone="subdued" alignment="center">
                {query.trim()
                  ? `No SKUs match "${query.trim()}".`
                  : "No SKUs yet. They appear here as soon as Shopify syncs your catalog."}
              </Text>
            </Box>
          }
        >
          {sorted.map((s, index) => {
            const skuAlerts = alertsBySku.get(s.sku) ?? [];
            const canRelocate = s.locations_detail.some((l) => l.available > 0);
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
              <IndexTable.Row id={s.id} key={s.id} position={index}>
                <IndexTable.Cell>
                  <SkuId id={s.id} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Tooltip content={s.title}>
                    <Text as="span" fontWeight="medium" truncate>
                      {s.title}
                    </Text>
                  </Tooltip>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <ShipCostBadge source={s.ship_cost_source} confidence={s.ship_cost_confidence} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="p" alignment="end" fontWeight="semibold" tone={onHandTone}>
                    <span className="cdn-tnum">{(s.on_hand ?? 0).toLocaleString()}</span>
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {selling ? (
                    <Text
                      as="p"
                      alignment="end"
                      fontWeight={coverTone ? "semibold" : undefined}
                      tone={coverTone}
                    >
                      <span className="cdn-tnum">{cover.toFixed(1)}</span>
                      <Text as="span" tone="subdued">
                        {" "}
                        d
                      </Text>
                    </Text>
                  ) : (
                    <Tooltip content="No recent sales, so days of cover isn't meaningful">
                      <Text as="p" alignment="end" tone="subdued">
                        —
                      </Text>
                    </Tooltip>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {selling ? (
                    <Text as="p" alignment="end">
                      <span className="cdn-tnum">{(s.velocity ?? 0).toFixed(1)}</span>
                      <Text as="span" tone="subdued">
                        {" "}
                        /day
                      </Text>
                    </Text>
                  ) : (
                    <Text as="p" alignment="end" tone="subdued" variant="bodySm">
                      No sales
                    </Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Text as="p" alignment="end">
                    <ShipPnlText cents={s.ship_pnl_cents} />
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <DemandCell demand={s.demand} />
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {canRelocate && (
                    <Button size="slim" onClick={() => setRelocating(s)}>
                      Relocate
                    </Button>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {skuAlerts.length > 0 && <AlertsCell alerts={skuAlerts} />}
                </IndexTable.Cell>
              </IndexTable.Row>
            );
          })}
        </IndexTable>
      </Card>
      {relocating && (
        <RelocateModal
          sku={relocating}
          locations={locations}
          fetcher={fetcher}
          onClose={() => setRelocating(null)}
        />
      )}
    </Page>
  );
}

/** Per-row open alerts: badge opens a popover with each alert's actions,
 * executable without leaving the inventory page. Form-based actions deep-link
 * to the alert detail with its modal pre-opened. */
function AlertsCell({ alerts }: { alerts: Alert[] }) {
  const navigate = useEmbeddedNavigate();
  const fetcher = useFetcher<RelocatePayload>();
  useActionToast(fetcher.data);
  const [open, setOpen] = useState(false);
  // One key per merchant intent: minted per response so a double-click
  // replays, but the NEXT action (possibly a different alert) never collides
  // with a burned key.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const data = fetcher.data;
  useEffect(() => {
    if (data) setIdempotencyKey(crypto.randomUUID());
  }, [data]);

  if (alerts.length === 0) return null;
  const submitting = fetcher.state !== "idle";
  const execute = (alertId: string, kind: "reallocate_inventory" | "snooze_alert") => {
    fetcher.submit(
      { intent: "alert_action", alert_id: alertId, kind, idempotency_key: idempotencyKey },
      { method: "post" },
    );
  };

  return (
    <Popover
      active={open}
      onClose={() => setOpen(false)}
      preferredAlignment="right"
      activator={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={`${alerts.length} open alert${alerts.length === 1 ? "" : "s"}`}
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
        >
          <Badge tone="warning">{String(alerts.length)}</Badge>
        </button>
      }
    >
      <Box padding="300" minWidth="280px">
        <BlockStack gap="300">
          {alerts.map((a) => {
            const actions = inventoryAlertActions(a);
            return (
              <BlockStack gap="100" key={a.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/app/alerts/${a.id}`)}
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
                >
                  <Text as="span" variant="bodySm" fontWeight="medium">
                    {a.title}
                  </Text>
                </button>
                <Text as="span" tone="subdued" variant="bodySm">
                  {fmtMoney(a.dollar_impact)} at stake
                </Text>
                <InlineStack gap="150">
                  {actions.map((act) =>
                    act.mode === "execute" ? (
                      <Button
                        key={act.kind}
                        size="micro"
                        disabled={submitting}
                        onClick={() => {
                          if (act.kind !== "create_po_draft") execute(a.id, act.kind);
                        }}
                      >
                        {act.kind === "reallocate_inventory" ? "Move stock" : "Snooze"}
                      </Button>
                    ) : (
                      <Button
                        key={act.kind}
                        size="micro"
                        onClick={() => navigate(`/app/alerts/${a.id}?action=create_po_draft`)}
                      >
                        Draft PO
                      </Button>
                    ),
                  )}
                </InlineStack>
              </BlockStack>
            );
          })}
        </BlockStack>
      </Box>
    </Popover>
  );
}

function ShopifySourcePill() {
  return (
    <span className="cdn-source-pill">
      <BrandGlyph name="shopify" />
      Synced from Shopify
    </span>
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

function DemandCell({ demand }: { demand: SKU["demand"] }) {
  if (!demand) {
    return (
      <Text as="span" tone="subdued" variant="bodySm">
        —
      </Text>
    );
  }
  const starved = demand.stock_in_region === 0;
  return (
    <span
      title={`${demand.units_30d.toLocaleString()} units sold in ${demand.region} over 30 days (${Math.round(demand.share * 100)}% of demand) · ${demand.stock_in_region.toLocaleString()} in stock there`}
    >
      <Text
        as="span"
        variant="bodySm"
        fontWeight={starved ? "semibold" : "medium"}
        tone={starved ? "critical" : undefined}
      >
        {shortLoc(demand.region)}
      </Text>{" "}
      <Text as="span" variant="bodySm" tone="subdued">
        <span className="cdn-tnum">{formatDemandUnits(demand.units_30d)}</span>
      </Text>
    </span>
  );
}

/** Lazy-loaded "frequently bought with" panel for one SKU, shown in the relocate
 * modal. Display-only (no navigation) — a compact list of co-purchased SKUs with
 * order counts + share. */
function BoughtWith({ skuId }: { skuId: string }) {
  const fetcher = useFetcher<{
    items: SkuAffinityItem[];
    error: { code: string; message: string } | null;
  }>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data === undefined) {
      fetcher.load(`/app/skus/${encodeURIComponent(skuId)}/affinity`);
    }
  }, [skuId, fetcher]);

  const data = fetcher.data;
  const items = data?.items ?? [];

  let body: React.ReactNode;
  if (data === undefined) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Loading…
      </Text>
    );
  } else if (data.error) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        Couldn&apos;t load bundles.
      </Text>
    );
  } else if (items.length === 0) {
    body = (
      <Text as="span" tone="subdued" variant="bodySm">
        No frequent pairings yet — this builds as orders come in.
      </Text>
    );
  } else {
    body = (
      <BlockStack gap="100">
        {items.map((it) => (
          <InlineStack key={it.sku_id} align="space-between" gap="200" wrap={false}>
            <Text as="span" variant="bodySm" truncate>
              {it.title}
            </Text>
            <Text as="span" tone="subdued" variant="bodySm">
              {it.co_count.toLocaleString()} order{it.co_count === 1 ? "" : "s"} ·{" "}
              {Math.round(it.share * 100)}%
            </Text>
          </InlineStack>
        ))}
      </BlockStack>
    );
  }

  return (
    <BlockStack gap="150">
      <Text as="span" variant="bodySm" fontWeight="medium">
        Frequently bought with
      </Text>
      {body}
    </BlockStack>
  );
}

function RelocateModal({
  sku,
  locations,
  fetcher,
  onClose,
}: {
  sku: SKU;
  locations: ShopLocation[];
  fetcher: ReturnType<typeof useFetcher<RelocatePayload>>;
  onClose: () => void;
}) {
  // With a suggested transfer the modal opens prefilled; without one it's a
  // manual transfer: source defaults to the largest holder, destination to
  // the first other active location, quantity left for the merchant.
  const plan = sku.suggested_transfer;
  const fallbackFrom = sku.locations_detail.find((l) => l.available > 0)?.id ?? "";
  const initialFrom = plan?.from_location_id ?? fallbackFrom;
  const [fromId, setFromId] = useState(initialFrom);
  const [toId, setToId] = useState(
    plan?.to_location_id ??
      locations.find((l) => l.active && l.id !== initialFrom)?.id ??
      "",
  );
  const [qty, setQty] = useState(plan ? String(plan.recommended_delta) : "");
  // One key per relocation intent: double-clicking Confirm while a submit is
  // in flight replays, not re-executes.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const data = fetcher.data;
  useEffect(() => {
    // A terminal failure burned this key server-side; mint a fresh one so the
    // merchant's retry (possibly with edited inputs) actually executes instead
    // of replaying the failed audit. Rotating after a 422 validation reject is
    // harmless (no marker was written). Each response is a fresh object, so
    // consecutive failures rotate the key each time.
    if (data && !data.ok) setIdempotencyKey(crypto.randomUUID());
  }, [data]);

  const sourceOptions = sku.locations_detail
    .filter((l) => l.available > 0)
    .map((l) => ({
      label: `${l.name} (${l.available.toLocaleString()} available)`,
      value: l.id,
    }));
  const destOptions = locations
    .filter((l) => l.active)
    .map((l) => ({
      label: l.region ? `${l.name} — ${l.region}` : l.name,
      value: l.id,
    }));

  const available = sku.locations_detail.find((l) => l.id === fromId)?.available ?? 0;
  const qtyNum = /^\d+$/.test(qty) ? Number(qty) : NaN;
  const qtyError =
    !Number.isInteger(qtyNum) || qtyNum < 1
      ? "Enter a positive whole number"
      : qtyNum > available
        ? `Only ${available.toLocaleString()} available at the source`
        : undefined;
  const invalid = Boolean(qtyError) || !fromId || !toId || fromId === toId;
  const submitting = fetcher.state !== "idle";

  const submit = () => {
    fetcher.submit(
      {
        sku_id: sku.id,
        from_location_id: fromId,
        to_location_id: toId,
        quantity: qty,
        idempotency_key: idempotencyKey,
      },
      { method: "post" },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Relocate ${sku.title}`}
      primaryAction={{
        content: "Move inventory",
        onAction: submit,
        loading: submitting,
        disabled: invalid,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <BoughtWith key={sku.id} skuId={sku.id} />
          {sku.demand && (
            <Text as="p" tone="subdued">
              Main demand is {sku.demand.region} ({sku.demand.units_30d.toLocaleString()}{" "}
              units/30d), which currently holds{" "}
              {sku.demand.stock_in_region.toLocaleString()} units.
            </Text>
          )}
          <Select label="From" options={sourceOptions} value={fromId} onChange={setFromId} />
          <Select
            label="To"
            options={destOptions}
            value={toId}
            onChange={setToId}
            error={fromId === toId ? "Source and destination must differ" : undefined}
          />
          <TextField
            label="Quantity"
            type="text"
            autoComplete="off"
            value={qty}
            onChange={setQty}
            error={qtyError}
            helpText={plan ? "Suggested to cover one week of regional demand." : undefined}
          />
          <Text as="p" tone="subdued" variant="bodySm">
            Transfers via Shopify, recorded in the audit log. Reversible via Undo for 24
            hours.
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

function shortLoc(name: string): string {
  const afterDash = name.split(/[—–-]/).pop() ?? name;
  const city = afterDash.split(",")[0]?.trim() || name;
  return city.length > 12 ? city.slice(0, 11) + "…" : city;
}
