// Calderyn DashV2 — "Report a bug": floating launcher + modal, rendered with the
// dashboard's own cd-* design system. POSTs multipart form-data to
// /dashboard/api/bug-report (same shared brain as the embedded app).
import { useCallback, useEffect, useRef, useState } from "react";

import { CDIcon } from "./icons";
import { Btn } from "./ui";
import type { DashboardCtx } from "./context";

const MAX_FILES = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Item = { file: File; url: string };

export default function BugReportButton({
  app,
  openSignal,
}: {
  app: DashboardCtx;
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);

  // The mobile "More" sheet opens this by bumping openSignal (the floating
  // launcher is hidden at phone width). Each increment re-opens it.
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDescription("");
    setEmail("");
    setItems((prev) => {
      prev.forEach((it) => window.URL.revokeObjectURL(it.url));
      return [];
    });
    setError(null);
  };

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked) return;
    setError(null);
    const next: File[] = [];
    for (const f of Array.from(picked)) {
      if (!ALLOWED.includes(f.type)) {
        setError("Only PNG, JPG, GIF, or WebP images.");
        continue;
      }
      if (f.size > MAX_BYTES) {
        setError("Each image must be 5 MB or smaller.");
        continue;
      }
      next.push(f);
    }
    setItems((prev) => {
      const room = Math.max(0, MAX_FILES - prev.length);
      if (next.length > room) setError(`You can attach at most ${MAX_FILES} images.`);
      const added = next.slice(0, room).map((file) => ({ file, url: window.URL.createObjectURL(file) }));
      return [...prev, ...added];
    });
  }, []);

  const removeFile = (i: number) =>
    setItems((prev) => {
      const target = prev[i];
      if (target) window.URL.revokeObjectURL(target.url);
      return prev.filter((_, idx) => idx !== i);
    });

  // Active dashboard screen for context; nav is NavState { screen, param }.
  const screen = app.nav.screen;

  const submit = async () => {
    if (!description.trim() || !email.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.set("description", description);
      fd.set("email", email);
      fd.set("screen", screen);
      for (const it of items) fd.append("screenshots", it.file, it.file.name);
      // No explicit Content-Type: the browser sets the multipart boundary. The
      // browser also sends Origin on same-origin POST, satisfying requireSameOrigin.
      const res = await fetch("/dashboard/api/bug-report", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? "Could not send the report.");
      }
      app.toast("Thanks — your bug report was sent.", "check");
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the report.");
    } finally {
      setSending(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="cd-bug-launcher" onClick={() => setOpen(true)} aria-label="Report a bug">
        <CDIcon name="warn" size={16} strokeWidth={1.9} />
        <span>Report a bug</span>
      </button>
    );
  }

  return (
    <div className="cd-bug-overlay" role="dialog" aria-label="Report a bug" aria-modal="true">
      <div className="cd-bug-modal">
        <div className="cd-chat-head">
          <div className="cd-chat-head-title">
            <div className="cd-h3">Report a bug</div>
          </div>
          <button
            type="button"
            className="cd-chat-close"
            aria-label="Close"
            onClick={() => !sending && setOpen(false)}
          >
            <CDIcon name="x" size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="cd-bug-body">
          <label className="cd-field">
            <span>What went wrong?</span>
            <textarea
              className="cd-input"
              rows={4}
              maxLength={5000}
              placeholder="Tell us what happened and what you expected."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="cd-field">
            <span>Your email (so we can follow up)</span>
            <input
              className="cd-input"
              type="email"
              placeholder="you@store.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <div className="cd-field">
            <span>Screenshots (optional)</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                if (fileInput.current) fileInput.current.value = "";
              }}
            />
            <div>
              <Btn small onClick={() => fileInput.current?.click()}>
                Add images
              </Btn>
            </div>
            {items.length > 0 && (
              <div className="cd-bug-thumbs">
                {items.map((it, i) => (
                  <div key={it.url} className="cd-bug-thumb">
                    <img src={it.url} alt={it.file.name} />
                    <button type="button" aria-label={`Remove ${it.file.name}`} onClick={() => removeFile(i)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <div className="cd-chat-error">{error}</div>}
        </div>
        <div className="cd-bug-foot">
          <Btn onClick={() => !sending && setOpen(false)}>Cancel</Btn>
          <Btn kind="primary" disabled={!description.trim() || !email.trim() || sending} onClick={submit}>
            {sending ? "Sending…" : "Send report"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
