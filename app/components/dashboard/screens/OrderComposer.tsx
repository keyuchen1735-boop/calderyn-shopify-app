import { useEffect, useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money, timeAgo } from "../format";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  deleteMerchantDraft,
  fetchMerchantDrafts,
  saveMerchantDraft,
  sendDraftInvoice,
  type MerchantDraftVM,
} from "~/lib/dashboard/orders-client";
import VariantPicker, { type PickedVariant } from "./VariantPicker";

interface ComposerLine {
  variantId: string;
  title: string;
  unitPriceCents: number;
  quantity: number;
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
export default function OrderComposer({ app }: { app: DashboardCtx }) {
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

  const resumeDraft = (d: MerchantDraftVM) => {
    setCartId(d.id);
    setLines(d.lines.map((l) => ({ variantId: l.variantId, title: l.title, unitPriceCents: l.unitPriceCents, quantity: l.quantity })));
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
      return [...cur, { variantId: v.variantId, title: v.title, unitPriceCents: v.unitPriceCents, quantity: 1 }];
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
  const hasAddress = addressHasAnyValue(address);
  const emailValid = EMAIL_RE.test(email.trim());

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
      setLines(draft.lines.map((l) => ({ variantId: l.variantId, title: l.title, unitPriceCents: l.unitPriceCents, quantity: l.quantity })));
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
    <div className="cd-screen" data-screen-label="Create order">
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 10 }}>
          <Btn small icon="chevronLeft" onClick={back}>Back</Btn>
          <h1 className="cd-h1" style={{ fontSize: 22 }}>Create order</h1>
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,1fr) 320px",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div className="flex flex-col" style={{ gap: 16 }}>
          <Card>
            <div className="cd-h2" style={{ marginBottom: 10 }}>Items</div>
            {lines.length === 0 ? (
              <div className="cd-caption" style={{ marginBottom: 12 }}>No items yet. Search below to add some.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                {lines.map((l) => (
                  <div key={l.variantId} className="flex items-center justify-between" style={{ gap: 10 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="cd-row-title truncate">{l.title}</div>
                      <div className="cd-caption">{money(l.unitPriceCents)} each</div>
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
                      {money(l.unitPriceCents * l.quantity)}
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
                  <span className="cd-row-num tabular-nums">{money(subtotalCents)}</span>
                </div>
              </div>
            )}
            <VariantPicker onPick={addVariant} disabled={busy} />
          </Card>

          <Card>
            <div className="cd-h2" style={{ marginBottom: 10 }}>Customer</div>
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
              <div className="cd-caption">Shipping address (optional, enables a shipping and tax quote)</div>
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

          <div className="flex items-center justify-end" style={{ gap: 8 }}>
            <Btn onClick={onSaveDraft} disabled={busy || lines.length === 0}>
              {saving ? "Saving…" : "Save draft"}
            </Btn>
            <Btn kind="primary" icon="mail" onClick={openSendConfirm} disabled={busy || lines.length === 0}>
              Send invoice
            </Btn>
          </div>
        </div>

        <div className="flex flex-col" style={{ gap: 16 }}>
          <Card>
            <div className="cd-h2" style={{ marginBottom: 10 }}>Saved drafts</div>
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
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            background: "color-mix(in oklch, black 32%, transparent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => !sending && setShowSendConfirm(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Send invoice"
            onClick={(e) => e.stopPropagation()}
            style={{ width: "100%", maxWidth: 420 }}
          >
            <Card>
              <div className="cd-h2" style={{ marginBottom: 4 }}>Send this invoice?</div>
              <div className="cd-caption" style={{ marginBottom: 12 }}>
                {lines.length} item{lines.length === 1 ? "" : "s"}, subtotal {money(subtotalCents)}, to {email.trim()}.
                {hasAddress
                  ? " Shipping and tax will be quoted from the address you entered when this sends."
                  : " No shipping address was entered, so this invoices the subtotal only."}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Btn onClick={() => setShowSendConfirm(false)} disabled={sending}>Keep editing</Btn>
                <Btn kind="primary" icon="mail" onClick={confirmSend} disabled={sending}>
                  {sending ? "Sending…" : "Send invoice"}
                </Btn>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
