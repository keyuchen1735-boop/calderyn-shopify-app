import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Placeholder, TableSkeleton, Tooltip } from "../ui";
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

function IconAction({
  label,
  icon,
  onClick,
  disabled,
  kind = "secondary",
}: {
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary" | "danger";
}) {
  return (
    <Tooltip content={label}>
      <Btn
        small
        kind={kind}
        icon={icon}
        onClick={onClick}
        disabled={disabled}
        ariaLabel={label}
        className="cd-order-icon-action"
      >
        {null}
      </Btn>
    </Tooltip>
  );
}

function OrderDisclosure({
  label,
  count,
  children,
  className = "",
}: {
  label: ReactNode;
  count?: number;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`cd-order-disclosure ${className}`} data-open={open ? "1" : "0"}>
      <button type="button" className="cd-order-disclosure-trigger" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
        {count != null && count > 0 && <span className="cd-order-disclosure-count">{count}</span>}
        <CDIcon name="chevronDown" size={14} />
      </button>
      <div className="cd-order-disclosure-viewport" aria-hidden={!open}>
        <div className="cd-order-disclosure-body">{children}</div>
      </div>
    </div>
  );
}

const TIMELINE_DOT: Record<OrderDetail["timeline"][number]["kind"], string> = {
  transition: "var(--text-3)",
  note: "var(--live)",
  refund: "var(--live)",
  fulfillment: "var(--live)",
  edit: "var(--text-2)",
  return: "var(--live)",
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
  const toast = app.toast;
  const screenRef = useRef<HTMLDivElement>(null);

  // Gentle entrance: header first, then the cards stagger in. Keyed on the order's own id (not on
  // `detail` itself, which gets a new object reference on every load()) so a post-action refetch —
  // fulfill, cancel, add a note — never replays this; it only fires once per order actually opened.
  useGSAP(
    () => {
      if (reduced() || !detail || !screenRef.current) return;
      const header = screenRef.current.querySelector<HTMLElement>(".cd-screen-head");
      const cards = screenRef.current.querySelectorAll<HTMLElement>(".cd-card:not(.cd-order-visual-card)");
      const heroCopy = screenRef.current.querySelector<HTMLElement>(".cd-order-visual-copy");
      const parcelShadow = screenRef.current.querySelector<HTMLElement>(".cd-order-parcel-shadow");
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
      if (heroCopy) {
        gsap.from(heroCopy, {
          autoAlpha: 0,
          y: 5,
          duration: 0.3,
          delay: 0.04,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        });
      }
      if (parcelShadow) {
        gsap.from(parcelShadow, {
          autoAlpha: 0,
          scale: 0.72,
          duration: 0.38,
          delay: 0.06,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        });
      }
    },
    { dependencies: [detail?.id], scope: screenRef },
  );

  const detailUpdateKey = detail
    ? [
        detail.state,
        detail.financialStatus,
        detail.archivedAt ?? "",
        detail.lines.map((line) => `${line.id}:${line.quantity}:${line.fulfilledQuantity}`).join(","),
        detail.fulfillments.length,
        detail.returns.map((item) => `${item.id}:${item.status}`).join(","),
        detail.timeline.length,
        detail.tags.join(","),
        profit?.profitCents ?? "",
      ].join("|")
    : "";
  const detailUpdateSeenRef = useRef<string | null>(null);
  useGSAP(
    () => {
      const previous = detailUpdateSeenRef.current;
      detailUpdateSeenRef.current = detailUpdateKey;
      if (!previous || !detailUpdateKey || previous === detailUpdateKey || reduced() || !screenRef.current) return;
      const surfaces = screenRef.current.querySelectorAll<HTMLElement>(
        ".cd-order-detail-grid .cd-card, .cd-order-journey-step, .cd-order-journey-line, .cd-order-signal-row .cd-badge, .cd-order-visual-total",
      );
      gsap.fromTo(
        surfaces,
        { autoAlpha: 0.72, y: 3, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.24,
          stagger: 0.018,
          ease: "power2.out",
          overwrite: "auto",
          clearProps: "opacity,visibility,transform,willChange",
        },
      );
    },
    { dependencies: [detailUpdateKey], scope: screenRef },
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

  const marginDegrees = Math.max(0, Math.min(100, profit?.marginPct ?? 0)) * 3.6;
  const marginStyle = { "--order-margin": `${marginDegrees}deg` } as CSSProperties;
  const paymentComplete = ["paid", "authorized", "partially_refunded", "refunded"].includes(financialStatus ?? "");
  const fulfillmentComplete = state === "fulfilled" || state === "partially_fulfilled";

  return (
    <div ref={screenRef} className="cd-screen cd-order-detail" data-screen-label="Order">
      <header className="cd-screen-head cd-order-detail-bar">
        <Btn small icon="chevronLeft" onClick={back}>
          Orders
        </Btn>
        {detail && (
          <div className="cd-order-detail-actions flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
            {!detail.readOnly && (
              <>
                {canFulfill && (
                  <Btn small kind="primary" icon="truck" onClick={() => setShowFulfill(true)}>
                    Fulfill
                  </Btn>
                )}
                {canRefund && (
                  <IconAction label="Refund" icon="rotate" onClick={() => setRefundTarget(buildRefundRow(detail))} />
                )}
                {canCancel && (
                  <IconAction label="Cancel order" icon="ban" onClick={() => setShowCancel(true)} kind="danger" />
                )}
                {canCreateReturn && (
                  <IconAction label="Create return" icon="undo" onClick={() => setShowCreateReturn(true)} />
                )}
                {isUnpaidInvoice && (
                  <>
                    <Btn small icon="mail" onClick={resendInvoice} disabled={resendingInvoice}>
                      <span key={resendingInvoice ? "sending" : "send"} className="cd-order-state-label">{resendingInvoice ? "Sending…" : "Send"}</span>
                    </Btn>
                    <IconAction label="Edit invoice items" icon="pencil" onClick={() => setShowEditInvoice(true)} />
                    <IconAction label={voidingInvoice ? "Voiding invoice" : "Void invoice"} icon="ban" onClick={voidInvoice} disabled={voidingInvoice} kind="danger" />
                  </>
                )}
                <IconAction label={detail.archivedAt ? "Unarchive" : "Archive"} icon="archive" onClick={toggleArchived} disabled={archiving} />
              </>
            )}
            <IconAction label="Print packing slip" icon="printer" onClick={() => printDoc("packing-slip")} />
            <IconAction label="Print invoice" icon="doc" onClick={() => printDoc("invoice")} />
          </div>
        )}
      </header>

      <Card className="cd-order-detail-hero cd-order-visual-card">
        <div className="cd-order-parcel-scene" aria-hidden="true">
          <div className="cd-order-parcel">
            <span className="cd-order-parcel-face cd-order-parcel-front">
              <span className="cd-order-parcel-label">{ref ?? "ORDER"}</span>
            </span>
            <span className="cd-order-parcel-face cd-order-parcel-back" />
            <span className="cd-order-parcel-face cd-order-parcel-left" />
            <span className="cd-order-parcel-face cd-order-parcel-right" />
            <span className="cd-order-parcel-face cd-order-parcel-top" />
            <span className="cd-order-parcel-face cd-order-parcel-bottom" />
            <span className="cd-order-parcel-tape" />
          </div>
          <span className="cd-order-parcel-shadow" />
        </div>
        <div className="cd-order-visual-copy">
          <div className="cd-order-visual-identity">
            <div className="cd-order-visual-title">
              <h1 className="cd-h1">{ref ?? "Order"}</h1>
              {readOnly && <span className="cd-badge">Shopify managed</span>}
            </div>
            <div className="cd-order-visual-meta">
              {createdAt && <span><CDIcon name="clock" size={13} />{timeAgo(createdAt)}</span>}
              <span><CDIcon name="store" size={13} />{detail?.channel ?? (source === "shopify" ? "Shopify" : "Calderyn")}</span>
            </div>
          </div>
          <div className="cd-order-visual-summary">
            <span className="cd-caption">Total</span>
            <strong className="cd-order-visual-total tabular-nums">{money(totalCents, currency)}</strong>
            {detail && (detail.signals.repeatCustomer || detail.signals.refundRisk || detail.signals.stuckUnfulfilled) && (
              <div className="cd-order-signal-row">
                {detail.signals.repeatCustomer && <span className="cd-badge">Repeat ×{detail.signals.buyerOrderCount}</span>}
                {detail.signals.refundRisk && <span className="cd-badge cd-order-badge-live">Refund risk</span>}
                {detail.signals.stuckUnfulfilled && <span className="cd-badge cd-order-badge-live">Late {detail.signals.stuckDays}d</span>}
              </div>
            )}
          </div>
          <div className="cd-order-journey" aria-label="Order progress">
            <span className="cd-order-journey-step" data-complete="1">
              <i><CDIcon name="check" size={10} strokeWidth={2.2} /></i>
              <small>Placed</small>
            </span>
            <span className="cd-order-journey-line" data-complete={paymentComplete ? "1" : "0"} />
            <span className="cd-order-journey-step" data-complete={paymentComplete ? "1" : "0"}>
              <i>{paymentComplete && <CDIcon name="check" size={10} strokeWidth={2.2} />}</i>
              <small>{financialStatus ? paymentPillStyle(financialStatus).label : "Payment"}</small>
            </span>
            <span className="cd-order-journey-line" data-complete={fulfillmentComplete ? "1" : "0"} />
            <span className="cd-order-journey-step" data-complete={fulfillmentComplete ? "1" : "0"}>
              <i>{fulfillmentComplete && <CDIcon name="check" size={10} strokeWidth={2.2} />}</i>
              <small>{fulfillment?.label ?? (readOnly ? "Imported" : "Open")}</small>
            </span>
          </div>
        </div>
      </Card>

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
        <div className="cd-order-detail-grid" data-has-fulfillments={detail.fulfillments.length > 0 ? "1" : "0"}>
          <Card className="cd-order-command-deck">
          <div className="cd-order-detail-primary">
            <section className="cd-order-deck-section cd-order-items-card">
              <div className="cd-order-deck-heading">
                <span className="cd-order-deck-heading-icon" aria-hidden="true"><CDIcon name="box" size={15} /></span>
                <div className="cd-h2">Items</div>
              </div>
              <div className="cd-order-item-list">
                {detail.lines.map((l) => (
                  <div key={l.id} className="cd-order-item-row">
                    <span className="cd-order-item-glyph" aria-hidden="true"><CDIcon name="box" size={17} /></span>
                    <div className="cd-order-item-copy">
                      <div className="cd-row-title truncate">{l.title}</div>
                      <div className="cd-caption">{l.quantity} × {money(l.unitPriceCents, detail.currency)}</div>
                      {!detail.readOnly && (
                        <span
                          className="cd-order-item-progress"
                          role="progressbar"
                          aria-label={`${l.fulfilledQuantity} of ${l.quantity} fulfilled`}
                          aria-valuemin={0}
                          aria-valuemax={l.quantity}
                          aria-valuenow={l.fulfilledQuantity}
                        >
                          <i style={{ transform: `scaleX(${l.quantity > 0 ? l.fulfilledQuantity / l.quantity : 0})` }} />
                        </span>
                      )}
                    </div>
                    <span className="cd-order-item-quantity tabular-nums">×{l.quantity}</span>
                    {!detail.readOnly && REDUCIBLE_ORDER_STATES.has(detail.state) && l.quantity > l.fulfilledQuantity && (
                      <IconAction label={`Reduce ${l.title}`} icon="reduce" onClick={() => setReduceTarget(l)} />
                    )}
                  </div>
                ))}
              </div>
            </section>

            {detail.fulfillments.length > 0 && (
              <section className="cd-order-deck-section cd-order-fulfillments-card">
                <div className="cd-order-fulfillments-head">
                  <div className="cd-order-deck-heading">
                    <span className="cd-order-deck-heading-icon" aria-hidden="true"><CDIcon name="truck" size={15} /></span>
                    <div className="cd-h2">Delivery</div>
                  </div>
                </div>
                <div className="cd-order-fulfillment-list">
                  {detail.fulfillments.map((f) => (
                    <div key={f.id} className="cd-order-fulfillment-row">
                      <div className="cd-order-fulfillment-body">
                        <div
                          className="cd-order-fulfillment-route"
                          aria-label={`${f.units} unit${f.units === 1 ? "" : "s"} fulfilled${f.carrier ? ` with ${f.carrier}` : ""}${f.notifiedAt ? ", customer notified" : ""}`}
                        >
                          <span className="cd-order-delivery-state">
                            <i aria-hidden="true"><CDIcon name="check" size={11} strokeWidth={2.2} /></i>
                            Fulfilled
                          </span>
                          <span className="cd-order-delivery-meta">{f.units} unit{f.units === 1 ? "" : "s"}</span>
                          {f.carrier && <span className="cd-order-delivery-meta">{f.carrier}</span>}
                          {f.notifiedAt && (
                            <span className="cd-order-delivery-notified">
                              <CDIcon name="check" size={11} strokeWidth={2.2} /> Customer notified
                            </span>
                          )}
                        </div>
                        {f.trackingNumber && (
                          <div className="cd-code cd-order-tracking">
                            <span className="tabular-nums" style={{ minWidth: 0, wordBreak: "break-all" }}>
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
                        {f.labelUrl && (
                          <div className="cd-caption cd-order-shipping-label">
                            <a href={f.labelUrl} target="_blank" rel="noreferrer">
                              Shipping label
                            </a>
                            {f.labelCostCents != null ? ` · ${money(f.labelCostCents)}` : ""}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {detail.returns.length > 0 && (
              <section className="cd-order-deck-section cd-order-returns-card">
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
                            <span className={`cd-badge${isOpen ? " cd-order-badge-live" : ""}`}>{pill.label}</span>
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
                                  <span key={busy ? "working" : "ready"} className="cd-order-state-label">{busy ? "Working…" : "Mark received"}</span>
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
              </section>
            )}

            <section className="cd-order-deck-section cd-order-timeline-card">
              <OrderDisclosure label={<span className="cd-h2">Activity</span>} count={detail.timeline.length}>
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
                        <span key={noteSaving ? "adding" : "add"} className="cd-order-state-label">{noteSaving ? "Adding…" : "Add"}</span>
                      </Btn>
                    </div>
                  )}
                  {detail.timeline.length === 0 ? (
                    <span className="cd-caption">No activity yet.</span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {detail.timeline.map((ev, i) => (
                        <div key={i} className="cd-order-timeline-event flex items-start" style={{ gap: 10 }}>
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
              </OrderDisclosure>
            </section>
          </div>

          <div className="cd-order-detail-aside">
            <section className="cd-order-deck-section cd-order-person-card">
              <div className="cd-order-person-glyph" aria-hidden="true"><CDIcon name="user" size={20} /></div>
              <div className="cd-h2">Customer</div>
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
              <OrderDisclosure label="Shipping" className="cd-order-side-disclosure">
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
                  ) : <span className="cd-caption">No address.</span>}
              </OrderDisclosure>
              {!detail.readOnly && (
                <OrderDisclosure label="Tags" count={detail.tags.length} className="cd-order-side-disclosure">
                    <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      {detail.tags.map((t) => <TagPill key={t} label={t} onRemove={() => removeTag(t)} />)}
                    </div>
                    <div className="cd-order-more-editor flex items-center" style={{ gap: 8 }}>
                      <input
                        className="cd-input"
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                        placeholder="Add tag"
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Btn small onClick={addTag} disabled={tagsSaving || !tagInput.trim()}>Add</Btn>
                    </div>
                </OrderDisclosure>
              )}
            </section>

            <section className="cd-order-deck-section cd-order-money-card">
              <div className="cd-order-money-head">
                <div className="cd-h2">Payment</div>
                <span className={`cd-badge${detail.financialStatus === "paid" || detail.financialStatus === "authorized" ? " cd-order-badge-live" : ""}`}>
                  {paymentPillStyle(detail.financialStatus).label}
                </span>
              </div>
              <div className="cd-order-money-visual">
                <div className="cd-order-money-total">
                  <strong className="tabular-nums">{money(detail.totalCents, detail.currency)}</strong>
                  {detail.refundedCents > 0 && <small>{money(detail.refundedCents, detail.currency)} refunded</small>}
                </div>
                <div className="cd-order-margin-ring" style={marginStyle} role="img" aria-label={profit?.marginPct == null ? "Margin unavailable" : `${profit.marginPct.toFixed(1)} percent margin`}>
                  <div>
                    <strong>{profitLoading && !profit ? "…" : profit?.marginPct == null ? "—" : `${profit.marginPct.toFixed(0)}%`}</strong>
                    <span>margin</span>
                  </div>
                </div>
              </div>
              <OrderDisclosure label="Costs" className="cd-order-breakdown">
                <div className="cd-order-breakdown-grid">
                  <div className="cd-kv-col">
                    <div className="cd-kv"><span>Subtotal</span><b className="ml-auto tabular-nums">{money(detail.subtotalCents, detail.currency)}</b></div>
                    <div className="cd-kv"><span>Shipping</span><b className="ml-auto tabular-nums">{money(detail.shippingCents, detail.currency)}</b></div>
                    <div className="cd-kv"><span>Tax</span><b className="ml-auto tabular-nums">{money(detail.taxCents, detail.currency)}</b></div>
                    {detail.discountCents > 0 && <div className="cd-kv"><span>Discount</span><b className="ml-auto tabular-nums">-{money(detail.discountCents, detail.currency)}</b></div>}
                    {detail.refundedCents > 0 && <div className="cd-kv"><span>Net</span><b className="ml-auto tabular-nums">{money(detail.totalCents - detail.refundedCents, detail.currency)}</b></div>}
                  </div>
                  {profit && !profit.notCaptured && (
                    <div className="cd-kv-col">
                      <div className="cd-kv"><span>Revenue</span><b className="ml-auto tabular-nums">{money(profit.revenueCents, detail.currency)}</b></div>
                      <div className="cd-kv"><span>Product cost</span><b className="ml-auto tabular-nums">-{money(profit.cogsCents, detail.currency)}</b></div>
                      <div className="cd-kv"><span>Carrier</span><b className="ml-auto tabular-nums">{profit.carrierCostCents == null ? "—" : `-${money(profit.carrierCostCents, detail.currency)}`}</b></div>
                      <div className="cd-kv"><span>Fees</span><b className="ml-auto tabular-nums">-{money(profit.feeEstimateCents, detail.currency)}</b></div>
                      <div className="cd-kv"><span>Profit</span><b className="ml-auto tabular-nums">{profit.profitCents == null ? "—" : money(profit.profitCents, detail.currency)}</b></div>
                    </div>
                  )}
                </div>
              </OrderDisclosure>
            </section>
          </div>
          <section className="cd-order-deck-section cd-order-more-card">
            <div className="cd-order-glance-panel" aria-label="Order facts">
              <div className="cd-order-more-grid">
                <div className="cd-order-more-group cd-order-more-costs">
                  <div className="cd-h2">Costs</div>
                  <div className="cd-order-breakdown-grid">
                    <div className="cd-kv-col">
                      <div className="cd-kv"><span>Subtotal</span><b className="ml-auto tabular-nums">{money(detail.subtotalCents, detail.currency)}</b></div>
                      <div className="cd-kv"><span>Shipping</span><b className="ml-auto tabular-nums">{money(detail.shippingCents, detail.currency)}</b></div>
                      <div className="cd-kv"><span>Tax</span><b className="ml-auto tabular-nums">{money(detail.taxCents, detail.currency)}</b></div>
                      {profit && !profit.notCaptured && <div className="cd-kv cd-order-profit-line"><span>Profit</span><b className="ml-auto tabular-nums">{profit.profitCents == null ? "—" : money(profit.profitCents, detail.currency)}</b></div>}
                    </div>
                  </div>
                </div>

                <div className="cd-order-more-group cd-order-more-shipping">
                  <div className="cd-h2">Shipping</div>
                  {detail.shippingAddress ? (
                    <div className="cd-caption cd-order-more-copy">
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
                  ) : <span className="cd-caption">No address.</span>}
                </div>

                <div className="cd-order-more-group cd-order-more-activity">
                  <div className="cd-h2">Activity</div>
                  {!detail.readOnly && (
                    <div className="cd-order-more-editor flex items-center" style={{ gap: 8, marginBottom: 12 }}>
                      <input
                        className="cd-input"
                        type="text"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addNote(); }}
                        placeholder="Add a note"
                        style={{ flex: 1 }}
                      />
                      <Btn small onClick={addNote} disabled={noteSaving || !noteText.trim()}>
                        <span key={noteSaving ? "adding" : "add"} className="cd-order-state-label">{noteSaving ? "Adding…" : "Add"}</span>
                      </Btn>
                    </div>
                  )}
                  {detail.timeline.length === 0 ? (
                    <span className="cd-caption">No activity yet.</span>
                  ) : (
                    <div className="cd-order-more-events">
                      {detail.timeline.map((ev, i) => (
                        <div key={i} className="cd-order-timeline-event flex items-start" style={{ gap: 10 }}>
                          <span className="cd-dot" style={{ background: TIMELINE_DOT[ev.kind], marginTop: 5 }} />
                          <div style={{ minWidth: 0 }}>
                            <div className="flex items-center" style={{ gap: 8 }}>
                              <span className="cd-row-title">{ev.title}</span>
                              <span className="cd-caption">{timeAgo(ev.at)}</span>
                            </div>
                            {ev.detail && <div className="cd-caption">{ev.detail}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {!detail.readOnly && (
                  <div className="cd-order-more-group cd-order-more-tags">
                    <div className="cd-h2">Tags</div>
                    <div className="flex items-center" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      {detail.tags.map((t) => <TagPill key={t} label={t} onRemove={() => removeTag(t)} />)}
                    </div>
                    <div className="cd-order-more-editor flex items-center" style={{ gap: 8 }}>
                      <input
                        className="cd-input"
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                        placeholder="Add tag"
                        style={{ flex: 1, minWidth: 0 }}
                      />
                      <Btn small onClick={addTag} disabled={tagsSaving || !tagInput.trim()}>Add</Btn>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
          </Card>
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
