import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card } from "../ui";
import { CDIcon } from "../icons";
import * as client from "~/lib/dashboard/client";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  createPo,
  updatePoDraft,
  type PoDetailVM,
  type PoDraftInputVM,
  type SupplierVM,
} from "~/lib/dashboard/po-client";
import { cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";

// Create or edit a draft purchase order: supplier (optional), destination
// location (active only — the API enforces it too), ETA (auto-filled from the
// supplier's lead time until the merchant touches it), lines added through the
// same search-and-pick pattern as the transfer modal, and notes. Editing is
// draft-only; the server rejects anything else.

interface LineDraft {
  variantId: string;
  sku: string | null;
  title: string;
  qty: number;
  /** Dollars as typed; converted to cents on submit. Empty = cost unknown. */
  cost: string;
}

function etaFromLeadTime(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export default function PoModal({
  app,
  suppliers,
  existing = null,
  onClose,
  onDone,
}: {
  app: DashboardCtx;
  suppliers: SupplierVM[];
  /** When set, the modal edits this draft PO instead of creating a new one. */
  existing?: PoDetailVM | null;
  onClose: () => void;
  onDone: (po: PoDetailVM) => void;
}) {
  const [locations, setLocations] = useState<client.LocationVM[]>(
    () => cachedScreenData<client.LocationVM[]>(SCREEN_CACHE_KEYS.locations) ?? [],
  );
  const [locationsError, setLocationsError] = useState(false);
  const [supplierId, setSupplierId] = useState(existing?.supplierId ?? "");
  const [destination, setDestination] = useState(existing?.destinationLocationId ?? "");
  const [eta, setEta] = useState(existing?.expectedAt ?? "");
  // Once the merchant touches the ETA (or it came from an existing PO), a
  // supplier change must not silently overwrite it.
  const etaTouched = useRef(Boolean(existing?.expectedAt));
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    (existing?.lines ?? []).map((l) => ({
      variantId: l.variantId,
      sku: l.sku,
      title: l.title ?? l.sku ?? "Item",
      qty: l.qtyOrdered,
      cost: l.unitCostCents == null ? "" : (l.unitCostCents / 100).toFixed(2),
    })),
  );
  const [busy, setBusy] = useState(false);

  // Variant search-and-pick (same debounce pattern as TransferModal).
  const [pickSearch, setPickSearch] = useState("");
  const [pickQuery, setPickQuery] = useState("");
  const [pickRows, setPickRows] = useState<client.InventoryRowVM[] | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

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

  useEffect(() => {
    const t = setTimeout(() => setPickQuery(pickSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [pickSearch]);

  useEffect(() => {
    let alive = true;
    client
      .fetchInventoryList({ search: pickQuery || undefined })
      .then((r) => {
        if (!alive) return;
        setPickRows(r.rows.slice(0, 6));
        setPickError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setPickError(err instanceof DashboardApiError ? err.message : "Couldn't load variants.");
      });
    return () => {
      alive = false;
    };
  }, [pickQuery]);

  useEffect(() => {
    // Capture phase + stopPropagation so an Escape here can't also close an
    // underlying drawer (same layering rule as TransferModal).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
  }, []);

  const onDialogKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button, input, select, textarea",
    );
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

  const onSupplierChange = (id: string) => {
    setSupplierId(id);
    if (etaTouched.current) return;
    const supplier = suppliers.find((s) => s.id === id);
    if (supplier?.leadTimeDays != null) setEta(etaFromLeadTime(supplier.leadTimeDays));
  };

  const addLine = (row: client.InventoryRowVM) => {
    setLines((cur) => {
      if (cur.some((l) => l.variantId === row.variantId)) return cur;
      return [
        ...cur,
        {
          variantId: row.variantId,
          sku: row.sku,
          title: row.productTitle,
          qty: 1,
          cost: "",
        },
      ];
    });
  };

  const patchLine = (variantId: string, patch: Partial<LineDraft>) => {
    setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)));
  };

  const removeLine = (variantId: string) => {
    setLines((cur) => cur.filter((l) => l.variantId !== variantId));
  };

  const submit = async () => {
    if (!destination) {
      toast("Choose a destination location.", "warn");
      return;
    }
    if (lines.length === 0) {
      toast("Add at least one product line.", "warn");
      return;
    }
    const payloadLines: PoDraftInputVM["lines"] = [];
    for (const line of lines) {
      if (!Number.isInteger(line.qty) || line.qty < 1) {
        toast("Quantities must be whole numbers of 1 or more.", "warn");
        return;
      }
      let unitCostCents: number | null = null;
      if (line.cost.trim() !== "") {
        const dollars = Number(line.cost);
        if (!Number.isFinite(dollars) || dollars < 0) {
          toast("Unit costs must be zero or more.", "warn");
          return;
        }
        unitCostCents = Math.round(dollars * 100);
      }
      payloadLines.push({ variantId: line.variantId, qty: line.qty, unitCostCents });
    }
    const input: PoDraftInputVM = {
      supplierId: supplierId || null,
      destinationLocationId: destination,
      expectedAt: eta || null,
      notes: notes.trim() || null,
      lines: payloadLines,
    };
    setBusy(true);
    try {
      const po = existing ? await updatePoDraft(existing.id, input) : await createPo(input);
      toast(existing ? "Purchase order updated." : "Purchase order drafted.", "check");
      onDone(po);
      onClose();
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't save the purchase order.",
        "warn",
        "critical",
      );
    } finally {
      setBusy(false);
    }
  };

  const activeSuppliers = suppliers.filter((s) => s.active || s.id === supplierId);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 90,
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
        aria-label={existing ? "Edit purchase order" : "New purchase order"}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto" }}
      >
        <Card>
          <div className="cd-h2" style={{ marginBottom: 12 }}>
            {existing ? `Edit ${existing.poNumber}` : "New purchase order"}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label className="cd-field">
                <span>Supplier</span>
                <select
                  className="cd-input"
                  value={supplierId}
                  onChange={(e) => onSupplierChange(e.target.value)}
                >
                  <option value="">No supplier</option>
                  {activeSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="cd-field">
                <span>Deliver to</span>
                <select
                  className="cd-input"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {locationsError && locations.length === 0 && (
              <div className="cd-caption" style={{ color: "var(--red)" }}>
                Couldn&apos;t load locations.
              </div>
            )}
            <label className="cd-field">
              <span>Expected arrival</span>
              <input
                className="cd-input"
                type="date"
                value={eta}
                onChange={(e) => {
                  etaTouched.current = true;
                  setEta(e.target.value);
                }}
              />
            </label>

            <div>
              <div className="cd-caption" style={{ marginBottom: 6 }}>Lines</div>
              {lines.length === 0 ? (
                <div className="cd-caption">No products yet — search below to add some.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {lines.map((line) => (
                    <div
                      key={line.variantId}
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <div className="min-w-0" style={{ flex: 1 }}>
                        <div className="cd-row-title truncate">{line.title}</div>
                        {line.sku && <div className="cd-caption truncate">{line.sku}</div>}
                      </div>
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={1}
                        aria-label={`Quantity for ${line.sku ?? line.title}`}
                        style={{ width: 76 }}
                        value={line.qty}
                        onChange={(e) =>
                          patchLine(line.variantId, {
                            qty: Math.max(1, Math.trunc(Number(e.target.value)) || 1),
                          })
                        }
                      />
                      <input
                        className="cd-input tabular-nums"
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="Cost $"
                        aria-label={`Unit cost for ${line.sku ?? line.title}`}
                        style={{ width: 96 }}
                        value={line.cost}
                        onChange={(e) => patchLine(line.variantId, { cost: e.target.value })}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${line.sku ?? line.title}`}
                        onClick={() => removeLine(line.variantId)}
                        style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          width: 24, height: 24, background: "none", border: 0,
                          color: "inherit", cursor: "pointer", flexShrink: 0,
                        }}
                      >
                        <CDIcon name="x" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <input
                className="cd-input"
                placeholder="Search by product, variant, or SKU"
                aria-label="Search products to add"
                value={pickSearch}
                onChange={(e) => setPickSearch(e.target.value)}
              />
              {pickError ? (
                <div className="cd-caption" style={{ color: "var(--red)", marginTop: 6 }}>
                  {pickError}
                </div>
              ) : pickRows == null ? (
                <div className="cd-caption" style={{ marginTop: 6 }}>Loading products…</div>
              ) : pickRows.length === 0 ? (
                <div className="cd-caption" style={{ marginTop: 6 }}>
                  No tracked variants match that search.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", marginTop: 4 }}>
                  {pickRows.map((r) => {
                    const added = lines.some((l) => l.variantId === r.variantId);
                    return (
                      <button
                        key={r.variantId}
                        type="button"
                        className="cd-row"
                        disabled={added}
                        onClick={() => addLine(r)}
                        style={{
                          width: "100%", background: "none", border: 0, font: "inherit",
                          color: "inherit", textAlign: "left",
                          cursor: added ? "default" : "pointer",
                          opacity: added ? 0.5 : 1,
                        }}
                      >
                        <div className="min-w-0" style={{ flex: 1 }}>
                          <div className="cd-row-title truncate">{r.productTitle}</div>
                          <div className="cd-caption truncate">
                            {[r.sku, r.variantTitle].filter(Boolean).join(" · ") || "—"}
                          </div>
                        </div>
                        <div className="cd-caption tabular-nums" style={{ flexShrink: 0 }}>
                          {added ? "Added" : `${r.available} available`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <label className="cd-field">
              <span>Notes</span>
              <textarea
                className="cd-input"
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything the supplier should know"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
              <Btn kind="primary" onClick={submit} disabled={busy}>
                {busy ? "Saving…" : existing ? "Save changes" : "Create draft"}
              </Btn>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
