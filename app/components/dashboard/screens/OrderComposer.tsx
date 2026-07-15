import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, timeAgo } from "../format";
import { reduced } from "../hero/hero-motion";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  deleteMerchantDraft,
  fetchMerchantDrafts,
  fetchOrderDetail,
  saveMerchantDraft,
  sendDraftInvoice,
  type MerchantDraftVM,
} from "~/lib/dashboard/orders-client";
import VariantPicker, { type PickedVariant } from "./VariantPicker";
import { useModalEntrance } from "./order-modal-motion";
import { parsePrefillParam } from "./order-composer-prefill";

interface ComposerLine {
  variantId: string;
  title: string;
  unitPriceCents: number;
  quantity: number;
  // The variant picker (VariantPicker/PickedVariant) carries no currency field today — every
  // catalog price it surfaces is a bare cents number — so a freshly-added line defaults to "usd"
  // until a save/resume round trip through the draft cart supplies the shop's real currency
  // (MerchantDraftLineVM.currency, priced via cart.server.ts's single pricing path).
  currency: string;
}

const MIN_QTY = 1;
const MAX_QTY = 999;
const NOTE_MAX = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Address {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

const EMPTY_ADDRESS: Address = { line1: "", line2: "", city: "", region: "", postal: "", country: "" };

function addressHasAnyValue(a: Address): boolean {
  return Object.values(a).some((v) => v.trim() !== "");
}

// Create-order flow (Phase 3 Task 5): reached via Orders' "Create order" header button, using the
// reserved nav.param "new" the same way Campaigns' composer does. Builds a merchant-draft cart
// (saveMerchantDraft), optionally resumes/deletes an existing one (fetchMerchantDrafts), then
// either leaves it as a draft or turns it into a real invoice + pay-link email (sendDraftInvoice).
//
// `prefillParam` (Phase 4 Task 2, exchange-lite): when set, this visit came from a closed return's
// "Create replacement order" button (order-composer-prefill.ts's URL-encoded param — see that
// module's header for why a URL, not sessionStorage/nav state, was chosen: it survives a refresh).
// Parsed on mount, then the source order is re-fetched by id and the return's own lines seed the
// cart — a stale/foreign/malformed param just falls back to a blank composer rather than throwing.
export default function OrderComposer({ app, prefillParam }: { app: DashboardCtx; prefillParam?: string | null }) {
  const back = () => app.navigate("orders", null);

  const [drafts, setDrafts] = useState<MerchantDraftVM[] | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftsError, setDraftsError] = useState(false);

  const loadDrafts = () => {
    setDraftsLoading(true);
    setDraftsError(false);
    fetchMerchantDrafts()
      .then((rows) => setDrafts(rows))
      .catch(() => {
        // Surfaced as an explicit error state in the drafts panel — a failed fetch must never
        // render as "no saved drafts".
        setDrafts(null);
        setDraftsError(true);
      })
      .finally(() => setDraftsLoading(false));
  };
  useEffect(() => {
    loadDrafts();
  }, []);

  const [cartId, setCartId] = useState<string | null>(null);
  const [lines, setLines] = useState<ComposerLine[]>([]);
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Exchange-lite prefill (Phase 4 Task 2): non-null once a valid prefillParam resolves to a real
  // return with at least one still-known variant. Threaded into the send call so the new order's
  // attribution records `{ exchange_for: <returnId> }`.
  const [exchangeForReturnId, setExchangeForReturnId] = useState<string | null>(null);
  const [exchangeOrderRef, setExchangeOrderRef] = useState<string | null>(null);

  useEffect(() => {
    if (!prefillParam) return;
    const parsed = parsePrefillParam(prefillParam);
    if (!parsed) return;
    let alive = true;
    fetchOrderDetail(parsed.orderId)
      .then((detail) => {
        if (!alive) return;
        const target = detail.returns.find((r) => r.id === parsed.returnId);
        if (!target) {
          app.toast("Couldn't find that return to prefill from.", "warn");
          return;
        }
        const lineById = new Map(detail.lines.map((l) => [l.id, l]));
        const prefilled: ComposerLine[] = [];
        for (const rl of target.lines) {
          const src = lineById.get(rl.orderLineId);
          if (!src || !src.variantId) continue;
          prefilled.push({
            variantId: src.variantId,
            title: src.title,
            unitPriceCents: src.unitPriceCents,
            quantity: rl.quantity,
            currency: detail.currency,
          });
        }
        if (prefilled.length === 0) {
          app.toast("That return's items are no longer available to re-order.", "warn");
          return;
        }
        setLines(prefilled);
        setExchangeForReturnId(target.id);
        setExchangeOrderRef(detail.ref);
      })
      .catch(() => {
        if (alive) app.toast("Couldn't load the return to prefill from.", "warn", "critical");
      });
    return () => {
      alive = false;
    };
    // One-shot prefill on mount — prefillParam is stable for the life of this composer visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillParam]);

  // Gentle one-time entrance: header first, then the item/customer/drafts cards stagger in. Mounts
  // once per composer visit (nav.param "new" -> a fresh OrderComposer instance), so this never
  // replays on line edits or draft saves.
  const screenRef = useRef<HTMLDivElement>(null);
  const seenLineIdsRef = useRef<Set<string>>(new Set());
  const lineKeys = lines.map((line) => line.variantId).join("|");
  useGSAP(
    () => {
      if (reduced() || !screenRef.current) return;
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
    { scope: screenRef },
  );

  useGSAP(
    () => {
      if (!screenRef.current) return;
      const known = seenLineIdsRef.current;
      const fresh = Array.from(screenRef.current.querySelectorAll<HTMLElement>(".cd-order-composer-line"))
        .filter((row) => !known.has(row.dataset.variant ?? ""));
      seenLineIdsRef.current = new Set(lines.map((line) => line.variantId));
      if (reduced() || fresh.length === 0) return;
      gsap.from(fresh, {
        autoAlpha: 0,
        x: -10,
        scale: 0.985,
        duration: 0.3,
        stagger: 0.025,
        ease: "power2.out",
        clearProps: "opacity,visibility,transform",
      });
    },
    { dependencies: [lineKeys], scope: screenRef },
  );

  const resumeDraft = (d: MerchantDraftVM) => {
    setCartId(d.id);
    setLines(
      d.lines.map((l) => ({
        variantId: l.variantId,
        title: l.title,
        unitPriceCents: l.unitPriceCents,
        quantity: l.quantity,
        currency: l.currency,
      })),
    );
  };

  const removeDraft = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await deleteMerchantDraft(id);
      if (cartId === id) {
        setCartId(null);
        setLines([]);
      }
      loadDrafts();
      app.toast("Draft deleted.", "check");
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't delete this draft.", "warn", "critical");
    } finally {
      setDeletingId(null);
    }
  };

  const addVariant = (v: PickedVariant) => {
    setLines((cur) => {
      const existing = cur.find((l) => l.variantId === v.variantId);
      if (existing) {
        return cur.map((l) =>
          l.variantId === v.variantId ? { ...l, quantity: Math.min(MAX_QTY, l.quantity + 1) } : l,
        );
      }
      // PickedVariant carries no currency (see ComposerLine's comment) — a brand-new line can't
      // know its own currency. But once a RESUMED draft already has lines, they carry the shop's
      // real priced currency (MerchantDraftLineVM.currency) — inherit that instead of hard-coding
      // "usd", so a non-USD shop adding a 2nd+ item to an existing draft doesn't flash the wrong
      // symbol. "usd" remains the true fallback only for a from-scratch draft's first line, and is
      // corrected the moment saveDraft's server-priced response replaces it.
      const inheritedCurrency = cur[0]?.currency ?? "usd";
      return [...cur, { variantId: v.variantId, title: v.title, unitPriceCents: v.unitPriceCents, quantity: 1, currency: inheritedCurrency }];
    });
  };

  const setQty = (variantId: string, raw: string) => {
    const n = Math.round(Number(raw));
    const clamped = Number.isFinite(n) ? Math.max(MIN_QTY, Math.min(MAX_QTY, n)) : MIN_QTY;
    setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, quantity: clamped } : l)));
  };

  const removeLine = (variantId: string) => {
    setLines((cur) => cur.filter((l) => l.variantId !== variantId));
  };

  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  // Every line on one order shares one shop currency; the first line's is authoritative once any
  // exist (defaults to "usd" — see ComposerLine's comment — before the first item is added).
  const currency = lines[0]?.currency ?? "usd";
  const hasAddress = addressHasAnyValue(address);
  const emailValid = EMAIL_RE.test(email.trim());
  const subtotalRef = useRef<HTMLSpanElement>(null);
  const subtotalSeenRef = useRef(false);
  useGSAP(
    () => {
      if (!subtotalRef.current) return;
      if (!subtotalSeenRef.current) {
        subtotalSeenRef.current = true;
        return;
      }
      if (reduced()) return;
      gsap.fromTo(
        subtotalRef.current,
        { autoAlpha: 0.45, y: 3, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.22,
          ease: "power2.out",
          overwrite: "auto",
          clearProps: "opacity,visibility,transform,willChange",
        },
      );
    },
    { dependencies: [subtotalCents], scope: screenRef },
  );

  const saveDraft = async (): Promise<MerchantDraftVM | null> => {
    if (lines.length === 0) {
      app.toast("Add at least one item first.", "warn");
      return null;
    }
    try {
      const draft = await saveMerchantDraft({
        cartId: cartId ?? undefined,
        lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      });
      setCartId(draft.id);
      setLines(
        draft.lines.map((l) => ({
          variantId: l.variantId,
          title: l.title,
          unitPriceCents: l.unitPriceCents,
          quantity: l.quantity,
          currency: l.currency,
        })),
      );
      loadDrafts();
      return draft;
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't save this draft.", "warn", "critical");
      return null;
    }
  };

  const onSaveDraft = async () => {
    if (saving || sending) return;
    setSaving(true);
    try {
      const draft = await saveDraft();
      if (draft) app.toast("Draft saved.", "check");
    } finally {
      setSaving(false);
    }
  };

  const openSendConfirm = () => {
    if (lines.length === 0) {
      app.toast("Add at least one item first.", "warn");
      return;
    }
    if (!emailValid) {
      app.toast("Enter a valid customer email.", "warn");
      return;
    }
    if (hasAddress && !address.line1.trim()) {
      app.toast("Enter a street address, or clear the other address fields.", "warn");
      return;
    }
    setShowSendConfirm(true);
  };

  const confirmSend = async () => {
    if (sending) return;
    setSending(true);
    try {
      const draft = await saveDraft();
      if (!draft) return;
      const result = await sendDraftInvoice({
        cartId: draft.id,
        email: email.trim(),
        address: hasAddress
          ? {
              line1: address.line1.trim(),
              line2: address.line2.trim() || undefined,
              city: address.city.trim() || undefined,
              region: address.region.trim() || undefined,
              postal: address.postal.trim() || undefined,
              country: address.country.trim() || undefined,
            }
          : undefined,
        note: note.trim() || undefined,
        exchangeForReturnId: exchangeForReturnId ?? undefined,
      });
      app.toast(
        result.emailSent
          ? `Invoice sent for ${money(result.totalCents, result.currency)}.`
          : `Invoice created for ${money(result.totalCents, result.currency)}, but the email didn't go out.`,
        result.emailSent ? "check" : "warn",
      );
      setShowSendConfirm(false);
      app.navigate("orders", result.orderId);
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Couldn't send this invoice.", "warn", "critical");
    } finally {
      setSending(false);
    }
  };

  const busy = saving || sending;

  return (
    <div ref={screenRef} className="cd-screen cd-order-composer" data-screen-label="Create order">
      <header className="cd-screen-head cd-order-composer-head">
        <div className="flex items-center" style={{ gap: 10 }}>
          <Btn small icon="chevronLeft" onClick={back}>Back</Btn>
          <h1 className="cd-h1" style={{ fontSize: 22 }}>Create order</h1>
        </div>
      </header>

      {exchangeForReturnId && (
        <Card className="cd-card-tight">
          <span className="cd-caption">
            Replacement for return on order {exchangeOrderRef ?? "…"}. The refund and the
            replacement order are separate transactions. The customer is refunded for the return
            and pays for the replacement normally.
          </span>
        </Card>
      )}

      <div
        className="cd-order-composer-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px",
          gap: 14,
          alignItems: "start",
        }}
      >
        <div className="flex flex-col" style={{ gap: 12 }}>
          <Card className="cd-card-tight cd-order-composer-card cd-order-composer-items">
            <div className="cd-h2" style={{ marginBottom: 8 }}>Items</div>
            {lines.length === 0 ? (
              <div className="cd-caption" style={{ marginBottom: 12 }}>No items yet. Search below to add some.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                {lines.map((l) => (
                  <div key={l.variantId} className="cd-order-composer-line flex items-center justify-between" data-variant={l.variantId} style={{ gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="cd-row-title truncate">{l.title}</div>
                      <div className="cd-caption">{money(l.unitPriceCents, l.currency)} each</div>
                    </div>
                    <input
                      className="cd-input tabular-nums"
                      type="number"
                      min={MIN_QTY}
                      max={MAX_QTY}
                      value={l.quantity}
                      onChange={(e) => setQty(l.variantId, e.target.value)}
                      style={{ width: 72, textAlign: "right", flexShrink: 0 }}
                    />
                    <div className="cd-row-num tabular-nums" style={{ width: 84, textAlign: "right", flexShrink: 0 }}>
                      {money(l.unitPriceCents * l.quantity, l.currency)}
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLine(l.variantId)}
                      aria-label={`Remove ${l.title}`}
                      style={{ background: "none", border: 0, padding: 4, cursor: "pointer", color: "var(--text-3)" }}
                    >
                      <CDIcon name="x" size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between" style={{ paddingTop: 6, borderTop: "1px solid var(--hairline)" }}>
                  <span className="cd-row-title">Subtotal</span>
                  <span ref={subtotalRef} className="cd-row-num tabular-nums">{money(subtotalCents, currency)}</span>
                </div>
              </div>
            )}
            <VariantPicker onPick={addVariant} disabled={busy} />
          </Card>

          <Card className="cd-card-tight cd-order-composer-card cd-order-composer-customer">
            <div className="cd-h2" style={{ marginBottom: 8 }}>Customer</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <label className="cd-field">
                <span>Email</span>
                <input
                  className="cd-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="customer@example.com"
                  disabled={busy}
                />
              </label>
              <div className="cd-caption">Shipping address (optional)</div>
              <label className="cd-field">
                <span>Address line 1</span>
                <input
                  className="cd-input"
                  type="text"
                  value={address.line1}
                  onChange={(e) => setAddress((a) => ({ ...a, line1: e.target.value }))}
                  disabled={busy}
                />
              </label>
              <label className="cd-field">
                <span>Address line 2</span>
                <input
                  className="cd-input"
                  type="text"
                  value={address.line2}
                  onChange={(e) => setAddress((a) => ({ ...a, line2: e.target.value }))}
                  disabled={busy}
                />
              </label>
              <div className="flex items-center" style={{ gap: 10 }}>
                <label className="cd-field" style={{ flex: 1 }}>
                  <span>City</span>
                  <input
                    className="cd-input"
                    type="text"
                    value={address.city}
                    onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
                    disabled={busy}
                  />
                </label>
                <label className="cd-field" style={{ flex: 1 }}>
                  <span>State / region</span>
                  <input
                    className="cd-input"
                    type="text"
                    value={address.region}
                    onChange={(e) => setAddress((a) => ({ ...a, region: e.target.value }))}
                    disabled={busy}
                  />
                </label>
              </div>
              <div className="flex items-center" style={{ gap: 10 }}>
                <label className="cd-field" style={{ flex: 1 }}>
                  <span>Postal code</span>
                  <input
                    className="cd-input"
                    type="text"
                    value={address.postal}
                    onChange={(e) => setAddress((a) => ({ ...a, postal: e.target.value }))}
                    disabled={busy}
                  />
                </label>
                <label className="cd-field" style={{ flex: 1 }}>
                  <span>Country</span>
                  <input
                    className="cd-input"
                    type="text"
                    value={address.country}
                    onChange={(e) => setAddress((a) => ({ ...a, country: e.target.value }))}
                    placeholder="US"
                    disabled={busy}
                  />
                </label>
              </div>
              <label className="cd-field">
                <span>Note (optional)</span>
                <input
                  className="cd-input"
                  type="text"
                  maxLength={NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Included in the invoice email"
                  disabled={busy}
                />
              </label>
            </div>
          </Card>

          <div className="cd-order-composer-actions flex items-center justify-end" style={{ gap: 8 }}>
            <Btn onClick={onSaveDraft} disabled={busy || lines.length === 0}>
              {saving ? "Saving…" : "Save draft"}
            </Btn>
            <Btn kind="primary" icon="mail" onClick={openSendConfirm} disabled={busy || lines.length === 0}>
              Send invoice
            </Btn>
          </div>
        </div>

        <div className="flex flex-col" style={{ gap: 12 }}>
          <Card className="cd-card-tight cd-order-composer-card cd-order-drafts-card">
            <div className="cd-h2" style={{ marginBottom: 8 }}>Saved drafts</div>
            {draftsLoading ? (
              <div className="cd-caption">Loading…</div>
            ) : draftsError ? (
              <Placeholder
                icon="doc"
                title="Couldn't load drafts"
                sub="Something went wrong just now. Try again."
                actionLabel="Retry"
                onAction={loadDrafts}
              />
            ) : !drafts || drafts.length === 0 ? (
              <Placeholder icon="doc" title="No saved drafts" sub="Drafts you save here will show up for you to resume." />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {drafts.map((d) => (
                  <div key={d.id} className="flex items-center justify-between" style={{ gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="cd-row-title">{money(d.subtotalCents, d.currency)}</div>
                      <div className="cd-caption">
                        {d.lines.length} item{d.lines.length === 1 ? "" : "s"} · {timeAgo(d.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
                      <Btn small onClick={() => resumeDraft(d)} disabled={busy}>Resume</Btn>
                      <Btn
                        small
                        kind="danger"
                        icon="x"
                        onClick={() => removeDraft(d.id)}
                        disabled={busy || deletingId === d.id}
                      >
                        {deletingId === d.id ? "Deleting…" : "Delete"}
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {showSendConfirm && (
        <SendConfirmDialog
          itemCount={lines.length}
          subtotalCents={subtotalCents}
          currency={currency}
          email={email}
          hasAddress={hasAddress}
          sending={sending}
          onCancel={() => setShowSendConfirm(false)}
          onConfirm={confirmSend}
        />
      )}
    </div>
  );
}

/** The composer's own send-confirm dialog, split out as its own component (rather than an inline
 *  conditional block) purely so it mounts fresh each time it opens — matching every other order
 *  modal's lifecycle (see RefundModal etc.), which is what lets useModalEntrance's mount-time
 *  animation fire on every open instead of only once for the whole composer screen. */
function SendConfirmDialog({
  itemCount,
  subtotalCents,
  currency,
  email,
  hasAddress,
  sending,
  onCancel,
  onConfirm,
}: {
  itemCount: number;
  subtotalCents: number;
  currency: string;
  email: string;
  hasAddress: boolean;
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { overlayRef, dialogRef } = useModalEntrance();
  return (
    <div
      ref={overlayRef}
      className="cd-modal-overlay"
      onClick={() => !sending && onCancel()}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send invoice"
        onClick={(e) => e.stopPropagation()}
        className="cd-modal-dialog"
        style={{ maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 4 }}>Send this invoice?</div>
          <div className="cd-caption" style={{ marginBottom: 12 }}>
            {itemCount} item{itemCount === 1 ? "" : "s"}, subtotal {money(subtotalCents, currency)}, to {email.trim()}.
            {hasAddress
              ? " Shipping and tax will be quoted from the address you entered when this sends."
              : " No shipping address was entered, so this invoices the subtotal only."}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Btn onClick={onCancel} disabled={sending}>Keep editing</Btn>
            <Btn kind="primary" icon="mail" onClick={onConfirm} disabled={sending}>
              {sending ? "Sending…" : "Send invoice"}
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}
