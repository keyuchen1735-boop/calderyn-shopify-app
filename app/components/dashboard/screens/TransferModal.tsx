import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import { cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { transferValidation } from "./transfer-modal-state";

// Move stock between two locations. Calls the inventory engine (createTransfer),
// which decrements the source and adds to the destination atomically. Instant
// lands in on_hand; in-transit lands in incoming until received. When no
// variantId is passed (Transfers screen), a search-and-pick step runs first.
export default function TransferModal({
  app,
  variantId = null,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  variantId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // Seed locations from the session cache so the selects are usable
  // immediately; the effect below revalidates against the API.
  const [locations, setLocations] = useState<client.LocationVM[]>(
    () => cachedScreenData<client.LocationVM[]>(SCREEN_CACHE_KEYS.locations) ?? [],
  );
  const [locationsError, setLocationsError] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qty, setQty] = useState(1);
  const [mode, setMode] = useState<"instant" | "in_transit">("instant");
  const [busy, setBusy] = useState(false);

  // Variant picker step (only when the caller didn't pin a variant).
  const [picked, setPicked] = useState<client.InventoryRowVM | null>(null);
  const activeVariantId = variantId ?? picked?.variantId ?? null;
  const picking = !activeVariantId;
  const [pickSearch, setPickSearch] = useState("");
  const [pickQuery, setPickQuery] = useState("");
  const [pickRows, setPickRows] = useState<client.InventoryRowVM[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  // Per-location balances for the chosen variant, fetched once so the From
  // select can show real availability and validation can cap the quantity.
  const [balances, setBalances] = useState<client.VariantBalanceVM[] | null>(null);
  const balancesRequested = useRef(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const toast = app.toast;

  useEffect(() => {
    let alive = true;
    client
      .fetchLocations()
      .then((l) => {
        if (!alive) return;
        setLocations(l);
        setLocationsError(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLocationsError(true);
        toast(
          err instanceof DashboardApiError ? err.message : "Couldn't load locations.",
          "warn",
          "critical",
        );
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  // Debounced variant search for the picker step.
  useEffect(() => {
    const t = setTimeout(() => setPickQuery(pickSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [pickSearch]);

  useEffect(() => {
    if (!picking) return;
    let alive = true;
    client
      .fetchInventoryList({ search: pickQuery || undefined })
      .then((r) => {
        if (!alive) return;
        setPickRows(r.rows.slice(0, 8));
        setPickError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setPickError(
          err instanceof DashboardApiError ? err.message : "Couldn't load variants.",
        );
      });
    return () => {
      alive = false;
    };
  }, [picking, pickQuery]);

  // First time a source is chosen for the active variant, pull its
  // per-location balances (once — the modal is short-lived).
  useEffect(() => {
    if (!activeVariantId || !from || balancesRequested.current) return;
    balancesRequested.current = true;
    client
      .fetchVariantInventory(activeVariantId)
      .then(setBalances)
      .catch(() => {
        // Availability is advisory here: validation passes null through and
        // the server still rejects an over-draw, so a failed lookup must not
        // block the move.
      });
  }, [activeVariantId, from]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus the first control (picker input or From select) when the dialog opens.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button, input, select")?.focus();
  }, []);

  // Keep Tab cycling inside the dialog while it's open.
  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>("button, input, select");
    if (!nodes) return;
    const focusable = Array.from(nodes).filter((n) => !n.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && dialogRef.current?.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const availableAtSource =
    from && balances ? (balances.find((b) => b.locationId === from)?.available ?? 0) : null;

  const submit = async () => {
    if (!activeVariantId) return;
    const problem = transferValidation(from, to, qty, availableAtSource);
    if (problem) {
      app.toast(problem, "warn");
      return;
    }
    setBusy(true);
    try {
      await client.createTransfer({
        variantId: activeVariantId,
        fromLocationId: from,
        toLocationId: to,
        qty,
        mode,
      });
      app.toast("Stock moved.", "check");
      onDone();
      onClose();
    } catch (err) {
      app.toast(err instanceof DashboardApiError ? err.message : "Transfer failed.", "warn", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 80,
        background: "color-mix(in oklch, black 32%, transparent)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Move stock"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        style={{ width: "100%", maxWidth: 420 }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 12 }}>Move stock</div>
          {picking ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <input
                className="cd-input"
                placeholder="Search by product, variant, or SKU"
                aria-label="Search products to move"
                value={pickSearch}
                onChange={(e) => setPickSearch(e.target.value)}
              />
              {pickError ? (
                <div className="cd-caption" style={{ color: "var(--red)" }}>{pickError}</div>
              ) : pickRows == null ? (
                <div className="cd-caption">Loading stock…</div>
              ) : pickRows.length === 0 ? (
                <div className="cd-caption">No tracked variants match that search.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {pickRows.map((r) => (
                    <button
                      key={r.variantId}
                      type="button"
                      className="cd-row"
                      onClick={() => setPicked(r)}
                      style={{
                        width: "100%",
                        background: "none",
                        border: 0,
                        font: "inherit",
                        color: "inherit",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div className="min-w-0" style={{ flex: 1 }}>
                        <div className="cd-row-title truncate">{r.productTitle}</div>
                        <div className="cd-caption truncate">
                          {[r.sku, r.variantTitle].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      <div className="cd-caption tabular-nums" style={{ flexShrink: 0 }}>
                        {r.available} available
                      </div>
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Btn onClick={onClose}>Cancel</Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {picked && (
                <div className="cd-caption truncate">
                  {[picked.productTitle, picked.sku ?? picked.variantTitle]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              <label className="cd-field">
                <span>From</span>
                <select className="cd-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                  <option value="">Choose…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {availableAtSource != null && (
                  <span className="cd-caption tabular-nums">
                    Available at source: {availableAtSource}
                  </span>
                )}
              </label>
              {locationsError && locations.length === 0 && (
                <div className="cd-caption" style={{ color: "var(--red)" }}>
                  Couldn&apos;t load locations.
                </div>
              )}
              <label className="cd-field">
                <span>To</span>
                <select className="cd-input" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Choose…</option>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <label className="cd-field">
                <span>Quantity</span>
                <input
                  className="cd-input tabular-nums"
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.trunc(Number(e.target.value)) || 1))}
                />
              </label>
              <label className="cd-field">
                <span>When</span>
                <select className="cd-input" value={mode} onChange={(e) => setMode(e.target.value as "instant" | "in_transit")}>
                  <option value="instant">Move now</option>
                  <option value="in_transit">Mark in transit</option>
                </select>
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
                <Btn kind="primary" onClick={submit} disabled={busy}>{busy ? "Moving…" : "Move"}</Btn>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
