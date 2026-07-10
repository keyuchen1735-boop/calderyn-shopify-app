import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Pill, Placeholder, TableSkeleton, SkelBar } from "../ui";
import { money, timeAgo } from "../format";
import { reduced } from "../hero/hero-motion";
import { CDIcon } from "../icons";
import { carrierTrackingUrl } from "~/lib/shipping/tracking-url";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchOrderDetail,
  fetchOrderProfit,
  addOrderNote,
  setOrderTags,
  setOrderArchived,
  cancelOrder,
  resendInvoiceEmail,
  receiveOrderReturn,
  cancelOrderReturn,
  type OrderDetail,
  type OrderDetailLine,
  type OrderRow,
  type OrderReturn,
  type OrderProfit,
} from "~/lib/dashboard/orders-client";
import RefundModal from "./RefundModal";
import FulfillModal from "./FulfillModal";
import CancelOrderModal from "./CancelOrderModal";
import ReduceLineModal from "./ReduceLineModal";
import EditInvoiceLinesModal from "./EditInvoiceLinesModal";
import CreateReturnModal from "./CreateReturnModal";
import {
  fulfillmentBadge,
  paymentPillStyle,
  returnStatusPill,
  REFUNDABLE_ORDER_STATES,
  CANCELLABLE_ORDER_STATES,
} from "./order-status";
import { anyLineReturnable, hasOpenReturn } from "./return-preview";
import { buildPrefillParam } from "./order-composer-prefill";

/** Order states where a paid line's quantity can still be reduced. Mirrors EDITABLE_STATES in
 *  app/lib/order/edit.server.ts so the per-line Reduce affordance only ever shows where the
 *  server would actually accept the reduction. */
const REDUCIBLE_ORDER_STATES = new Set(["paid", "partially_fulfilled", "fulfilled", "partially_refunded"]);

/** What the Orders list already knows about a row, handed down so the header paints instantly
 *  (ref/total/badges) while the full detail fetch is still in flight — the screen-cache "seed"
 *  philosophy applied to a detail view that has no cache entry of its own. */
export interface OrderDetailSeed {
  ref: string;
  totalCents: number;
  currency: string;
  createdAt: string | null;
  source: "calderyn" | "shopify";
  state: string;
  financialStatus: string;
}

/** Collapse the two-column detail layout to one column under this width. */
function useNarrowViewport(maxWidth = 900): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [maxWidth]);
  return narrow;
}

/** The RefundModal was built against the Orders-list `OrderRow` shape; this is the only place
 *  that shape has to be reconstructed from the richer detail DTO. */
function buildRefundRow(d: OrderDetail): OrderRow {
  return {
    id: d.id,
    ref: d.ref,
    buyerEmail: d.buyer?.email ?? null,
    itemCount: d.lines.reduce((n, l) => n + l.quantity, 0),
    totalCents: d.totalCents,
    remainingRefundableCents: d.remainingRefundableCents,
    currency: d.currency,
    attribution: d.attribution,
    state: d.state,
    financialStatus: d.financialStatus,
    createdAt: d.createdAt,
  };
}

function TagPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      className="cd-badge"
      style={{ background: "var(--gray-bg)", color: "var(--text-2)", gap: 6 }}
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove tag ${label}`}
        style={{ display: "inline-flex", background: "none", border: 0, padding: 0, cursor: "pointer", color: "inherit" }}
      >
        <CDIcon name="x" size={11} strokeWidth={2} />
      </button>
    </span>
  );
}

const TIMELINE_DOT: Record<OrderDetail["timeline"][number]["kind"], string> = {
  transition: "var(--text-3)",
  note: "var(--accent)",
  refund: "var(--orange)",
  fulfillment: "var(--green)",
  edit: "var(--red)",
  return: "var(--orange)",
};

export default function OrderDetailScreen({
  app,
  sourceId,
  seed,
}: {
  app: DashboardCtx;
  sourceId: string;
  seed?: OrderDetailSeed | null;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [profit, setProfit] = useState<OrderProfit | null>(null);
  const [profitLoading, setProfitLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showFulfill, setShowFulfill] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showEditInvoice, setShowEditInvoice] = useState(false);
  const [showCreateReturn, setShowCreateReturn] = useState(false);
  const [reduceTarget, setReduceTarget] = useState<OrderDetailLine | null>(null);
  const [refundTarget, setRefundTarget] = useState<OrderRow | null>(null);
  const [busyReturnId, setBusyReturnId] = useState<string | null>(null);
  // One stable idempotency key per return, minted the first time it's needed and reused across a
  // retried "Mark received" submit — the same per-intent-key pattern voidIdempotencyKey uses below,
  // just keyed per return since a screen visit can act on more than one.
  const receiveKeysRef = useRef<Map<string, string>>(new Map());
  const receiveKeyFor = (returnId: string): string => {
    let key = receiveKeysRef.current.get(returnId);
    if (!key) {
      key = crypto.randomUUID();
      receiveKeysRef.current.set(returnId, key);
    }
    return key;
  };
  const [resendingInvoice, setResendingInvoice] = useState(false);
  const [voidingInvoice, setVoidingInvoice] = useState(false);
  // One stable key per screen visit (the sibling modals' key-per-open pattern) so a retried Void
  // after a timed-out-but-succeeded request dedups on the server instead of re-cancelling.
  const [voidIdempotencyKey] = useState(() => crypto.randomUUID());
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagsSaving, setTagsSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const narrow = useNarrowViewport();
  const toast = app.toast;
  const screenRef = useRef<HTMLDivElement>(null);

  // Gentle entrance: header first, then the cards stagger in. Keyed on the order's own id (not on
  // `detail` itself, which gets a new object reference on every load()) so a post-action refetch —
  // fulfill, cancel, add a note — never replays this; it only fires once per order actually opened.
  useGSAP(
    () => {
      if (reduced() || !detail || !screenRef.current) return;
      const header = screenRef.current.querySelector<HTMLElement>(".cd-screen-head");
      const cards = screenRef.current.querySelectorAll<HTMLElement>(".cd-card");
      if (header) {
        gsap.from(header, {
          autoAlpha: 0,
          y: -6,
          duration: 0.3,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        });
      }
      if (cards.length) {
        gsap.from(cards, {
          autoAlpha: 0,
          y: 10,
          duration: 0.32,
          stagger: 0.035,
          delay: 0.05,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        });
      }
    },
    { dependencies: [detail?.id], scope: screenRef },
  );

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      setLoadError(false);
      fetchOrderDetail(sourceId)
        .then((d) => {
          if (!signal || signal.alive) {
            setDetail(d);
          }
        })
        .catch((err: unknown) => {
          if (signal && !signal.alive) return;
          setLoadError(true);
          const msg = err instanceof DashboardApiError ? err.message : "Couldn't load this order.";
          toast(msg, "warn", "critical");
        })
        .finally(() => {
          if (!signal || signal.alive) setLoading(false);
        });
    },
    [sourceId, toast],
  );

  // Load profit independently in parallel: fetch after order detail resolves, render skeleton
  // until it lands, and surface any error as a quiet toast (never blocking the order view).
  const loadProfit = useCallback(
    (signal?: { alive: boolean }) => {
      if (!detail) return;
      setProfitLoading(true);
      fetchOrderProfit(sourceId)
        .then((p) => {
          if (!signal || signal.alive) {
            setProfit(p);
          }
        })
        .catch((err: unknown) => {
          if (!signal || signal.alive) {
            const msg = err instanceof DashboardApiError ? err.message : "Couldn't load profit data for this order.";
            toast(msg, "warn");
          }
        })
        .finally(() => {
          if (!signal || signal.alive) setProfitLoading(false);
        });
    },
    [sourceId, detail, toast],
  );

  useEffect(() => {
    const signal = { alive: true };
    loadProfit(signal);
    return () => {
      signal.alive = false;
    };
  }, [loadProfit]);

  useEffect(() => {
    const signal = { alive: true };
    load(signal);
    return () => {
      signal.alive = false;
    };
  }, [load]);

  const back = () => app.navigate("orders", null);

  // Seed the header instantly from the list row; the fetched detail replaces every field once it
  // lands (detail?.x ?? seed?.x always prefers the real fetch).
  const ref = detail?.ref ?? seed?.ref ?? null;
  const totalCents = detail?.totalCents ?? seed?.totalCents ?? 0;
  const currency = detail?.currency ?? seed?.currency ?? "usd";
  const createdAt = detail?.createdAt ?? seed?.createdAt ?? null;
  const state = detail?.state ?? seed?.state ?? null;
  const financialStatus = detail?.financialStatus ?? seed?.financialStatus ?? null;
  const source = detail?.source ?? seed?.source ?? null;
  const readOnly = detail ? detail.readOnly : source === "shopify";
  const cancelledAt = detail?.cancelledAt ?? null;

  const fulfillment = !readOnly && state ? fulfillmentBadge(state, cancelledAt) : null;

  const canFulfill =
    !!detail &&
    !detail.readOnly &&
    detail.lines.some((l) => l.fulfilledQuantity < l.quantity) &&
    (detail.state === "paid" || detail.state === "partially_fulfilled");
  const canRefund = !!detail && !detail.readOnly && REFUNDABLE_ORDER_STATES.has(detail.state);
  // An unpaid invoice gets its own Re-send/Edit items/Void actions below instead of the generic
  // Cancel button — "Void invoice" IS executeCancelAction (refund:false, restock:false), just with
  // invoice-specific copy, so it must not also show as a second, differently-worded Cancel button.
  const isUnpaidInvoice = !!detail && !detail.readOnly && detail.channel === "invoice" && detail.state === "checkout_pending";
  const canCancel =
    !!detail &&
    !detail.readOnly &&
    CANCELLABLE_ORDER_STATES.has(detail.state) &&
    !detail.cancelledAt &&
    !isUnpaidInvoice;
  // Create return (Phase 4 Task 2): native, at least one line still has returnable quantity, and
  // no return already open (createOrderReturn's one-open-return guard, mirrored here so the button
  // never invites a 409 the server would refuse anyway). Must also gate on order state: a return
  // can only be created on orders in states where refund is possible (mirroring REFUNDABLE_ORDER_STATES
  // so a cancelled/refunded order never renders the "Create return" action).
  const canCreateReturn =
    !!detail &&
    !detail.readOnly &&
    REFUNDABLE_ORDER_STATES.has(detail.state) &&
    !hasOpenReturn(detail.returns) &&
    anyLineReturnable(detail.lines, detail.returns);

  const addNote = async () => {
    if (!detail || noteSaving || !noteText.trim()) return;
    setNoteSaving(true);
    try {
      await addOrderNote(detail.id, noteText.trim());
      setNoteText("");
      load();
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't add the note.", "warn", "critical");
    } finally {
      setNoteSaving(false);
    }
  };

  const saveTags = async (next: string[]) => {
    if (!detail) return;
    setTagsSaving(true);
    try {
      await setOrderTags(detail.id, next);
      load();
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't update tags.", "warn", "critical");
    } finally {
      setTagsSaving(false);
    }
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (!detail || !tag || detail.tags.includes(tag)) {
      setTagInput("");
      return;
    }
    setTagInput("");
    saveTags([...detail.tags, tag]);
  };

  const removeTag = (tag: string) => {
    if (!detail) return;
    saveTags(detail.tags.filter((t) => t !== tag));
  };

  const printDoc = (doc: "packing-slip" | "invoice") => {
    window.open(`/dashboard/orders/print/${encodeURIComponent(sourceId)}?doc=${doc}`, "_blank");
  };

  const toggleArchived = async () => {
    if (!detail || archiving) return;
    setArchiving(true);
    try {
      await setOrderArchived(detail.id, !detail.archivedAt);
      toast(detail.archivedAt ? "Order unarchived." : "Order archived.", "check");
      load();
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't update this order.", "warn", "critical");
    } finally {
      setArchiving(false);
    }
  };

  const resendInvoice = async () => {
    if (!detail || resendingInvoice) return;
    setResendingInvoice(true);
    try {
      const res = await resendInvoiceEmail(detail.id);
      toast(
        res.sent ? "Invoice email resent." : "Couldn't resend the invoice email right now.",
        res.sent ? "check" : "warn",
      );
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't resend this invoice.", "warn", "critical");
    } finally {
      setResendingInvoice(false);
    }
  };

  // Void = the shared cancel executor with refund:false (an unpaid invoice never captured
  // anything to refund) and restock:false (nothing was ever reserved for it either).
  const voidInvoice = async () => {
    if (!detail || voidingInvoice) return;
    if (!window.confirm("Void this invoice? The pay link will stop working.")) return;
    setVoidingInvoice(true);
    try {
      await cancelOrder(detail.id, { refund: false, restock: false, idempotencyKey: voidIdempotencyKey });
      toast("Invoice voided.", "check");
      load();
    } catch (err) {
      toast(err instanceof DashboardApiError ? err.message : "Couldn't void this invoice.", "warn", "critical");
    } finally {
      setVoidingInvoice(false);
    }
  };

  const markReturnReceived = async (ret: OrderReturn) => {
    if (!detail || busyReturnId) return;
    const totalRefundCents = ret.lines.reduce((sum, l) => sum + l.refundCents, 0);
    if (!window.confirm(`Restock the selected items and refund ${money(totalRefundCents, detail.currency)}?`)) return;
    setBusyReturnId(ret.id);
    try {
      const res = await receiveOrderReturn(detail.id, { returnId: ret.id, idempotencyKey: receiveKeyFor(ret.id) });
      app.toast(
        `Refunded ${money(res.refundedCents, detail.currency)}.${res.restockedLines > 0 ? ` ${res.restockedLines} item(s) restocked.` : ""}`,
        "check",
      );
      if (res.restockErrors && res.restockErrors.length > 0) {
        app.toast("Return received, but some items could not be restocked. Check your inventory.", "warn");
      }
      load();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't mark this return received.", "warn", "critical");
    } finally {
      setBusyReturnId(null);
    }
  };

  const cancelReturn = async (ret: OrderReturn) => {
    if (!detail || busyReturnId) return;
    if (!window.confirm("Cancel this return? No refund is issued and nothing is restocked.")) return;
    setBusyReturnId(ret.id);
    try {
      await cancelOrderReturn(detail.id, ret.id);
      app.toast("Return cancelled.", "check");
      load();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't cancel this return.", "warn", "critical");
    } finally {
      setBusyReturnId(null);
    }
  };

  return (
    <div ref={screenRef} className="cd-screen" data-screen-label="Order">
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          <Btn small icon="chevronLeft" onClick={back}>
            Back
          </Btn>
          <div>
            <div className="flex items-center" style={{ gap: 8 }}>
              <h1 className="cd-h1" style={{ fontSize: 20 }}>{ref ?? "Order"}</h1>
              {financialStatus && (
                <Pill tone={paymentPillStyle(financialStatus).tone}>
                  {paymentPillStyle(financialStatus).label}
                </Pill>
              )}
              {fulfillment && (
                <span className="cd-badge" style={{ color: fulfillment.tone, background: "var(--gray-bg)" }}>
                  {fulfillment.label}
                </span>
              )}
            </div>
            <div className="cd-caption">
              {createdAt ? `${timeAgo(createdAt)} · ` : ""}
              {money(totalCents, currency)}
              {detail?.channel ? ` · ${detail.channel}` : source === "shopify" ? " · Shopify" : ""}
            </div>
          </div>
        </div>
        {detail && (
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
            {!detail.readOnly && (
              <>
                {canFulfill && (
                  <Btn small icon="truck" onClick={() => setShowFulfill(true)}>
                    Fulfill
                  </Btn>
                )}
                {canRefund && (
                  <Btn small icon="rotate" onClick={() => setRefundTarget(buildRefundRow(detail))}>
                    Refund
                  </Btn>
                )}
                {canCancel && (
                  <Btn small icon="ban" onClick={() => setShowCancel(true)}>
                    Cancel
                  </Btn>
                )}
                {canCreateReturn && (
                  <Btn small icon="undo" onClick={() => setShowCreateReturn(true)}>
                    Create return
                  </Btn>
                )}
                {isUnpaidInvoice && (
                  <>
                    <Btn small icon="mail" onClick={resendInvoice} disabled={resendingInvoice}>
                      {resendingInvoice ? "Resending…" : "Re-send invoice"}
                    </Btn>
                    <Btn small icon="pencil" onClick={() => setShowEditInvoice(true)}>
                      Edit items
                    </Btn>
                    <Btn small kind="danger" icon="ban" onClick={voidInvoice} disabled={voidingInvoice}>
                      {voidingInvoice ? "Voiding…" : "Void invoice"}
                    </Btn>
                  </>
                )}
                <Btn small icon="archive" onClick={toggleArchived} disabled={archiving}>
                  {detail.archivedAt ? "Unarchive" : "Archive"}
                </Btn>
              </>
            )}
            <Btn small icon="printer" onClick={() => printDoc("packing-slip")}>
              Print packing slip
            </Btn>
            <Btn small icon="printer" onClick={() => printDoc("invoice")}>
              Print invoice
            </Btn>
          </div>
        )}
      </header>

      {detail &&
        (detail.signals.repeatCustomer || detail.signals.refundRisk || detail.signals.stuckUnfulfilled) && (
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
            {detail.signals.repeatCustomer && (
              <Pill tone="neutral">Repeat customer ({detail.signals.buyerOrderCount} orders)</Pill>
            )}
            {detail.signals.refundRisk && <Pill tone="warn">High refund history</Pill>}
            {detail.signals.stuckUnfulfilled && (
              <Pill tone="warn">
                Unfulfilled for {detail.signals.stuckDays} day{detail.signals.stuckDays === 1 ? "" : "s"}
              </Pill>
            )}
          </div>
        )}

      {detail?.readOnly && (
        <Card className="cd-card-tight">
          <span className="cd-caption">
            This order was placed and paid on Shopify. It&apos;s shown here as part of your imported
            history.
          </span>
        </Card>
      )}

      {loading && !detail ? (
        <TableSkeleton />
      ) : loadError && !detail ? (
        <Placeholder
          icon="doc"
          title="Couldn't load this order"
          sub="Something went wrong just now. Try again."
          actionLabel="Retry"
          onAction={() => load()}
        />
      ) : detail ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: narrow ? "minmax(0,1fr)" : "minmax(0,1fr) 300px",
            gap: 14,
            alignItems: "start",
          }}
        >
          <div className="flex flex-col" style={{ gap: 12 }}>
            <Card className="cd-card-tight">
              <div className="cd-h2" style={{ marginBottom: 8 }}>Items</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {detail.lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between" style={{ gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="cd-row-title truncate">{l.title}</div>
                      <div className="cd-caption">
                        {l.sku ? `${l.sku} · ` : ""}
                        {l.quantity} × {money(l.unitPriceCents, detail.currency)}
                        {!detail.readOnly ? ` · Fulfilled ${l.fulfilledQuantity}/${l.quantity}` : ""}
                      </div>
                    </div>
                    <div className="cd-row-num tabular-nums" style={{ flexShrink: 0 }}>
                      {money(l.unitPriceCents * l.quantity, detail.currency)}
                    </div>
                    {!detail.readOnly && REDUCIBLE_ORDER_STATES.has(detail.state) && l.quantity > l.fulfilledQuantity && (
                      <Btn small icon="reduce" onClick={() => setReduceTarget(l)}>
                        Reduce
                      </Btn>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <Card className="cd-card-tight">
              <div className="cd-h2" style={{ marginBottom: 8 }}>Payment</div>
              <div className="cd-kv-col">
                <div className="cd-kv"><span>Subtotal</span><b className="ml-auto tabular-nums">{money(detail.subtotalCents, detail.currency)}</b></div>
                <div className="cd-kv"><span>Shipping</span><b className="ml-auto tabular-nums">{money(detail.shippingCents, detail.currency)}</b></div>
                <div className="cd-kv"><span>Tax</span><b className="ml-auto tabular-nums">{money(detail.taxCents, detail.currency)}</b></div>
                {detail.discountCents > 0 && (
                  <div className="cd-kv"><span>Discount</span><b className="ml-auto tabular-nums">-{money(detail.discountCents, detail.currency)}</b></div>
                )}
                <div className="cd-kv"><span>Total</span><b className="ml-auto tabular-nums">{money(detail.totalCents, detail.currency)}</b></div>
                {detail.refundedCents > 0 && (
                  <>
                    <div className="cd-kv"><span>Refunded</span><b className="ml-auto tabular-nums">-{money(detail.refundedCents, detail.currency)}</b></div>
                    <div className="cd-kv"><span>Net</span><b className="ml-auto tabular-nums">{money(detail.totalCents - detail.refundedCents, detail.currency)}</b></div>
                  </>
                )}
              </div>
            </Card>

            {profitLoading && !profit ? (
              <Card className="cd-card-tight">
                <div className="cd-h2" style={{ marginBottom: 8 }}>Profit</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <SkelBar width="60%" />
                  <SkelBar width="50%" />
                  <SkelBar width="70%" />
                </div>
              </Card>
            ) : profit ? (
              <Card className="cd-card-tight">
                <div className="cd-h2" style={{ marginBottom: 8 }}>Profit</div>
                <div className="cd-kv-col">
                  <div className="cd-kv"><span>Revenue</span><b className="ml-auto tabular-nums">{money(profit.revenueCents, detail.currency)}</b></div>
                  <div className="cd-kv"><span>COGS</span><b className="ml-auto tabular-nums">-{money(profit.cogsCents, detail.currency)}</b></div>
                  {profit.costsMissing > 0 && (
                    <div className="cd-caption">
                      {profit.costsMissing} line{profit.costsMissing === 1 ? "" : "s"} missing cost data
                    </div>
                  )}
                  <div className="cd-kv">
                    <span>Carrier cost</span>
                    <b className="ml-auto tabular-nums">
                      {profit.carrierCostCents == null ? "—" : `-${money(profit.carrierCostCents, detail.currency)}`}
                    </b>
                  </div>
                  {profit.carrierCostCents == null && (
                    <div className="cd-caption">No carrier cost recorded</div>
                  )}
                  <div className="cd-kv"><span>Payment fees</span><b className="ml-auto tabular-nums">-{money(profit.feeEstimateCents, detail.currency)}</b></div>
                  <div className="cd-caption">Estimated at 2.9% + 30 cents</div>
                  {profit.attributionLabel && (
                    <div className="cd-caption">Attributed to {profit.attributionLabel}</div>
                  )}
                  <div className="cd-kv" style={{ marginTop: 6, paddingTop: 10, borderTop: "0.5px solid var(--hairline)" }}>
                    <span>Profit</span>
                    <b className="ml-auto tabular-nums">{money(profit.profitCents, detail.currency)}</b>
                  </div>
                  <div className="cd-caption">
                    {profit.marginPct == null
                      ? "Margin unavailable"
                      : `${profit.marginPct.toFixed(1)}% margin${profit.costsMissing > 0 || profit.carrierCostCents === null ? " (partial)" : ""}`}
                  </div>
                </div>
                {detail.readOnly && (
                  <div className="cd-caption" style={{ marginTop: 8 }}>
                    Estimates — this order was placed on Shopify, so costs and fees are approximated.
                  </div>
                )}
              </Card>
            ) : null}

            {detail.fulfillments.length > 0 && (
              <Card className="cd-card-tight">
                <div className="cd-h2" style={{ marginBottom: 8 }}>Fulfillments</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {detail.fulfillments.map((f) => (
                    <div key={f.id}>
                      <div className="flex items-center justify-between">
                        <span className="cd-row-title">{timeAgo(f.createdAt)}</span>
                        <span className="cd-caption">{f.units} unit{f.units === 1 ? "" : "s"}</span>
                      </div>
                      {f.trackingNumber && (
                        <div className="cd-code" style={{ marginTop: 6 }}>
                          <span className="tabular-nums" style={{ minWidth: 0, wordBreak: "break-all" }}>
                            {f.carrier ? `${f.carrier} · ` : ""}
                            {(() => {
                              const url = carrierTrackingUrl(f.carrier, f.trackingNumber);
                              return url ? (
                                <a href={url} target="_blank" rel="noreferrer">
                                  {f.trackingNumber}
                                </a>
                              ) : (
                                f.trackingNumber
                              );
                            })()}
                          </span>
                          <button
                            type="button"
                            className="cd-btn cd-btn-secondary cd-btn-sm"
                            style={{ flexShrink: 0 }}
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(f.trackingNumber ?? "");
                                toast("Copied to clipboard", "check");
                              } catch {
                                toast("Couldn't copy. Select the text manually.", "x", "critical");
                              }
                            }}
                          >
                            Copy
                          </button>
                        </div>
                      )}
                      {f.notifiedAt && <div className="cd-caption" style={{ marginTop: 4 }}>Customer notified</div>}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {detail.returns.length > 0 && (
              <Card className="cd-card-tight">
                <div className="cd-h2" style={{ marginBottom: 8 }}>Returns</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {detail.returns.map((r) => {
                    const pill = returnStatusPill(r.status);
                    const refundCents = r.lines.reduce((sum, l) => sum + l.refundCents, 0);
                    const unitCount = r.lines.reduce((sum, l) => sum + l.quantity, 0);
                    const isOpen = r.status === "open";
                    const isClosed = r.status === "closed" || r.status === "received";
                    const busy = busyReturnId === r.id;
                    return (
                      <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div className="flex items-center justify-between" style={{ gap: 8, flexWrap: "wrap" }}>
                          <div className="flex items-center" style={{ gap: 8 }}>
                            <Pill tone={pill.tone}>{pill.label}</Pill>
                            <span className="cd-row-title">
                              {unitCount} unit{unitCount === 1 ? "" : "s"}
                            </span>
                          </div>
                          <span className="cd-row-num tabular-nums">{money(refundCents, detail.currency)}</span>
                        </div>
                        <div className="cd-caption">
                          {timeAgo(r.createdAt)}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </div>
                        {(isOpen || isClosed) && (
                          <div className="flex items-center" style={{ gap: 8 }}>
                            {isOpen && (
                              <>
                                <Btn small icon="check" onClick={() => markReturnReceived(r)} disabled={busy}>
                                  {busy ? "Working…" : "Mark received"}
                                </Btn>
                                <Btn small kind="danger" icon="x" onClick={() => cancelReturn(r)} disabled={busy}>
                                  Cancel return
                                </Btn>
                              </>
                            )}
                            {isClosed && (
                              <Btn
                                small
                                icon="swap"
                                onClick={() => app.navigate("orders", buildPrefillParam(detail.id, r.id))}
                              >
                                Create replacement order
                              </Btn>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <Card className="cd-card-tight">
              <div className="cd-h2" style={{ marginBottom: 8 }}>Timeline</div>
              {!detail.readOnly && (
                <div className="flex items-center" style={{ gap: 8, marginBottom: 14 }}>
                  <input
                    className="cd-input"
                    type="text"
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addNote();
                    }}
                    placeholder="Add a note"
                    style={{ flex: 1 }}
                  />
                  <Btn small onClick={addNote} disabled={noteSaving || !noteText.trim()}>
                    {noteSaving ? "Adding…" : "Add note"}
                  </Btn>
                </div>
              )}
              {detail.timeline.length === 0 ? (
                <span className="cd-caption">No activity yet.</span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {detail.timeline.map((ev, i) => (
                    <div key={i} className="flex items-start" style={{ gap: 10 }}>
                      <span className="cd-dot" style={{ background: TIMELINE_DOT[ev.kind], marginTop: 5 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="flex items-center" style={{ gap: 8 }}>
                          <span className="cd-row-title">{ev.title}</span>
                          <span className="cd-caption">{timeAgo(ev.at)}</span>
                        </div>
                        {ev.detail && <div className="cd-caption">{ev.detail}</div>}
                        {ev.author && <div className="cd-caption">{ev.author}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="flex flex-col" style={{ gap: 12 }}>
            <Card className="cd-card-tight">
              <div className="cd-h2" style={{ marginBottom: 8 }}>Customer</div>
              {detail.buyer ? (
                <button
                  type="button"
                  className="cd-link"
                  onClick={() => app.navigate("customers", detail.buyer!.id)}
                  style={{ textAlign: "left" }}
                >
                  {detail.buyer.email}
                </button>
              ) : (
                <span className="cd-caption">Guest</span>
              )}
            </Card>

            <Card className="cd-card-tight">
              <div className="cd-h2" style={{ marginBottom: 8 }}>Shipping address</div>
              {detail.shippingAddress ? (
                <div className="cd-caption" style={{ lineHeight: 1.6 }}>
                  {detail.shippingAddress.name && <div>{detail.shippingAddress.name}</div>}
                  <div>{detail.shippingAddress.line1}</div>
                  {detail.shippingAddress.line2 && <div>{detail.shippingAddress.line2}</div>}
                  <div>
                    {[detail.shippingAddress.city, detail.shippingAddress.region, detail.shippingAddress.postal]
                      .filter(Boolean)
                      .join(", ")}
                  </div>
                  <div>{detail.shippingAddress.country}</div>
                </div>
              ) : (
                <span className="cd-caption">No shipping address on file.</span>
              )}
            </Card>

            {!detail.readOnly && (
              <Card className="cd-card-tight">
                <div className="cd-h2" style={{ marginBottom: 8 }}>Tags</div>
                <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {detail.tags.length === 0 && <span className="cd-caption">No tags yet.</span>}
                  {detail.tags.map((t) => (
                    <TagPill key={t} label={t} onRemove={() => removeTag(t)} />
                  ))}
                </div>
                <div className="flex items-center" style={{ gap: 8 }}>
                  <input
                    className="cd-input"
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addTag();
                    }}
                    placeholder="Add a tag"
                    style={{ flex: 1 }}
                  />
                  <Btn small onClick={addTag} disabled={tagsSaving || !tagInput.trim()}>
                    Add
                  </Btn>
                </div>
              </Card>
            )}
          </div>
        </div>
      ) : null}

      {showFulfill && detail && (
        <FulfillModal
          app={app}
          order={detail}
          onClose={() => setShowFulfill(false)}
          onDone={() => load()}
        />
      )}
      {showCancel && detail && (
        <CancelOrderModal
          app={app}
          order={detail}
          onClose={() => setShowCancel(false)}
          onDone={() => load()}
        />
      )}
      {refundTarget && (
        <RefundModal
          app={app}
          order={refundTarget}
          onClose={() => setRefundTarget(null)}
          onDone={() => load()}
        />
      )}
      {reduceTarget && detail && (
        <ReduceLineModal
          app={app}
          order={detail}
          line={reduceTarget}
          onClose={() => setReduceTarget(null)}
          onDone={() => load()}
        />
      )}
      {showEditInvoice && detail && (
        <EditInvoiceLinesModal
          app={app}
          order={detail}
          onClose={() => setShowEditInvoice(false)}
          onDone={() => load()}
        />
      )}
      {showCreateReturn && detail && (
        <CreateReturnModal
          app={app}
          order={detail}
          onClose={() => setShowCreateReturn(false)}
          onDone={() => load()}
        />
      )}
    </div>
  );
}
