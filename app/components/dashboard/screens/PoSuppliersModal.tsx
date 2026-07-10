import { useState } from "react";
import type { DashboardCtx } from "../context";
import { Btn, Card, Pill } from "../ui";
import { useModalChrome } from "../use-modal-chrome";
import { DashboardApiError } from "~/lib/dashboard/client";
import {
  createSupplier,
  setSupplierActive,
  updateSupplier,
  type SupplierInputVM,
  type SupplierVM,
} from "~/lib/dashboard/po-client";

// Manage the shop's suppliers inline: list + create/edit form + active toggle.
// Fully controlled: the list always renders from the `suppliers` prop (one
// source of truth — the PO screen's state/cache); every successful mutation
// reports the fresh list upward via onChanged.

interface FormState {
  name: string;
  email: string;
  phone: string;
  leadTime: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: "", email: "", phone: "", leadTime: "", notes: "" };

function toForm(s: SupplierVM): FormState {
  return {
    name: s.name,
    email: s.email ?? "",
    phone: s.phone ?? "",
    leadTime: s.leadTimeDays == null ? "" : String(s.leadTimeDays),
    notes: s.notes ?? "",
  };
}

export default function PoSuppliersModal({
  app,
  suppliers,
  onChanged,
  onClose,
}: {
  app: DashboardCtx;
  suppliers: SupplierVM[];
  onChanged: (suppliers: SupplierVM[]) => void;
  onClose: () => void;
}) {
  /** null = list view; "" = creating; an id = editing that supplier. */
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  // Escape/autofocus/Tab-cycle; capture phase — same layering rule as PoModal.
  const { ref: dialogRef, onKeyDown: onDialogKeyDown } = useModalChrome<HTMLDivElement>({
    onClose,
    escape: "capture",
  });
  const toast = app.toast;

  const applyList = (next: SupplierVM[]) => {
    onChanged([...next].sort((a, b) => a.name.localeCompare(b.name)));
  };

  const submitForm = async () => {
    const name = form.name.trim();
    if (!name) {
      toast("Give the supplier a name.", "warn");
      return;
    }
    let leadTimeDays: number | null = null;
    if (form.leadTime.trim() !== "") {
      const n = Number(form.leadTime);
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        toast("Lead time must be a whole number of days between 0 and 365.", "warn");
        return;
      }
      leadTimeDays = n;
    }
    const input: SupplierInputVM = {
      name,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      notes: form.notes.trim() || null,
      leadTimeDays,
    };
    setBusy(true);
    try {
      if (editing) {
        const updated = await updateSupplier(editing, input);
        applyList(suppliers.map((s) => (s.id === updated.id ? updated : s)));
        toast("Supplier updated.", "check");
      } else {
        const created = await createSupplier(input);
        applyList([...suppliers, created]);
        toast("Supplier added.", "check");
      }
      setEditing(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't save the supplier.",
        "warn",
        "critical",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (supplier: SupplierVM) => {
    if (toggling) return;
    setToggling(supplier.id);
    try {
      const updated = await setSupplierActive(supplier.id, !supplier.active);
      applyList(suppliers.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      toast(
        err instanceof DashboardApiError ? err.message : "Couldn't update the supplier.",
        "warn",
        "critical",
      );
    } finally {
      setToggling(null);
    }
  };

  const showingForm = editing !== null;

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
        aria-label="Suppliers"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        style={{ width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto" }}
      >
        <Card>
          <div
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 12, gap: 8,
            }}
          >
            <div className="cd-h2">Suppliers</div>
            {!showingForm && (
              <Btn small icon="plus" onClick={() => { setEditing(""); setForm(EMPTY_FORM); }}>
                Add supplier
              </Btn>
            )}
          </div>

          {showingForm ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <label className="cd-field">
                <span>Name</span>
                <input
                  className="cd-input"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <label className="cd-field">
                  <span>Email</span>
                  <input
                    className="cd-input"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                </label>
                <label className="cd-field">
                  <span>Phone</span>
                  <input
                    className="cd-input"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  />
                </label>
              </div>
              <label className="cd-field">
                <span>Usual delivery time (days)</span>
                <input
                  className="cd-input tabular-nums"
                  type="number"
                  min={0}
                  max={365}
                  value={form.leadTime}
                  onChange={(e) => setForm({ ...form, leadTime: e.target.value })}
                />
              </label>
              <label className="cd-field">
                <span>Notes</span>
                <textarea
                  className="cd-input"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Btn onClick={() => setEditing(null)} disabled={busy}>Back</Btn>
                <Btn kind="primary" onClick={submitForm} disabled={busy}>
                  {busy ? "Saving…" : editing ? "Save supplier" : "Add supplier"}
                </Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {suppliers.length === 0 ? (
                <div className="cd-caption" style={{ padding: "12px 0" }}>
                  No suppliers yet. Add one to prefill lead times on new purchase orders.
                </div>
              ) : (
                suppliers.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                    <div className="min-w-0" style={{ flex: 1 }}>
                      <div className="cd-row-title truncate">{s.name}</div>
                      <div className="cd-caption truncate">
                        {[
                          s.leadTimeDays != null ? `${s.leadTimeDays}d delivery` : null,
                          s.email,
                          s.phone,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "No contact info"}
                      </div>
                    </div>
                    {!s.active && <Pill>Inactive</Pill>}
                    <Btn
                      small
                      icon="edit"
                      onClick={() => { setEditing(s.id); setForm(toForm(s)); }}
                    >
                      Edit
                    </Btn>
                    <Btn
                      small
                      disabled={toggling === s.id}
                      onClick={() => { void toggleActive(s); }}
                    >
                      {s.active ? "Deactivate" : "Reactivate"}
                    </Btn>
                  </div>
                ))
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                <Btn onClick={onClose}>Done</Btn>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
