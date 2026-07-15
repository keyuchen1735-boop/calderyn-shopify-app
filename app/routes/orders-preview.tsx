import { useCallback, useEffect, useMemo, useState } from "react";
import type { LinksFunction, MetaFunction } from "@remix-run/node";

import AssistantPanel from "~/components/dashboard/AssistantPanel";
import { CDIcon } from "~/components/dashboard/icons";
import Orders from "~/components/dashboard/screens/Orders";
import type { DashboardCtx, NavState, Screen } from "~/components/dashboard/context";
import { ToastHost, Toggle } from "~/components/dashboard/ui";
import type { Toast } from "~/components/dashboard/view-models";
import { cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { OrderDetail } from "~/lib/order/detail-types";
import dashboardUtils from "~/styles/dashboard-utils.css?url";
import dashboard from "~/styles/dashboard.css?url";

export const meta: MetaFunction = () => [{ title: "Orders preview — Calderyn" }];
export const links: LinksFunction = () => [
  { rel: "stylesheet", href: dashboardUtils },
  { rel: "stylesheet", href: dashboard },
];

const now = Date.now();
const ago = (days: number, hours = 0) =>
  new Date(now - (days * 24 + hours) * 60 * 60 * 1000).toISOString();

const orderRows = [
  {
    source: "calderyn",
    id: "ord-1048",
    ref: "#1048",
    buyer_email: "maya@northstar.example",
    total_cents: 20600,
    currency: "usd",
    payment_status: "paid",
    state: "paid",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(4, 3),
    item_count: 2,
    tags: ["priority", "repeat customer"],
    remaining_refundable_cents: 20600,
  },
  {
    source: "calderyn",
    id: "ord-1047",
    ref: "#1047",
    buyer_email: "jordan@fieldnotes.example",
    total_cents: 12900,
    currency: "usd",
    payment_status: "paid",
    state: "fulfilled",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(1, 5),
    item_count: 1,
    tags: ["newsletter"],
    remaining_refundable_cents: 12900,
  },
  {
    source: "calderyn",
    id: "ord-1046",
    ref: "#1046",
    buyer_email: "amara@switchback.example",
    total_cents: 25700,
    currency: "usd",
    payment_status: "paid",
    state: "partially_fulfilled",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(2, 4),
    item_count: 3,
    tags: ["gift"],
    remaining_refundable_cents: 25700,
  },
  {
    source: "shopify",
    id: "shp-5812",
    ref: "#5812",
    buyer_email: "theo@pineworks.example",
    total_cents: 8900,
    currency: "usd",
    payment_status: "paid",
    state: "paid",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(6, 2),
    item_count: 1,
    tags: ["imported"],
    remaining_refundable_cents: 0,
  },
  {
    source: "calderyn",
    id: "ord-1044",
    ref: "#1044",
    buyer_email: "claire@highline.example",
    total_cents: 16800,
    currency: "usd",
    payment_status: "partially_refunded",
    state: "partially_refunded",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(8, 1),
    item_count: 1,
    tags: ["size exchange"],
    remaining_refundable_cents: 8400,
  },
  {
    source: "calderyn",
    id: "ord-1043",
    ref: "#1043",
    buyer_email: "avery@cedarhouse.example",
    total_cents: 7600,
    currency: "usd",
    payment_status: "pending",
    state: "checkout_pending",
    cancelled_at: null,
    archived_at: null,
    occurred_at: ago(0, 7),
    item_count: 2,
    tags: ["invoice"],
    remaining_refundable_cents: 0,
  },
] as const;

const legacyPage = {
  orders: orderRows
    .filter((row) => row.source === "calderyn")
    .map((row) => ({
      id: row.id,
      ref: row.ref,
      buyerEmail: row.buyer_email,
      itemCount: row.item_count,
      totalCents: row.total_cents,
      remainingRefundableCents: row.remaining_refundable_cents,
      currency: row.currency,
      attribution: row.id === "ord-1048" ? "Meta · Summit prospecting" : null,
      state: row.state,
      financialStatus: row.payment_status,
      createdAt: row.occurred_at,
    })),
  drafts: [
    { id: "cart-77", ref: "D-0077", buyerEmail: "lena@trailpost.example", itemCount: 3, valueCents: 24400, currency: "usd", createdAt: ago(0, 2) },
    { id: "cart-74", ref: "D-0074", buyerEmail: null, itemCount: 1, valueCents: 12900, currency: "usd", createdAt: ago(1, 1) },
    { id: "cart-69", ref: "D-0069", buyerEmail: "miles@ridgeway.example", itemCount: 2, valueCents: 12700, currency: "usd", createdAt: ago(2, 6) },
  ],
  abandoned: [
    { id: "ab-31", ref: "A-0031", buyerEmail: "ren@northlake.example", totalCents: 16800, currency: "usd", createdAt: ago(0, 3), recoveryEmailSentAt: null },
    { id: "ab-29", ref: "A-0029", buyerEmail: "sam@trailhead.example", totalCents: 12900, currency: "usd", createdAt: ago(1, 4), recoveryEmailSentAt: ago(1, 1) },
    { id: "ab-26", ref: "A-0026", buyerEmail: null, totalCents: 3800, currency: "usd", createdAt: ago(2, 2), recoveryEmailSentAt: null },
  ],
  shipCharges: [
    { orderRef: "#1047", carrier: "UPS", tracking: "1Z84 6R2 03 9217", costCents: 1248, matched: true, createdAt: ago(0, 9) },
    { orderRef: "#1046", carrier: "USPS", tracking: "9400 1118 9922 3847", costCents: 862, matched: true, createdAt: ago(1, 7) },
    { orderRef: "#1041", carrier: "FedEx", tracking: "7814 3891 2206", costCents: 1575, matched: true, createdAt: ago(3, 3) },
    { orderRef: "—", carrier: "UPS", tracking: "1Z22 4P8 91 7703", costCents: 996, matched: false, createdAt: ago(4, 2) },
  ],
};

const productRows = [
  { id: "prod-pack", title: "Ridgeline Day Pack", status: "active", imageUrl: null, variantCount: 3, updatedAt: ago(2), priceCents: 12900, shipDataOk: true, shipWeightGrams: 780 },
  { id: "prod-shell", title: "Alpine Rain Shell", status: "active", imageUrl: null, variantCount: 4, updatedAt: ago(3), priceCents: 16800, shipDataOk: true, shipWeightGrams: 410 },
  { id: "prod-poles", title: "Granite Trekking Poles", status: "active", imageUrl: null, variantCount: 1, updatedAt: ago(4), priceCents: 8900, shipDataOk: true, shipWeightGrams: 620 },
];

function detailFor(sourceId: string): OrderDetail {
  const imported = sourceId.startsWith("shopify:");
  const id = sourceId.replace(/^(?:shopify|calderyn):/, "");
  const row = orderRows.find((candidate) => candidate.id === id) ?? orderRows[0];
  const fulfilled = row.state === "fulfilled";
  return {
    source: imported ? "shopify" : "calderyn",
    id: row.id,
    ref: row.ref,
    createdAt: row.occurred_at,
    state: row.state,
    financialStatus: row.payment_status,
    archivedAt: null,
    cancelledAt: null,
    cancelReason: null,
    channel: imported ? "shopify" : row.state === "checkout_pending" ? "invoice" : "storefront",
    attribution: imported ? null : "Meta · Summit prospecting",
    currency: row.currency,
    subtotalCents: row.total_cents - 1400,
    shippingCents: 900,
    taxCents: 500,
    discountCents: 0,
    totalCents: row.total_cents,
    refundedCents: row.total_cents - row.remaining_refundable_cents,
    remainingRefundableCents: row.remaining_refundable_cents,
    buyer: row.buyer_email ? { id: `buyer-${row.id}`, email: row.buyer_email } : null,
    shippingAddress: {
      name: "Maya Chen",
      line1: "22 Northstar Avenue",
      line2: null,
      city: "Portland",
      region: "OR",
      postal: "97205",
      country: "US",
    },
    lines: [
      { id: `line-${row.id}-1`, variantId: "var-pack-slate", title: "Ridgeline Day Pack", sku: "RDP-SLATE", quantity: 1, reducedQuantity: 0, unitPriceCents: 12900, fulfilledQuantity: fulfilled ? 1 : 0 },
      { id: `line-${row.id}-2`, variantId: "var-bottle", title: "Summit Trail Bottle", sku: "STB-24", quantity: 2, reducedQuantity: 0, unitPriceCents: 3850, fulfilledQuantity: fulfilled ? 2 : 0 },
    ],
    fulfillments: fulfilled
      ? [{ id: `ful-${row.id}`, createdAt: ago(0, 14), trackingNumber: "1Z84 6R2 03 9217", carrier: "UPS", notifiedAt: ago(0, 14), units: 3, labelUrl: null, labelCostCents: 1248 }]
      : [],
    tags: [...row.tags],
    timeline: [
      { kind: "transition", at: row.occurred_at, title: row.state === "checkout_pending" ? "Invoice created" : "Payment captured", detail: null, author: null },
      { kind: "note", at: ago(0, 11), title: "Customer asked for porch delivery", detail: "Leave behind the planter if nobody is home.", author: "You" },
    ],
    returns: [],
    readOnly: imported,
    signals: { stuckUnfulfilled: row.id === "ord-1048", stuckDays: row.id === "ord-1048" ? 4 : null, repeatCustomer: row.id === "ord-1048", buyerOrderCount: row.id === "ord-1048" ? 4 : 1, refundRisk: false },
    canBuyLabel: !imported && !fulfilled && row.state !== "checkout_pending",
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

if (typeof window !== "undefined" && import.meta.env.DEV && window.location.pathname === "/orders-preview") {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.pathname === "/dashboard/api/orders") return json(legacyPage);
    if (url.pathname === "/dashboard/api/orders/list") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      const source = url.searchParams.get("source");
      const payment = (url.searchParams.get("payment_status") ?? "").split(",").filter(Boolean);
      const fulfillment = url.searchParams.get("fulfillment_status");
      const archived = url.searchParams.get("archived") === "true";
      let rows = orderRows.filter((row) => (archived ? row.archived_at : !row.archived_at));
      if (search) rows = rows.filter((row) => `${row.ref} ${row.buyer_email ?? ""}`.toLowerCase().includes(search));
      if (source) rows = rows.filter((row) => row.source === source);
      if (payment.length) rows = rows.filter((row) => payment.includes(row.payment_status));
      if (fulfillment) rows = rows.filter((row) => row.state === fulfillment || (fulfillment === "unfulfilled" && ["paid", "checkout_pending"].includes(row.state)));
      return json({ rows, total_count: rows.length, offset: 0, limit: 50 });
    }
    if (url.pathname === "/dashboard/api/orders/views") {
      if (method === "POST") return json({ view: { id: "view-preview", name: "My saved view", filters: {}, position: 1 } });
      if (method === "DELETE") return json({ deleted: true });
      return json({ views: [{ id: "view-high-value", name: "High value", filters: { sort: "total", dir: "desc" }, position: 1 }] });
    }
    if (url.pathname === "/dashboard/api/orders/drafts") {
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { lines?: Array<{ variant_id: string; quantity: number }> } : {};
        const lines = (body.lines ?? []).map((line, index) => ({ id: `draft-line-${index}`, variant_id: line.variant_id, title: line.variant_id.includes("shell") ? "Alpine Rain Shell" : "Ridgeline Day Pack", quantity: line.quantity, unit_price_cents: line.variant_id.includes("shell") ? 16800 : 12900, currency: "usd" }));
        return json({ draft: { id: "draft-preview", lines, subtotal_cents: lines.reduce((sum, line) => sum + line.unit_price_cents * line.quantity, 0), currency: "usd", created_at: new Date().toISOString() } });
      }
      if (method === "DELETE") return json({ deleted: true });
      return json({ drafts: [] });
    }
    if (url.pathname === "/dashboard/api/orders/drafts/send") return json({ order_id: "ord-preview-invoice", confirmation_token: "preview", total_cents: 12900, currency: "usd", email_sent: true });
    if (url.pathname === "/dashboard/api/catalog/products") return json({ products: productRows, total: productRows.length });
    if (url.pathname.startsWith("/dashboard/api/catalog/products/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "prod-pack");
      const product = productRows.find((row) => row.id === id) ?? productRows[0];
      return json({ product: { ...product, handle: product.title.toLowerCase().replace(/\s+/g, "-"), description: "", vendor: "Peak & Pine", tags: [], options: [], collections: [], media: [], variants: [{ id: `var-${product.id}`, sku: product.id.toUpperCase(), optionValues: [], retailPriceCents: product.priceCents, compareAtPriceCents: null, unitCostCents: Math.round(product.priceCents * 0.38), weightGrams: product.shipWeightGrams, lengthCm: 30, widthCm: 20, heightCm: 10, inventoryPolicy: "deny" }] } });
    }
    if (url.pathname === "/dashboard/api/assistant") {
      if (method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { message?: string } : {};
        return json({ conversation_id: "conv-orders", message: { id: `assistant-${Date.now()}`, role: "assistant", content: `I’m looking at Orders. ${body.message?.toLowerCase().includes("late") ? "One paid order has been unfulfilled for 4 days: #1048 for Maya Chen." : "You have 6 recent orders, including one that needs fulfillment attention."}`, draftedAction: null, receipts: [], pendingAction: null, createdAt: new Date().toISOString() } });
      }
      return json({ conversations: [], conversation_id: "conv-orders", messages: [{ id: "assistant-welcome", role: "assistant", content: "I can help you find late orders, explain fulfillment status, or draft a customer update.", draftedAction: null, receipts: [], pendingAction: null, createdAt: new Date().toISOString() }] });
    }
    const detailMatch = url.pathname.match(/^\/dashboard\/api\/orders\/(.+)$/);
    if (detailMatch) {
      const sourceId = decodeURIComponent(detailMatch[1]);
      if (sourceId.endsWith("/profit")) return json({ profit: { source: "calderyn", revenue_cents: 20600, cogs_cents: 7820, costs_missing: 0, carrier_cost_cents: 1248, fee_estimate_cents: 897, profit_cents: 10635, margin_pct: 51.6, estimated: true, attribution_label: "Meta · Summit prospecting", not_captured: false } });
      if (sourceId.endsWith("/recovery-email")) return json({ sent: true });
      if (sourceId.includes("/")) return json({ ok: true, sent: true, archived: true, tags: ["priority"], note_id: "note-preview" });
      return json({ order: detailFor(sourceId) });
    }
    if (url.pathname.startsWith("/dashboard/api/orders/bulk/")) return json({ results: orderRows.filter((row) => row.source === "calderyn").map((row) => ({ order_id: row.id, ok: true })) });
    return nativeFetch(input, init);
  };
}

const mainNav = [
  { label: "Home", icon: "home" },
  { label: "Campaigns", icon: "megaphone" },
  { label: "Orders", icon: "doc", active: true },
  { label: "Alerts", icon: "bell" },
];

const orderNav: Array<{ label: string; sub: string }> = [
  { label: "Shipping charges", sub: "labels" },
  { label: "Draft carts", sub: "drafts" },
  { label: "Abandoned", sub: "abandoned" },
];

export default function OrdersPreview() {
  const [nav, setNav] = useState<NavState>({ screen: "orders", param: null, sub: "orders" });
  const [assistantSignal, setAssistantSignal] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem("cd-night-mode") === "0") setDark(false);
    } catch {
      /* Keep the live dashboard's dark default when storage is unavailable. */
    }
    cacheScreenData(SCREEN_CACHE_KEYS.orders, legacyPage);
    cacheScreenData(SCREEN_CACHE_KEYS.ordersList, {
      rows: orderRows.map((row) => ({
        source: row.source,
        id: row.id,
        ref: row.ref,
        buyerEmail: row.buyer_email,
        totalCents: row.total_cents,
        currency: row.currency,
        paymentStatus: row.payment_status,
        state: row.state,
        cancelledAt: row.cancelled_at,
        archivedAt: row.archived_at,
        occurredAt: row.occurred_at,
        itemCount: row.item_count,
        tags: [...row.tags],
        remainingRefundableCents: row.remaining_refundable_cents,
      })),
      totalCount: orderRows.length,
      offset: 0,
      limit: 50,
    });
    setReady(true);
  }, []);

  const setNightMode = useCallback((next: boolean) => {
    const root = document.querySelector(".cd-root");
    if (root) {
      root.classList.add("cd-theming");
      window.setTimeout(() => root.classList.remove("cd-theming"), 480);
    }
    setDark(next);
    try {
      window.localStorage.setItem("cd-night-mode", next ? "1" : "0");
    } catch {
      /* The visual toggle still works for this preview session. */
    }
  }, []);

  const toast = useCallback((text: string, icon?: string, tone?: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, icon, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 3500);
  }, []);

  const navigate = useCallback((screen: Screen, param: string | null = null, sub: string | null = null) => {
    if (screen === "orders") setNav({ screen, param, sub: sub ?? "orders" });
    else toast(`${screen.charAt(0).toUpperCase()}${screen.slice(1)} is outside this Orders preview.`, "info");
  }, [toast]);

  const app = useMemo(() => ({
    t: { dark, density: "compact", radius: 14, glass: 0.72, typeScale: 0.9 },
    authBase: "",
    shopDomain: "peak-and-pine.myshopify.com",
    storeLabel: "Peak & Pine",
    orgSlug: "peak-and-pine",
    demoMode: true,
    canDeleteAccount: false,
    hasCatalog: true,
    nav,
    navigate,
    setNightMode,
    alerts: [], campaigns: [], audit: [], guardrails: null, integrations: [], setIntegrations: () => {}, consent: true, overview: null,
    feed: [], liveOn: true, setLiveOn: () => {}, executeAction: async () => ({ ok: true, receipt: null }), undoAction: () => {}, weatherIntent: async () => true,
    pushAdDraft: () => {}, toast, relTime: () => "just now", openAssistant: () => setAssistantSignal((value) => value + 1), calibration: null, refreshCalibration: () => {},
    actionQueue: [], liveEngine: null, refresh: () => {}, refreshLiveEngine: () => {}, loading: false, booted: true,
  }), [dark, nav, navigate, setNightMode, toast]) as DashboardCtx;

  if (!ready) return null;

  return (
    <div className={`cd-root${dark ? " cd-dark" : ""}`} style={{ "--radius": "14px", "--glass": 0.72, "--density": 0.82, "--type-scale": 0.9 } as React.CSSProperties}>
      <aside className="cd-sidebar">
        <div className="cd-side-brand" onClick={() => setNav({ screen: "orders", param: null, sub: "orders" })}>
          <svg className="cd-logo cd-logo-mark" viewBox="0 0 32 32" fill="none" aria-label="Calderyn">
            <path d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z" fill="var(--accent)" />
            <path d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85" stroke="var(--on-accent)" strokeWidth="3.6" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <div><div className="cd-brand-name">Calderyn</div><div className="cd-brand-sub">Peak & Pine</div></div>
        </div>
        <nav className="cd-side-nav cd-nav-scroll">
          <button type="button" className="cd-ask-btn" onClick={() => setAssistantSignal((value) => value + 1)}>
            <CDIcon name="assist" size={18} /><span>Ask Calderyn</span>
          </button>
          <div className="cd-nav-group">Run</div>
          {mainNav.map((item) => (
            <div key={item.label} style={{ display: "contents" }}>
              <button
                type="button"
                className="cd-nav-item"
                data-active={item.active ? "1" : "0"}
                onClick={() => item.label === "Orders" ? setNav({ screen: "orders", param: null, sub: "orders" }) : toast(`${item.label} is outside this Orders preview.`, "info")}
              >
                <CDIcon name={item.icon} size={18} /><span>{item.label}</span>
                {item.label === "Orders" && <CDIcon name="chevronDown" size={14} className="cd-nav-caret" />}
              </button>
              {item.label === "Orders" && (
                <div className="cd-subnav" role="group" aria-label="Orders">
                  {orderNav.map((child) => (
                    <button
                      key={child.sub}
                      type="button"
                      className="cd-subnav-item"
                      data-active={nav.param == null && nav.sub === child.sub ? "1" : "0"}
                      onClick={() => setNav({ screen: "orders", param: null, sub: child.sub })}
                    >
                      {child.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="cd-nav-group">Build</div>
          <button type="button" className="cd-nav-item" onClick={() => toast("Products is outside this Orders preview.", "info")}><CDIcon name="box" size={18} /><span>Products</span></button>
          <button type="button" className="cd-nav-item" onClick={() => toast("Store is outside this Orders preview.", "info")}><CDIcon name="store" size={18} /><span>Store</span></button>
        </nav>
        <div className="cd-side-foot">
          <div className="cd-live-row">
            <CDIcon name="moon" size={15} strokeWidth={1.9} />
            <span className="flex-1">Night mode</span>
            <Toggle value={dark} onChange={setNightMode} ariaLabel="Night mode" />
          </div>
          <div className="cd-acct"><span className="cd-acct-av">P&amp;P</span><span className="cd-acct-body"><span className="cd-acct-name">Peak &amp; Pine</span><span className="cd-acct-mail">Preview data</span></span></div>
        </div>
      </aside>
      <main className="cd-main"><Orders app={app} /></main>
      <AssistantPanel app={app} openSignal={assistantSignal} prompt={null} />
      <ToastHost toasts={toasts} />
    </div>
  );
}
