// The designer's floating command dock: a bottom-centered composer over the
// preview with a status row ("Working…" while a turn runs, "Worked for 2m 14s"
// after) that expands upward into the full conversation. Purely a renderer —
// Store.tsx owns the message list, the composer text, and send/attach, exactly
// like ChatRail (which the classic builder keeps).
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import gsap from "gsap";
import { CDIcon } from "../icons";
import { canSendComposer } from "../screens/store-logic";
import type { ChatMsg } from "./chat-types";
import type { StudioDesignModel } from "~/lib/storebuilder/studio-types";

function formatDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Isolated 1s ticker so the elapsed label re-renders without touching the
 *  rest of the dock tree. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Date.now() - since)}</>;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Bubble({ msg }: { msg: ChatMsg }) {
  if (msg.kind === "user-text") {
    return <div className="cd-bub cd-bub-user">{msg.text}</div>;
  }
  if (msg.kind === "user-image") {
    return (
      <div className="cd-bub cd-bub-user">
        <img className="cd-bub-img" src={msg.imageUrl} alt={msg.caption} />
        <span style={{ display: "block", marginTop: 7, fontSize: 11.5, opacity: 0.85 }}>{msg.caption}</span>
      </div>
    );
  }
  if (msg.kind === "ai-thinking") {
    return (
      <div className="cd-bub cd-bub-ai">
        <div className="cd-think">
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  }
  if (msg.kind === "ai-working") {
    // The designer streams its own page events as plain replies; the classic
    // build-steps card never appears on this surface, but render its text
    // fallback defensively rather than dropping a message.
    return <div className="cd-bub cd-bub-ai">Working on it…</div>;
  }
  return (
    <div className="cd-bub cd-bub-ai">
      {msg.text}
      {msg.actions && msg.actions.length > 0 && (
        <div className="cd-bub-btns">
          {msg.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={a.kind === "primary" ? "cd-btn cd-btn-primary cd-btn-sm" : "cd-chip"}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DesignerDock({
  messages,
  prompt,
  onPromptChange,
  onSend,
  onStop,
  busy,
  stoppable,
  attaching,
  onAttachFiles,
  model,
  onModelChange,
  placeholder,
  composerExtra,
  busySince,
}: {
  messages: ChatMsg[];
  prompt: string;
  onPromptChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  stoppable: boolean;
  attaching: boolean;
  onAttachFiles: (files: File[]) => void;
  model: StudioDesignModel;
  onModelChange: (m: StudioDesignModel) => void;
  placeholder?: string;
  composerExtra?: ReactNode;
  /** Wall-clock start of the running turn (survives screen switches). */
  busySince?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const startedAtRef = useRef<number | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);

  // Turn timing lives entirely on the busy transitions: true starts the
  // clock, false stamps "Worked for …" and briefly lights the row up.
  useEffect(() => {
    if (busy) {
      startedAtRef.current = busySince ?? Date.now();
      setTurnStartedAt(startedAtRef.current);
      return;
    }
    if (startedAtRef.current != null) {
      setLastTurnMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
      setTurnStartedAt(null);
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 1400);
      return () => clearTimeout(timer);
    }
    // busySince is stable for the life of a turn; busy drives the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // Entrance: the dock rises in once when the designer mounts.
  useEffect(() => {
    const el = dockRef.current;
    if (!el || reducedMotion()) return;
    gsap.fromTo(el, { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.45, ease: "expo.out", clearProps: "all" });
  }, []);

  // Drop-up: height 0 ↔ auto, content settles with a slight rise. State
  // transition animation — the row is the handle, the panel is the payload.
  const firstPanelRun = useRef(true);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (firstPanelRun.current) {
      firstPanelRun.current = false;
      gsap.set(el, { height: open ? "auto" : 0, autoAlpha: open ? 1 : 0, overflow: "hidden" });
      return;
    }
    gsap.killTweensOf(el);
    if (reducedMotion()) {
      gsap.set(el, { height: open ? "auto" : 0, autoAlpha: open ? 1 : 0 });
      return;
    }
    if (open) {
      // One frame so React paints any message pushed in the same tick; GSAP
      // resolves height:"auto" at tween start, and measuring a not-yet-
      // rendered thread would freeze the panel at a clipped height. On
      // complete the panel returns to auto so later messages grow it.
      const frame = requestAnimationFrame(() => {
        gsap.fromTo(
          el,
          { height: 0, autoAlpha: 0.35 },
          {
            height: "auto",
            autoAlpha: 1,
            duration: 0.44,
            ease: "expo.out",
            onComplete: () => gsap.set(el, { height: "auto" }),
          },
        );
        const thread = threadRef.current;
        if (thread) {
          gsap.fromTo(thread, { y: 12 }, { y: 0, duration: 0.44, ease: "expo.out", clearProps: "transform" });
          thread.scrollTop = thread.scrollHeight;
        }
      });
      return () => cancelAnimationFrame(frame);
    }
    gsap.to(el, { height: 0, autoAlpha: 0, duration: 0.3, ease: "power2.inOut" });
  }, [open]);

  // New messages: keep the feed pinned to the latest, ease the newcomer in.
  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTop = thread.scrollHeight;
    if (reducedMotion() || !open) return;
    const last = thread.querySelector<HTMLElement>(".cd-dock-msg:last-child");
    if (last) {
      gsap.fromTo(last, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.28, ease: "expo.out", clearProps: "all" });
    }
  }, [messages.length, open]);

  const canSend = canSendComposer({ prompt, busy: busy || attaching });
  const send = () => {
    if (!canSend) return;
    setOpen(true);
    onSend();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = "";
    if (files.length > 0) onAttachFiles(files);
  };

  // The latest assistant line doubles as the working row's activity snippet,
  // so "what is it doing" is visible without expanding.
  const lastAiText = [...messages].reverse().find((m): m is Extract<ChatMsg, { kind: "ai-text" }> => m.kind === "ai-text");
  const hasHistory = messages.length > 0;
  const showStatusRow = busy || lastTurnMs != null || hasHistory;

  const statusLabel = busy
    ? "Working"
    : lastTurnMs != null
      ? `Worked for ${formatDuration(lastTurnMs)}`
      : "Chat history";
  const activity = busy && lastAiText ? lastAiText.text : null;

  return (
    <div className="cd-dock" ref={dockRef}>
      <div className="cd-dock-panel" ref={panelRef} aria-hidden={!open}>
        <div className="cd-dock-thread" ref={threadRef}>
          {messages.map((m) => (
            <div key={m.id} className="cd-dock-msg" data-side={m.kind.startsWith("user") ? "user" : "ai"}>
              <Bubble msg={m} />
            </div>
          ))}
        </div>
      </div>

      {showStatusRow && (
        <button
          type="button"
          className="cd-dock-status"
          data-busy={busy ? "1" : "0"}
          data-flash={flash ? "1" : "0"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="cd-dock-status-main">
            {busy && <span className="cd-dock-pulse" aria-hidden="true" />}
            <span className="cd-dock-status-label">
              {statusLabel}
              {busy && turnStartedAt != null && (
                <span className="cd-dock-elapsed">
                  {" · "}
                  <Elapsed since={turnStartedAt} />
                </span>
              )}
            </span>
            {activity && <span className="cd-dock-activity">{activity}</span>}
          </span>
          <span className="cd-dock-chevron" data-open={open ? "1" : "0"} aria-hidden="true">
            <CDIcon name="chevronDown" size={14} strokeWidth={2} />
          </span>
        </button>
      )}

      <div className="cd-dock-composer">
        {composerExtra}
        <div className="cd-dock-input-row">
          <button
            type="button"
            className="cd-composer-tool"
            title="Add a product from a photo"
            aria-label="Add a product from a photo"
            disabled={attaching}
            onClick={() => fileInputRef.current?.click()}
          >
            <CDIcon name="paperclip" size={15} strokeWidth={1.9} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={onFileChange}
          />
          <textarea
            className="cd-dock-in"
            rows={1}
            placeholder={placeholder ?? "Tell Calderyn what to change…"}
            aria-label={placeholder ?? "Tell Calderyn what to change"}
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <select
            className="cd-composer-model"
            aria-label="Design model"
            title="Design model"
            value={model}
            onChange={(e) => onModelChange(e.target.value as StudioDesignModel)}
          >
            <option value="sonnet">Sonnet 5</option>
            <option value="opus">Opus 4.8</option>
          </select>
          {stoppable ? (
            <button
              type="button"
              className="cd-composer-send cd-composer-stop"
              aria-label="Stop generation"
              title="Stop generation"
              onClick={onStop}
            >
              <span aria-hidden="true" className="cd-stop-glyph" />
            </button>
          ) : (
            <button type="button" className="cd-composer-send" aria-label="Send" disabled={!canSend} onClick={send}>
              <CDIcon name="arrowUp" size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
