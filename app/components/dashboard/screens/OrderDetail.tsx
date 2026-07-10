import { useCallback, useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Pill, Placeholder, TableSkeleton } from "../ui";
import { money, timeAgo } from "../format";
import { CDIcon } from "../icons";
import { carrierTrackingUrl } from "~/lib/shipping/tracking-url";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  fetchOrderDetail,
  addOrderNote,
  setOrderTags,
  setOrderArchived,
  type OrderDetail,
  type OrderRow,
} from "~/lib/dashboard/orders-client";
import RefundModal from "./RefundModal";
import FulfillModal from "./FulfillModal";
import CancelOrderModal from "./CancelOrderModal";
import {
  fulfillmentBadge,
  paymentPillStyle,
  REFUNDABLE_ORDER_STATES,
  CANCELLABLE_ORDER_STATES,
} from "./order-status";

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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showFulfill, setShowFulfill] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [refundTarget, setRefundTarget] = useState<OrderRow | null>(null);
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagsSaving, setTagsSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const narrow = useNarrowViewport();
  const toast = app.toast;

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      setLoading(true);
      setLoadError(false);
      fetchOrderDetail(sourceId)
        .then((d) => {
          if (!signal || signal.alive) setDetail(d);
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
  const canCancel =
    !!detail && !detail.readOnly && CANCELLABLE_ORDER_STATES.has(detail.state) && !detail.cancelledAt;

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

  return (
    <div className="cd-screen" data-screen-label="Order">
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 10, flexWrap: "wrap" }}>
          <Btn small icon="chevronLeft" onClick={back}>
            Back
          </Btn>
          <div>
            <div className="flex items-center" style={{ gap: 8 }}>
              <h1 className="cd-h1" style={{ fontSize: 22 }}>{ref ?? "Order"}</h1>
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
        {detail && !detail.readOnly && (
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
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
            <Btn small icon="archive" onClick={toggleArchived} disabled={archiving}>
              {detail.archivedAt ? "Unarchive" : "Archive"}
            </Btn>
          </div>
        )}
        {detail && (
          <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
            <Btn small icon="printer" onClick={() => printDoc("packing-slip")}>
              Print packing slip
            </Btn>
            <Btn small icon="printer" onClick={() => printDoc("invoice")}>
              Print invoice
            </Btn>
          </div>
        )}
      </header>

      {detail?.readOnly && (
        <Card>
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
            gap: 16,
            alignItems: "start",
          }}
        >
          <div className="flex flex-col" style={{ gap: 16 }}>
            <Card>
              <div className="cd-h2" style={{ marginBottom: 10 }}>Items</div>
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
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <div className="cd-h2" style={{ marginBottom: 10 }}>Payment</div>
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

            {detail.fulfillments.length > 0 && (
              <Card>
                <div className="cd-h2" style={{ marginBottom: 10 }}>Fulfillments</div>
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

            <Card>
              <div className="cd-h2" style={{ marginBottom: 10 }}>Timeline</div>
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

          <div className="flex flex-col" style={{ gap: 16 }}>
            <Card>
              <div className="cd-h2" style={{ marginBottom: 10 }}>Customer</div>
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

            <Card>
              <div className="cd-h2" style={{ marginBottom: 10 }}>Shipping address</div>
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
              <Card>
                <div className="cd-h2" style={{ marginBottom: 10 }}>Tags</div>
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
    </div>
  );
}
