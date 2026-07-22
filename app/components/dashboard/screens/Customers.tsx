import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { Card, Btn, Pan, Placeholder, TableSkeleton } from "../ui";
import { money, timeAgo } from "../format";
import { CDIcon } from "../icons";
import { reduced } from "../hero/hero-motion";
import { DashboardApiError, putGuardrails } from "~/lib/dashboard/client";
import {
  fetchCustomersPage,
  fetchCustomerDetail,
  type CustomersPage,
  type CustomerDetail,
  type CustomerRow,
  type CustomerSegment,
  type SegmentDef,
  type WeatherSuggestionDTO,
} from "~/lib/dashboard/customers-client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import {
  OrderListTable,
  OrderListToolbar,
  OrderPageReadout,
  OrderSortHeader,
  downloadCsv,
  nextSortState,
  useSortedRowsEntrance,
} from "./OrderListFamily";
import { WeatherSegments } from "../WeatherSegments";
import { sensitivityForMode, weatherMode, type WeatherMode } from "~/lib/weather/types";
import type { DashboardCtx } from "../context";

// Customer / Location / Segment / Orders / Spent / row chevron — same trailing
// open-row affordance as the Orders and Products tables.
const DIR_COLS = "1.7fr 1.3fr 1fr 0.6fr 0.9fr 36px";
const SEG_COLS = "1fr 130px 104px";
const ORDER_COLS = "0.9fr 0.8fr 1.8fr 0.8fr 1fr";

// Section titles per rail sub-view, same anatomy as the Orders screen.
const CUST_SECTION_META: Record<string, { title: string }> = {
  directory: { title: "Customers" },
  segments: { title: "Segments" },
  weather: { title: "Weather" },
};

// The directory's default ordering: newest customers first. Header clicks cycle
// through a column's two directions and back to this via nextSortState — the
// same policy as the Orders and Products tables ("joined" has no column of its
// own, like the labels list's date sort).
const DEFAULT_CUST_SORT = { sort: "joined", dir: "desc" } as const;

function compareCustomers(
  a: CustomerRow,
  b: CustomerRow,
  sort: string,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  // ISO timestamps compare correctly as strings. Newest-joined-first is the tie-break on every
  // column, so equal-valued rows keep one stable order instead of whatever the previous sort
  // left behind.
  const byJoined = b.createdAt.localeCompare(a.createdAt);
  switch (sort) {
    case "customer":
      return mul * a.email.localeCompare(b.email) || byJoined;
    case "location": {
      const la = locationLabel(a.city, a.country);
      const lb = locationLabel(b.city, b.country);
      // Rows with no location sink to the bottom in both directions.
      if (la === "—" || lb === "—") return la === lb ? byJoined : la === "—" ? 1 : -1;
      return mul * la.localeCompare(lb) || byJoined;
    }
    case "segment":
      // Priority order (VIP first), not alphabetical — matches the filter-view ordering so
      // "ascending" reads as most- to least-valuable.
      return (
        mul * (SEGMENT_ORDER.indexOf(a.segment) - SEGMENT_ORDER.indexOf(b.segment)) || byJoined
      );
    case "orders":
      return mul * (a.orders - b.orders) || byJoined;
    case "spent":
      return mul * (a.spentCents - b.spentCents) || byJoined;
    default:
      return mul * a.createdAt.localeCompare(b.createdAt);
  }
}

// Segments list: curated server order by default; Name sorts A-Z, and both numeric columns sort
// by member count (the % column is count ÷ total, so the two orderings are the same — each
// header still shows its own arrow).
const DEFAULT_SEG_SORT = { sort: "curated", dir: "desc" } as const;

function compareSegments(
  a: SegmentDef,
  b: SegmentDef,
  sort: string,
  dir: "asc" | "desc",
): number {
  const mul = dir === "asc" ? 1 : -1;
  switch (sort) {
    case "name":
      return mul * a.name.localeCompare(b.name);
    case "pct":
    case "count":
      return mul * (a.count - b.count) || a.name.localeCompare(b.name);
    default:
      return 0;
  }
}

// One deterministic color per segment; drives the avatar + badge tinting.
const SEGMENT_COLOR: Record<CustomerSegment, string> = {
  VIP: "#7C5CFC",
  Repeat: "var(--green)",
  New: "#2D7FF9",
  "At risk": "var(--red)",
  "One-time": "var(--text-3)",
  Prospect: "var(--text-3)",
};

// Filter-view order mirrors segment priority.
const SEGMENT_ORDER: CustomerSegment[] = [
  "VIP",
  "At risk",
  "Repeat",
  "New",
  "One-time",
  "Prospect",
];

// Order-state → badge tone. Same vocabulary as the Orders screen (the order
// spine's shared state set, app/lib/order/state.ts).
const STATE_TONE: Record<string, string> = {
  paid: "var(--green)",
  fulfilled: "var(--green)",
  checkout_pending: "var(--orange)",
  cancelled: "var(--text-3)",
  refunded: "var(--orange)",
};

const STATE_LABEL: Record<string, string> = {
  paid: "Paid",
  fulfilled: "Fulfilled",
  checkout_pending: "Checkout pending",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

function StateBadge({ state }: { state: string }) {
  return (
    <span
      className="cd-badge"
      style={{ color: STATE_TONE[state] ?? "var(--text-2)", background: "var(--gray-bg)" }}
    >
      {STATE_LABEL[state] ?? state}
    </span>
  );
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const tokens = local.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (tokens.length >= 2) return (tokens[0][0] + tokens[1][0]).toUpperCase();
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return "?";
}

function Avatar({
  email,
  segment,
  size,
}: {
  email: string;
  segment: CustomerSegment;
  size?: number;
}) {
  const color = SEGMENT_COLOR[segment];
  return (
    <span
      className="cd-avatar"
      aria-hidden="true"
      style={{
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        color,
        ...(size ? { width: size, height: size, fontSize: Math.round(size * 0.34) } : {}),
      }}
    >
      {initials(email)}
    </span>
  );
}

function SegBadge({ segment }: { segment: CustomerSegment }) {
  const color = SEGMENT_COLOR[segment];
  return (
    <span
      className="cd-seg-badge"
      style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
    >
      {segment}
    </span>
  );
}

function Stat({
  label,
  value,
  caption,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
}) {
  return (
    <Card className="cd-stat">
      <span className="cd-stat-label">{label}</span>
      <span className="cd-stat-value tabular-nums">{value}</span>
      {caption && <span className="cd-caption">{caption}</span>}
    </Card>
  );
}

function locationLabel(city: string | null, country: string | null): string {
  if (city && country) return `${city}, ${country}`;
  return city ?? country ?? "—";
}

function ProfileRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3" style={{ padding: "6px 0" }}>
      <span className="cd-caption" style={{ flex: "0 0 auto" }}>
        {label}
      </span>
      <span className="truncate" style={{ textAlign: "right" }}>
        {value}
      </span>
    </div>
  );
}

function CardHead({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: "14px 20px",
        borderBottom: "0.5px solid var(--hairline-strong)",
        flexWrap: "wrap",
        gap: 10,
      }}
    >
      {children}
    </div>
  );
}

function DetailView({
  app,
  detail,
  loading,
}: {
  app: DashboardCtx;
  detail: CustomerDetail | null;
  loading: boolean;
}) {
  if (!detail) {
    return (
      <div className="cd-screen" data-screen-label="Customer detail">
        <div>
          <Btn small icon="chevronLeft" onClick={() => app.navigate("customers")}>
            Customers
          </Btn>
        </div>
        <Card>
          <Placeholder
            icon="user"
            title={loading ? "Loading customer" : "Customer unavailable"}
            sub={
              loading
                ? "Reading their profile, orders, and cart."
                : "Could not load this customer just now. Head back and try again."
            }
          />
        </Card>
      </div>
    );
  }

  const c = detail.customer;
  const marketing = detail.consents.find((x) => x.policy === "marketing");

  return (
    <div className="cd-screen" data-screen-label="Customer detail">
      <div>
        <Btn small icon="chevronLeft" onClick={() => app.navigate("customers")}>
          Customers
        </Btn>
      </div>
      <header className="cd-screen-head" style={{ marginTop: 12 }}>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <Avatar email={c.email} segment={c.segment} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
              <h1 className="cd-h1 truncate">{c.email || "No email"}</h1>
              <SegBadge segment={c.segment} />
            </div>
            <p className="cd-sub">Customer since {timeAgo(c.since)}</p>
          </div>
        </div>
      </header>

      <div className="cd-stat-grid" style={{ marginBottom: 18 }}>
        <Stat label="Total spent" value={money(c.spentCents)} />
        <Stat label="Orders" value={String(c.ordersCount)} />
        <Stat
          label="Avg order"
          value={c.ordersCount > 0 ? money(c.aovCents) : "—"}
          caption={c.ordersCount === 0 ? "No orders yet" : undefined}
        />
        <Stat
          label="Last order"
          value={c.lastOrderAt ? timeAgo(c.lastOrderAt) : "—"}
          caption={c.lastOrderAt ? undefined : "No orders yet"}
        />
      </div>

      <div className="cd-cust-detail">
        <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
          <Card pad={false}>
            <CardHead>
              <h2 className="cd-h2">Recent orders</h2>
            </CardHead>
            {detail.orders.length === 0 ? (
              <Placeholder
                icon="doc"
                title="No orders yet"
                sub="Orders this customer places on your storefront land here."
              />
            ) : (
              <Pan min={520}>
                <div className="cd-tablehd" style={{ gridTemplateColumns: ORDER_COLS }}>
                  <span>Order</span>
                  <span>Date</span>
                  <span>Items</span>
                  <span style={{ textAlign: "right" }}>Total</span>
                  <span>Status</span>
                </div>
                {detail.orders.map((o) => (
                  <div key={o.id} className="cd-trow" style={{ gridTemplateColumns: ORDER_COLS }}>
                    <div className="cd-row-title tabular-nums">{o.ref}</div>
                    <div className="cd-caption">{timeAgo(o.createdAt)}</div>
                    <div className="cd-caption truncate">{o.items}</div>
                    <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                      {money(o.totalCents)}
                    </div>
                    <div>
                      <StateBadge state={o.state} />
                    </div>
                  </div>
                ))}
              </Pan>
            )}
          </Card>

          <Card pad={false}>
            <CardHead>
              <h2 className="cd-h2">In cart now</h2>
            </CardHead>
            {!detail.cart ? (
              <div className="cd-caption" style={{ padding: "16px 20px" }}>
                Cart is empty.
              </div>
            ) : (
              <div style={{ padding: "6px 0 0" }}>
                {detail.cart.items.map((item, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: "8px 20px" }}
                  >
                    <span className="truncate">
                      {item.quantity}× {item.title}
                    </span>
                    <span className="cd-row-num tabular-nums">
                      {money(item.priceCents * item.quantity)}
                    </span>
                  </div>
                ))}
                <div
                  className="flex items-center justify-between gap-3"
                  style={{
                    padding: "10px 20px",
                    borderTop: "0.5px solid var(--hairline-strong)",
                  }}
                >
                  <span className="cd-caption">Cart value</span>
                  <b className="tabular-nums">{money(detail.cart.valueCents)}</b>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Card>
            <h2 className="cd-h2" style={{ marginBottom: 8 }}>
              Profile
            </h2>
            <ProfileRow label="Location" value={locationLabel(c.city, c.country)} />
            <ProfileRow label="Phone" value={c.phone ?? "—"} />
            <ProfileRow
              label="Marketing consent"
              value={marketing ? (marketing.accepted ? "Yes" : "No") : "—"}
            />
            <ProfileRow label="Last order" value={c.lastOrderAt ? timeAgo(c.lastOrderAt) : "—"} />
          </Card>
          <Card>
            <h2 className="cd-h2" style={{ marginBottom: 8 }}>
              Addresses
            </h2>
            {detail.addresses.length === 0 ? (
              <div className="cd-caption">No addresses on file yet.</div>
            ) : (
              detail.addresses.map((a, i) => (
                <div
                  key={i}
                  style={{
                    padding: "8px 0",
                    borderTop: i > 0 ? "0.5px solid var(--hairline)" : undefined,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="cd-row-title" style={{ textTransform: "capitalize" }}>
                      {a.kind}
                    </span>
                    {a.isDefault && (
                      <span
                        className="cd-badge"
                        style={{ background: "var(--gray-bg)", color: "var(--text-2)" }}
                      >
                        Default
                      </span>
                    )}
                  </div>
                  {a.name && <div className="cd-caption">{a.name}</div>}
                  <div className="cd-caption">
                    {[a.city, a.region, a.country].filter(Boolean).join(", ") || "—"}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function Customers({ app }: { app: DashboardCtx }) {
  // Seeded from the session cache so a return visit paints the last directory
  // instantly; the mount fetch below revalidates and writes back through.
  const [page, setPage] = useState<CustomersPage | null>(() =>
    cachedScreenData<CustomersPage>(SCREEN_CACHE_KEYS.customers),
  );
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [segFilter, setSegFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [custSort, setCustSort] = useState<{ sort: string; dir: "asc" | "desc" }>(
    DEFAULT_CUST_SORT,
  );
  const [segQuery, setSegQuery] = useState("");
  const [segSort, setSegSort] = useState<{ sort: string; dir: "asc" | "desc" }>(DEFAULT_SEG_SORT);
  const [wx, setWx] = useState<WeatherSuggestionDTO[]>(page?.weatherSuggestions ?? []);
  const toast = app.toast;
  const buyerId = app.nav.param;

  useEffect(() => {
    setWx(page?.weatherSuggestions ?? []);
  }, [page]);

  // Optimistic override for the weather-mode control; cleared once the shell's
  // guardrails refresh lands so the dial stays the single source of truth.
  const [wxModeOverride, setWxModeOverride] = useState<WeatherMode | null>(null);
  const wxMode = wxModeOverride ?? weatherMode(app.guardrails?.weather_sensitivity ?? 0);
  useEffect(() => {
    setWxModeOverride(null);
  }, [app.guardrails]);

  // "Off" no longer exists: a legacy dial at 0 would show Manual while the
  // cron silently skips the shop. Migrate it to the manual default once,
  // the first time the Weather tab is viewed.
  const healedRef = useRef(false);
  useEffect(() => {
    if (
      app.nav.sub === "weather" &&
      !healedRef.current &&
      app.guardrails &&
      app.guardrails.weather_sensitivity === 0
    ) {
      healedRef.current = true;
      putGuardrails({ weather_sensitivity: sensitivityForMode("manual", 0) })
        .then(() => app.refresh())
        .catch(() => {
          // Surface next interaction; the toggle write path reports errors.
          healedRef.current = false;
        });
    }
  });

  const onWeatherMode = async (next: WeatherMode) => {
    const prev = wxModeOverride;
    setWxModeOverride(next);
    try {
      await putGuardrails({
        weather_sensitivity: sensitivityForMode(next, app.guardrails?.weather_sensitivity ?? 0),
      });
      app.refresh();
      toast(
        next === "auto"
          ? "Auto — moves run on their own when the forecast confirms"
          : "Manual — you approve, reject or schedule each move",
        "check",
      );
    } catch (err) {
      setWxModeOverride(prev);
      const msg = err instanceof DashboardApiError ? err.message : "Couldn't update weather mode.";
      toast(msg, "x", "critical");
    }
  };

  const onWeather = async (id: string, intent: "apply" | "arm" | "dismiss") => {
    // Optimistic: arming flips the row to armed in place; apply/dismiss remove
    // it. Kept restorable — a 409 (e.g. dismissed in another tab) must not
    // leave the UI claiming a move is armed when it isn't.
    const prev = wx;
    const next =
      intent === "arm"
        ? wx.map((s) => (s.id === id ? { ...s, status: "armed" as const } : s))
        : wx.filter((s) => s.id !== id);
    setWx(next);
    // weatherIntent owns the API call, the shared toasts, the mirrored-alert
    // resolution, and the session-cache write-through.
    const ok = await app.weatherIntent(id, intent);
    if (!ok) {
      setWx(prev);
      return;
    }
    // Keep the live page object in step with what weatherIntent cached, so a
    // tab-switch doesn't reseed the stale pre-action list.
    setPage((p) => (p ? { ...p, weatherSuggestions: next } : p));
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setPageError(null);
    fetchCustomersPage()
      .then((p) => {
        cacheScreenData(SCREEN_CACHE_KEYS.customers, p);
        if (alive) setPage(p);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = err instanceof DashboardApiError ? err.message : "Could not load customers.";
        setPageError(msg);
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  useEffect(() => {
    if (!buyerId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setDetailLoading(true);
    fetchCustomerDetail(buyerId)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg =
          err instanceof DashboardApiError
            ? err.status === 404
              ? "This customer isn't in your store."
              : err.message
            : "Could not load this customer.";
        toast(msg, "warn", "critical");
      })
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [buyerId, toast]);

  // Subtab navigation lives in the sidebar rail; this screen renders the view
  // for the active sub only.
  const sub = app.nav.sub ?? "directory";
  const sectionMeta = CUST_SECTION_META[sub] ?? CUST_SECTION_META.directory;

  const segmentsPresent = useMemo(
    () =>
      page ? SEGMENT_ORDER.filter((s) => page.customers.some((c) => c.segment === s)) : [],
    [page],
  );

  // Directory rows: segment view → search → sort, all client-side (the page
  // read model already holds every customer).
  const q = search.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    if (!page) return [];
    let rows =
      segFilter === "All"
        ? page.customers
        : page.customers.filter((c) => c.segment === segFilter);
    if (q) {
      rows = rows.filter(
        (c) =>
          c.email.toLowerCase().includes(q) ||
          locationLabel(c.city, c.country).toLowerCase().includes(q) ||
          c.segment.toLowerCase().includes(q),
      );
    }
    return [...rows].sort((a, b) => compareCustomers(a, b, custSort.sort, custSort.dir));
  }, [page, segFilter, q, custSort]);

  const segQ = segQuery.trim().toLowerCase();
  const segMatches = useMemo(() => {
    if (page === null) return [];
    const rows = page.segments.filter(
      (s) => !segQ || s.name.toLowerCase().includes(segQ) || s.basis.toLowerCase().includes(segQ),
    );
    if (segSort.sort === "curated") return rows;
    return [...rows].sort((a, b) => compareSegments(a, b, segSort.sort, segSort.dir));
  }, [page, segQ, segSort]);

  // Same header anatomy as Orders/Products: h1, then the stat readout strip.
  // Empty until the first page lands — the readout renders its own same-height
  // shimmer ghosts so the card below never shifts.
  const readoutItems =
    page === null
      ? []
      : [
          {
            label: page.stats.customers === 1 ? "customer" : "customers",
            value: page.stats.customers.toLocaleString("en-US"),
          },
          {
            label: "repeat rate",
            value: page.stats.repeatRatePct == null ? "—" : `${page.stats.repeatRatePct}%`,
          },
          {
            label: "marketing consent",
            value:
              page.stats.marketingConsentPct == null
                ? "—"
                : `${page.stats.marketingConsentPct}%`,
          },
          {
            label: "blended LTV",
            value: page.stats.blendedLtvCents == null ? "—" : money(page.stats.blendedLtvCents),
          },
        ];

  // Subtle rise on the section panel whenever the rail sub-view changes — the
  // same transition the Orders sections use.
  const sectionPanelRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      if (reduced() || !sectionPanelRef.current) return;
      gsap.from(sectionPanelRef.current, {
        autoAlpha: 0,
        y: 5,
        duration: 0.2,
        ease: "power2.out",
        willChange: "transform,opacity",
        clearProps: "opacity,visibility,transform,willChange",
      });
    },
    { dependencies: [sub], scope: sectionPanelRef, revertOnUpdate: true },
  );

  // Staggered row rise on load, segment-view switches, re-sorts, and the return
  // from a customer detail — each scoped to its own table so neither can pick up
  // a `.cd-trow` from the other or from another screen. Search keystrokes are
  // deliberately left out of both dependency lists: replaying the entrance on
  // every character would make the list flicker while typing.
  const listRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(listRef, visibleRows.map((c) => c.id).join("|"), [
    page,
    segFilter,
    custSort,
    buyerId,
  ]);

  const segListRef = useRef<HTMLDivElement>(null);
  useSortedRowsEntrance(segListRef, segMatches.map((s) => s.key).join("|"), [page, segSort]);

  if (buyerId) {
    return <DetailView app={app} detail={detail} loading={detailLoading} />;
  }

  const segSortHd = (label: string, col: string, align?: "right") => (
    <OrderSortHeader
      label={label}
      col={col}
      sort={segSort.sort}
      dir={segSort.dir}
      onSort={(c) => setSegSort((cur) => nextSortState(cur, c, DEFAULT_SEG_SORT))}
      align={align}
    />
  );

  // Exports what the merchant is looking at: the current segment view + search,
  // in the current sort order.
  const exportCustomers = () => {
    downloadCsv("customers.csv", [
      ["Email", "Location", "Segment", "Orders", "Spent", "Joined", "Last order"],
      ...visibleRows.map((c) => [
        c.email,
        c.city || c.country ? locationLabel(c.city, c.country) : "",
        c.segment,
        c.orders,
        (c.spentCents / 100).toFixed(2),
        c.createdAt,
        c.lastOrderAt ?? "",
      ]),
    ]);
  };

  const narrowed = segFilter !== "All" || q !== "";

  const sortHd = (label: string, col: string, align?: "right") => (
    <OrderSortHeader
      label={label}
      col={col}
      sort={custSort.sort}
      dir={custSort.dir}
      onSort={(c) => setCustSort((cur) => nextSortState(cur, c, DEFAULT_CUST_SORT))}
      align={align}
    />
  );

  return (
    <div className="cd-screen cd-orders-screen" data-screen-label="Customers" data-sub={sub}>
      <header className="cd-screen-head cd-order-page-head">
        <div>
          <h1 className="cd-h1">{sectionMeta.title}</h1>
        </div>
      </header>

      {sub === "directory" && (
        <OrderPageReadout items={readoutItems} ariaLabel="Customers overview" />
      )}

      <div ref={sectionPanelRef} className="cd-order-section-panel">
        {sub === "segments" ? (
          <Card pad={false} className="cd-order-workspace">
            {!page ? (
              loading ? (
                <TableSkeleton />
              ) : (
                <Placeholder
                  icon="user"
                  title="Customers unavailable"
                  sub="Could not load customers just now. Refresh to try again."
                />
              )
            ) : (
              <>
                <div className="cd-seg-search">
                  <CDIcon name="search" size={15} style={{ color: "var(--text-3)" }} />
                  <input
                    className="cd-seg-search-in"
                    placeholder="Search segments"
                    aria-label="Search segments"
                    value={segQuery}
                    onChange={(e) => setSegQuery(e.target.value)}
                  />
                </div>
                <div ref={segListRef}>
                  <Pan min={440}>
                    <div className="cd-tablehd" style={{ gridTemplateColumns: SEG_COLS }}>
                      {segSortHd("Name", "name")}
                      {segSortHd("% of customers", "pct", "right")}
                      {segSortHd("Customers", "count", "right")}
                    </div>
                    {segMatches.length === 0 ? (
                      <div className="cd-caption" style={{ padding: "16px 20px" }}>
                        No segments match your search.
                      </div>
                    ) : (
                      segMatches.map((s) => (
                        <div key={s.key} className="cd-trow" style={{ gridTemplateColumns: SEG_COLS }}>
                          <div style={{ minWidth: 0 }}>
                            <div className="cd-row-title truncate">{s.name}</div>
                            <div className="cd-caption truncate">{s.basis}</div>
                          </div>
                          <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                            {s.pct}
                          </div>
                          <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                            {s.count}
                          </div>
                        </div>
                      ))
                    )}
                  </Pan>
                </div>
              </>
            )}
          </Card>
        ) : sub === "weather" ? (
          <WeatherSegments
            suggestions={wx}
            onIntent={onWeather}
            toast={toast}
            mode={wxMode}
            onMode={onWeatherMode}
            dark={app.t.dark ?? true}
          />
        ) : (
          <Card pad={false} className="cd-order-workspace">
            <OrderListToolbar
              views={["All", ...segmentsPresent].map((s) => ({ id: s, label: s }))}
              view={segFilter}
              onViewChange={setSegFilter}
              searchValue={search}
              searchPlaceholder="Search customers"
              searchAriaLabel="Search customers"
              onSearchChange={setSearch}
              filterLabel="Customer"
              viewExtras={
                page && narrowed ? (
                  <span className="cd-caption tabular-nums" aria-live="polite">
                    {visibleRows.length} of {page.customers.length}
                  </span>
                ) : undefined
              }
              onExport={page && page.customers.length > 0 ? exportCustomers : undefined}
            />

            <div ref={listRef}>
              <OrderListTable
                loading={loading}
                error={pageError}
                empty={visibleRows.length === 0}
                filtered={narrowed}
                minWidth={680}
                columns={DIR_COLS}
                emptyIcon="user"
                emptyTitle="No customers yet"
                emptySub="Shoppers who sign up or check out on your storefront land here."
                filteredTitle="No matching customers"
                filteredSub="Try a different search or segment view."
                headers={
                  <>
                    {sortHd("Customer", "customer")}
                    {sortHd("Location", "location")}
                    {sortHd("Segment", "segment")}
                    {sortHd("Orders", "orders")}
                    {sortHd("Spent", "spent", "right")}
                    <span />
                  </>
                }
              >
                {visibleRows.map((c) => (
                  <div
                    key={c.id}
                    role="button"
                    tabIndex={0}
                    className="cd-trow cd-order-row"
                    style={{ gridTemplateColumns: DIR_COLS, cursor: "pointer" }}
                    onClick={() => app.navigate("customers", c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        app.navigate("customers", c.id);
                      }
                    }}
                  >
                    <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                      <Avatar email={c.email} segment={c.segment} />
                      <div style={{ minWidth: 0 }}>
                        <div className="cd-row-title truncate">{c.email || "No email"}</div>
                        <div className="cd-caption">Joined {timeAgo(c.createdAt)}</div>
                      </div>
                    </div>
                    <div className="truncate">{locationLabel(c.city, c.country)}</div>
                    <div>
                      <SegBadge segment={c.segment} />
                    </div>
                    <div className="tabular-nums">{c.orders}</div>
                    <div className="cd-row-num tabular-nums" style={{ textAlign: "right" }}>
                      {money(c.spentCents)}
                    </div>
                    <div className="cd-order-row-actions">
                      <CDIcon name="chevronRight" size={15} className="cd-order-row-chevron" />
                    </div>
                  </div>
                ))}
              </OrderListTable>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
