import { useEffect, useState, type FormEvent } from "react";
import type { StudioPolicy, StudioPolicyId } from "~/lib/dashboard/store-client";
import { Btn } from "../ui";

const POLICY_OPTIONS: ReadonlyArray<{ id: StudioPolicyId; label: string }> = [
  { id: "privacy", label: "Privacy" },
  { id: "terms", label: "Terms" },
  { id: "refund", label: "Returns" },
  { id: "shipping", label: "Shipping" },
];

export default function StorePoliciesEditor({
  policies,
  onSave,
  onDelete,
  onClose,
}: {
  policies: StudioPolicy[];
  onSave: (policy: Pick<StudioPolicy, "id" | "title" | "body">) => Promise<void>;
  onDelete: (policyId: StudioPolicyId) => Promise<void>;
  onClose: () => void;
}) {
  const initial = policies.find((policy) => policy.id === "privacy");
  const [selected, setSelected] = useState<StudioPolicyId>("privacy");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const existing = policies.find((policy) => policy.id === selected);

  useEffect(() => {
    setTitle(existing?.title ?? "");
    setBody(existing?.body ?? "");
    setError(null);
    setSaved(false);
    setConfirmDelete(false);
  }, [selected, existing?.title, existing?.body, existing?.updatedAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await onSave({ id: selected, title: title.trim(), body: body.trim() });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this policy.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(selected);
      setTitle("");
      setBody("");
      setConfirmDelete(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove this policy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cd-modal-overlay cd-policy-editor-overlay" role="dialog" aria-modal="true" aria-labelledby="store-policies-title">
      <div className="cd-policy-editor">
        <header className="cd-policy-editor-head">
          <div>
            <h2 id="store-policies-title">Store policies</h2>
            <p>Write the legal information customers see in your storefront footer.</p>
          </div>
          <button type="button" className="cd-policy-close" onClick={onClose} aria-label="Close store policies" disabled={busy}>×</button>
        </header>

        <div className="cd-policy-editor-body">
          <div className="cd-policy-tabs" role="tablist" aria-label="Store policies">
            {POLICY_OPTIONS.map((option) => {
              const persisted = policies.some((policy) => policy.id === option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={selected === option.id}
                  aria-controls={`policy-panel-${option.id}`}
                  data-active={selected === option.id ? "1" : "0"}
                  onClick={() => setSelected(option.id)}
                >
                  <span>{option.label}</span>
                  <small>{persisted ? "Added" : "Not added"}</small>
                </button>
              );
            })}
          </div>

          <form id={`policy-panel-${selected}`} className="cd-policy-form" role="tabpanel" onSubmit={save}>
            <label className="cd-field">
              <span>Title</span>
              <input
                className="cd-input"
                aria-label="Policy title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                required
              />
            </label>
            <label className="cd-field cd-policy-text-field">
              <span>Policy text</span>
              <textarea
                className="cd-input cd-policy-textarea"
                aria-label="Policy text"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                maxLength={50_000}
                required
              />
            </label>
            <div className="cd-policy-form-foot">
              <div className="cd-policy-feedback" aria-live="polite">
                {error ? <span data-error="1">{error}</span> : saved ? <span>Saved</span> : null}
              </div>
              <div className="cd-policy-actions">
                {existing && !confirmDelete && (
                  <Btn kind="secondary" small onClick={() => setConfirmDelete(true)} disabled={busy} ariaLabel={`Delete ${selected} policy`}>
                    Delete
                  </Btn>
                )}
                {existing && confirmDelete && (
                  <>
                    <span className="cd-policy-confirm">Remove this policy?</span>
                    <Btn small onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Btn>
                    <Btn kind="danger" small onClick={() => void remove()} disabled={busy}>Remove</Btn>
                  </>
                )}
                <Btn kind="primary" small type="submit" disabled={busy || !title.trim() || !body.trim()}>
                  {busy ? "Saving…" : "Save policy"}
                </Btn>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
