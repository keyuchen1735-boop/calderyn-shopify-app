import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import { CDIcon } from "./icons";
import { Btn } from "./ui";
import { reduced } from "./hero/hero-motion";
import { MAX_MESSAGE_CHARS } from "~/lib/contact/validate";
import { throwIfVersionSkew } from "~/lib/dashboard/version-skew";
import type { DashboardCtx } from "./context";

export default function ContactButton({ app }: { app: DashboardCtx }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  // One-time entrance: the pill settles in after the dashboard paints, so it
  // reads as furniture rather than a popup.
  useGSAP(
    () => {
      if (reduced()) return;
      gsap.from(".cd-contact-fab", {
        autoAlpha: 0,
        y: 12,
        duration: 0.45,
        delay: 0.5,
        ease: "power3.out",
        clearProps: "all",
      });
    },
    { scope: rootRef },
  );

  // The panel mounts on open, so a mount tween IS the open animation: it grows
  // from the pill's corner (bottom-right origin) with a short rise.
  useGSAP(
    () => {
      if (!open || reduced()) return;
      const panel = panelRef.current;
      if (!panel) return;
      gsap.fromTo(
        panel,
        { autoAlpha: 0, y: 10, scale: 0.96, transformOrigin: "bottom right" },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "power3.out" },
      );
    },
    { scope: rootRef, dependencies: [open] },
  );

  const close = useCallback(() => {
    if (sending || closingRef.current) return;
    const panel = panelRef.current;
    if (!panel || reduced()) {
      setOpen(false);
      return;
    }
    closingRef.current = true;
    gsap.to(panel, {
      autoAlpha: 0,
      y: 8,
      scale: 0.96,
      transformOrigin: "bottom right",
      duration: 0.2,
      ease: "power2.in",
      onComplete: () => {
        closingRef.current = false;
        setOpen(false);
      },
    });
  }, [sending]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const submit = async () => {
    // closingRef: ignore a Send click landed during the close tween — the panel
    // would unmount mid-flight and a failure could never be shown.
    if (!message.trim() || !email.trim() || sending || closingRef.current) return;
    setSending(true);
    setError(null);
    try {
      // The browser sends Origin on same-origin POST, satisfying requireSameOrigin.
      const res = await fetch("/dashboard/api/contact", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, email, screen: app.nav.screen }),
      });
      throwIfVersionSkew(res);
      if (!res.ok) {
        // Only surface server messages written for humans; machine codes
        // (bad_origin, unauthorized, ...) fall through to the generic line.
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? "Could not send your message. Please try again.");
      }
      app.toast("Thanks, we got your message and will reply by email.", "check");
      setMessage("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send your message.");
    } finally {
      setSending(false);
    }
  };

  // The store builder parks its own controls in the bottom-right corner
  // (.cd-sections) — hide the launcher there rather than covering them.
  if (app.nav.screen === "storefront") return null;

  return (
    <div ref={rootRef}>
      {open && (
        <div ref={panelRef} className="cd-contact-panel" role="dialog" aria-label="Contact us">
          <div className="cd-chat-head">
            <div className="cd-chat-head-title">
              <div className="cd-h3">Contact us</div>
            </div>
            <button type="button" className="cd-chat-close" aria-label="Close" onClick={close}>
              <CDIcon name="x" size={16} strokeWidth={2} />
            </button>
          </div>
          <div className="cd-contact-body">
            <label className="cd-field">
              <span>Your message</span>
              <textarea
                className="cd-input"
                rows={4}
                maxLength={MAX_MESSAGE_CHARS}
                placeholder="Questions, feedback, anything. We read every message."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <label className="cd-field">
              <span>Your email (we reply here)</span>
              <input
                className="cd-input"
                type="email"
                placeholder="you@store.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {error && <div className="cd-chat-error">{error}</div>}
          </div>
          <div className="cd-contact-foot">
            <Btn
              kind="primary"
              disabled={!message.trim() || !email.trim() || sending}
              onClick={submit}
            >
              {sending ? "Sending…" : "Send message"}
            </Btn>
          </div>
        </div>
      )}
      <button
        type="button"
        className="cd-contact-fab"
        aria-expanded={open}
        aria-label={open ? "Close contact form" : "Contact us"}
        onClick={() => {
          if (open) {
            close();
          } else {
            setError(null);
            setOpen(true);
          }
        }}
      >
        <CDIcon name={open ? "x" : "comment"} size={15} strokeWidth={1.8} />
        <span>Contact us</span>
      </button>
    </div>
  );
}
