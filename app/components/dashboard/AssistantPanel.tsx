import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

import * as client from "~/lib/dashboard/client";
import { AssistantSendError } from "~/lib/dashboard/client";
import type { ChatMessage, DraftedAction } from "~/lib/assistant/types";
import type { ActionReceipt, PendingActionCard } from "~/lib/assistant/actions/registry-types";
import { SUGGESTED_PROMPTS } from "~/lib/assistant/suggested-prompts";
import { useThinkingPhrase } from "~/lib/assistant/thinking";
import { DASH_INLINE_ACTIONS, dashReviewScreen } from "~/lib/labels";
import { Markdown } from "~/components/Markdown";

import { CDIcon } from "./icons";
import { money } from "./format";
import { Btn } from "./ui";
import type { ActionKind as DashActionKind, DashboardCtx } from "./context";
import type { AlertVM } from "./view-models";
import { reduced } from "./hero/hero-motion";

gsap.registerPlugin(useGSAP);

// Kinds the dashboard can truly execute inline come from DASH_INLINE_ACTIONS
// (executeAction has a live endpoint for them). Everything else — exclude_geo,
// create_po_draft, reallocate_budget — deep-links to its review surface instead
// of faking a run.
let localSeq = 0;
const nextLocalId = () => `chat-local-${++localSeq}`;

/** closed: unmounted. open: full interactive panel. docked: minimized to a
 *  pill on the right edge (after navigating away with the panel open). peek:
 *  a non-interactive hover preview of the docked panel, click-to-open. */
type PanelState = "closed" | "open" | "docked" | "peek";

/** Below this width the chat panel is already effectively full-screen (see
 *  the `.cd-chat-panel` max-width rule in dashboard.css), so there's no edge
 *  to dock into — navigating away just leaves it open, matching pre-dock
 *  behavior, per the phone-mode carve-out in the design brief. */
const DOCK_MIN_WIDTH_QUERY = "(max-width: 767px)";

/** The panel's GSAP-owned end-state per non-closed PanelState. One table
 *  driving one tween executor (below) instead of a hand-written function per
 *  transition, so docked/peek/open can't drift out of sync with each other. */
const PANEL_TARGET: Record<
  "open" | "docked" | "peek",
  { xPercent: number; scale: number; opacity: number; pointerEvents: "auto" | "none"; duration: number; ease: string }
> = {
  open: { xPercent: 0, scale: 1, opacity: 1, pointerEvents: "auto", duration: 0.4, ease: "power3.out" },
  docked: { xPercent: 100, scale: 0.9, opacity: 0, pointerEvents: "none", duration: 0.38, ease: "power2.inOut" },
  peek: { xPercent: 50, scale: 1, opacity: 1, pointerEvents: "none", duration: 0.35, ease: "power3.out" },
};

/** The dock pill's resting look per state it's visible in ("open" has no
 *  pill — it's unmounted). */
const PILL_TARGET: Record<"docked" | "peek", { opacity: number; scale: number }> = {
  docked: { opacity: 1, scale: 1 },
  peek: { opacity: 0, scale: 1 },
};

function DraftActionCard({
  action,
  app,
  onClose,
}: {
  action: DraftedAction;
  app: DashboardCtx;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const executable = DASH_INLINE_ACTIONS.has(action.actionKind);

  const review = () => {
    // Route to the surface that can actually host this action so the deep-link
    // isn't a dead end: reallocate_budget's budget edits live on the Campaigns
    // screen; everything else reviews on the Alerts detail (evidence/confirm or
    // the PO draft dialog).
    const screen = dashReviewScreen(action.actionKind);
    app.navigate(screen, screen === "alerts" ? action.alertId : null);
    onClose();
  };

  const run = async () => {
    setRunning(true);
    setErrorText(null);
    try {
      const alert: AlertVM =
        app.alerts.find((a) => a.id === action.alertId) ??
        (await client.fetchAlert(action.alertId, app.campaigns));
      // executeAction surfaces its own success/failure toasts.
      await app.executeAction(alert, action.actionKind as DashActionKind);
      setDone(true);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setRunning(false);
      setConfirming(false);
    }
  };

  return (
    <div className="cd-chat-action">
      <div className="cd-chat-action-head">
        <span className="cd-chat-action-label">
          Proposed: {action.label} · {money(action.dollarImpact)}/30d
        </span>
        {done && (
          <span className="cd-chat-action-done">
            <CDIcon name="check" size={13} strokeWidth={2.2} /> Done
          </span>
        )}
      </div>
      {!done && !confirming && (
        <div className="cd-chat-action-btns">
          {executable ? (
            <>
              <Btn kind="primary" small onClick={() => setConfirming(true)}>
                Run now
              </Btn>
              <Btn small onClick={review}>
                Review
              </Btn>
            </>
          ) : (
            <Btn kind="primary" small onClick={review}>
              Review &amp; confirm
            </Btn>
          )}
        </div>
      )}
      {!done && confirming && (
        <>
          <div className="cd-caption">
            Run &ldquo;{action.label}&rdquo; now? This executes immediately and is logged to your
            action history.
          </div>
          <div className="cd-chat-action-btns">
            <Btn kind="primary" small disabled={running} onClick={run}>
              {running ? "Running…" : "Confirm"}
            </Btn>
            <Btn small disabled={running} onClick={() => setConfirming(false)}>
              Cancel
            </Btn>
          </div>
        </>
      )}
      {errorText && <div className="cd-chat-error">{errorText}</div>}
    </div>
  );
}

/** A completed (Tier-1 or confirmed Tier-2) action under an assistant bubble.
 *  Undo is only offered when the executor marked it undoable AND wrote an
 *  audit row — some actions (e.g. a dismiss) have neither. */
function ReceiptChip({ receipt }: { receipt: ActionReceipt }) {
  const [state, setState] = useState<"idle" | "undoing" | "undone">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const canUndo = receipt.undoable && Boolean(receipt.auditId);

  const undo = async () => {
    if (!receipt.auditId) return;
    setState("undoing");
    setErrorText(null);
    try {
      await client.undoAudit(receipt.auditId);
      setState("undone");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Undo failed.");
      setState("idle");
    }
  };

  return (
    <div className="cd-chat-action">
      <div className="cd-chat-action-head">
        <span className="cd-chat-action-done">
          <CDIcon name="check" size={13} strokeWidth={2.2} /> {receipt.summary}
        </span>
      </div>
      {(receipt.link || canUndo) && (
        <div className="cd-chat-action-btns">
          {receipt.link && (
            <a
              href={receipt.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="cd-btn cd-btn-secondary cd-btn-sm"
            >
              <CDIcon name="download" size={14} strokeWidth={1.9} />
              {receipt.link.label}
            </a>
          )}
          {canUndo &&
            (state === "undone" ? (
              <span className="cd-chat-action-done">
                <CDIcon name="check" size={13} strokeWidth={2.2} /> Undone
              </span>
            ) : (
              <Btn small disabled={state === "undoing"} onClick={undo}>
                {state === "undoing" ? "Undoing…" : "Undo"}
              </Btn>
            ))}
        </div>
      )}
      {errorText && <div className="cd-chat-error">{errorText}</div>}
    </div>
  );
}

/** A Tier-2 (confirm-gated) action awaiting a merchant decision. Renders from
 *  persisted history as much as from a live turn, so a stale card (already
 *  confirmed/dismissed elsewhere, or past its TTL) must fail gracefully — the
 *  server's 409 "pending_unavailable" surfaces as plain copy, not a crash. */
function PendingConfirmCard({
  pending,
  onConfirmed,
}: {
  pending: PendingActionCard;
  /** Fired once, after a successful confirm, with the receipt the action
   *  itself always returns plus the persisted follow-up turn the server
   *  appended (message is null only when that best-effort bookkeeping step
   *  failed — the action still ran, so the caller must fall back to the
   *  receipt rather than showing nothing). */
  onConfirmed: (receipt: ActionReceipt, message: ChatMessage | null) => void;
}) {
  const [phase, setPhase] = useState<
    "active" | "confirming" | "dismissing" | "confirmed" | "dismissed" | "stale"
  >("active");
  const [errorText, setErrorText] = useState<string | null>(null);
  const busy = phase === "confirming" || phase === "dismissing";
  const resolved = phase === "confirmed" || phase === "dismissed" || phase === "stale";

  const confirm = async () => {
    setPhase("confirming");
    setErrorText(null);
    try {
      const { receipt, message } = await client.confirmAssistantAction(pending.id);
      setPhase("confirmed");
      onConfirmed(receipt, message);
    } catch (err) {
      // Covers the 409 pending_unavailable path too: a card rendered from
      // reloaded history may already be expired or resolved elsewhere, and
      // this is where that surfaces — as plain copy, buttons re-enabled so a
      // fresh ask isn't blocked on a stuck spinner.
      setErrorText(err instanceof Error ? err.message : "Could not confirm this action.");
      setPhase("active");
    }
  };

  const dismiss = async () => {
    setPhase("dismissing");
    setErrorText(null);
    try {
      const dismissed = await client.dismissAssistantAction(pending.id);
      // dismissed === false means the pending row was NOT actually pending
      // (already executed, already dismissed, or expired) — e.g. a stale card
      // reopened after the action already ran. Reporting that as "Not now —
      // no changes made" would misstate whether the action (e.g. a refund)
      // already happened, so it gets its own honest, non-confirmatory state.
      setPhase(dismissed ? "dismissed" : "stale");
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Could not dismiss this action.");
      setPhase("active");
    }
  };

  return (
    <div className="cd-chat-action">
      <div className="cd-chat-action-head">
        <span className="cd-chat-action-label">{pending.summary}</span>
        {phase === "confirmed" && (
          <span className="cd-chat-action-done">
            <CDIcon name="check" size={13} strokeWidth={2.2} /> Confirmed
          </span>
        )}
      </div>
      {phase === "dismissed" && <div className="cd-caption">Not now — no changes made.</div>}
      {phase === "stale" && (
        <div className="cd-chat-error">This action was already resolved elsewhere.</div>
      )}
      {!resolved && (
        <div className="cd-chat-action-btns">
          <Btn kind="primary" small disabled={busy} onClick={confirm}>
            {phase === "confirming" ? "Confirming…" : "Confirm"}
          </Btn>
          <Btn small disabled={busy} onClick={dismiss}>
            {phase === "dismissing" ? "Dismissing…" : "Not now"}
          </Btn>
        </div>
      )}
      {errorText && <div className="cd-chat-error">{errorText}</div>}
    </div>
  );
}

export default function AssistantPanel({
  app,
  openSignal,
  prompt,
  tourDemo,
}: {
  app: DashboardCtx;
  openSignal?: number;
  /** A hand-off from Home's prompt bar: open the panel and send this text as
   *  the next user turn. `n` makes re-sends of the same text distinct. */
  prompt?: { n: number; text: string } | null;
  /** Opens the real assistant panel with a read-only, local example. No API
   *  request or conversation history is touched during the product tour. */
  tourDemo?: { n: number } | null;
}) {
  const [state, setState] = useState<PanelState>("closed");
  const tourDemoActive = tourDemo != null;
  const [tourDemoInput, setTourDemoInput] = useState("");
  const [tourDemoStage, setTourDemoStage] = useState<0 | 1 | 2>(0);
  const tourDemoWasActiveRef = useRef(false);

  // The sidebar "Ask Calderyn" button and the mobile "More" sheet open the
  // panel by bumping openSignal. Each increment re-opens it fully, whatever
  // the current state (closed/docked/peek) — a deliberate reopen always wins.
  useEffect(() => {
    if (openSignal) setState("open");
  }, [openSignal]);

  useEffect(() => {
    if (!tourDemo) {
      if (tourDemoWasActiveRef.current) setState("closed");
      tourDemoWasActiveRef.current = false;
      setTourDemoInput("");
      setTourDemoStage(0);
      return;
    }

    tourDemoWasActiveRef.current = true;
    setState("open");
    setTourDemoInput("");
    setTourDemoStage(0);
    const example = "What should I reorder this week?";
    if (reduced()) {
      setTourDemoStage(2);
      return;
    }

    let index = 0;
    let userTimer: number | undefined;
    let answerTimer: number | undefined;
    const typingTimer = window.setInterval(() => {
      index += 2;
      setTourDemoInput(example.slice(0, index));
      if (index < example.length) return;
      window.clearInterval(typingTimer);
      userTimer = window.setTimeout(() => {
        setTourDemoInput("");
        setTourDemoStage(1);
        answerTimer = window.setTimeout(() => setTourDemoStage(2), 450);
      }, 220);
    }, 24);

    return () => {
      window.clearInterval(typingTimer);
      if (userTimer !== undefined) window.clearTimeout(userTimer);
      if (answerTimer !== undefined) window.clearTimeout(answerTimer);
    };
  }, [tourDemo]);

  // Navigating away while the panel is open docks it to a pill instead of
  // leaving it floating over the new screen. Navigating while docked/peek/
  // closed does nothing — only a genuinely open panel needs to get out of
  // the way. Skipped on the phone breakpoint (no edge to dock into there).
  const prevScreenRef = useRef(app.nav.screen);
  useEffect(() => {
    const screenChanged = prevScreenRef.current !== app.nav.screen;
    prevScreenRef.current = app.nav.screen;
    if (!screenChanged) return;
    if (typeof window !== "undefined" && window.matchMedia(DOCK_MIN_WIDTH_QUERY).matches) return;
    setState((cur) => (cur === "open" ? "docked" : cur));
  }, [app.nav.screen]);

  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const thinking = useThinkingPhrase(sending);
  const [errorText, setErrorText] = useState<string | null>(null);

  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load history once, the first time the panel becomes visible. Gated on a
  // ref (not just `!historyLoaded`) so a merchant who docks/peeks/re-opens
  // before the fetch resolves can't retrigger it — `state` now has 4 values
  // instead of a single open/closed bool, and every one of docked/peek/open
  // re-runs this effect while the fetch is still in flight.
  const historyFetchStartedRef = useRef(false);
  useEffect(() => {
    if (state === "closed" || tourDemoActive || historyFetchStartedRef.current) return;
    historyFetchStartedRef.current = true;
    let alive = true;
    client
      .fetchAssistantHistory()
      .then((h) => {
        if (!alive) return;
        setMessages(h.messages);
        setConversationId(h.conversationId);
        setHistoryLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        // Non-fatal: start an empty thread; sends still work.
        setHistoryLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [state, tourDemoActive]);

  // Only a genuinely open (or opening-toward) panel needs its scroll position
  // kept pinned to the latest message — skip the extra reflow on every
  // docked<->peek hover toggle, when the thread isn't meaningfully visible.
  useEffect(() => {
    if (state === "closed" || state === "docked") return;
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [messages, sending, state]);

  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || sending) return;
      const localId = nextLocalId();
      setMessages((prev) => [
        ...prev,
        {
          id: localId,
          role: "user",
          content: text,
          draftedAction: null,
          receipts: [],
          pendingAction: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      // Clear the composer only when it's what was sent — a queued Home-bar
      // prompt must not wipe a draft sitting in the textarea.
      setInput((cur) => (cur === raw ? "" : cur));
      setSending(true);
      setErrorText(null);
      try {
        const res = await client.sendAssistantMessage(text, conversationId);
        setConversationId(res.conversationId);
        setMessages((prev) => [...prev, res.message]);
      } catch (err) {
        // Roll back the optimistic turn and restore the composer for a retry.
        setMessages((prev) => prev.filter((m) => m.id !== localId));
        setInput((cur) => cur || text);
        if (err instanceof AssistantSendError) {
          setErrorText(err.message);
          if (err.conversationId) setConversationId(err.conversationId);
        } else {
          setErrorText("Could not reach Calderyn. Try again.");
        }
      } finally {
        setSending(false);
      }
    },
    [conversationId, sending],
  );

  const newChat = () => {
    setMessages([]);
    setConversationId(null);
    setErrorText(null);
    inputRef.current?.focus();
  };

  // Prompts handed off from Home open the panel and join a queue; the queue
  // drains one at a time, only while the panel is OPEN (closing the panel
  // cancels whatever hasn't sent — nothing may post invisibly later), only
  // once history has loaded (sending sooner would race the history fetch,
  // whose setMessages(h.messages) replaces the thread and would wipe the
  // optimistic user bubble), and never mid-send. A queue — not a single slot —
  // so rapid submissions from the bar all arrive instead of overwriting.
  const [queuedPrompts, setQueuedPrompts] = useState<{ n: number; text: string }[]>([]);
  useEffect(() => {
    if (!prompt?.text) return;
    // The merchant explicitly sent a prompt, so it always reopens the panel
    // fully — even if it was docked or peeking at the time.
    setState("open");
    // Keyed on n so a re-run with the same hand-off (StrictMode) can't
    // enqueue it twice.
    setQueuedPrompts((q) => (q.some((p) => p.n === prompt.n) ? q : [...q, prompt]));
  }, [prompt]);
  useEffect(() => {
    if (state !== "open" || queuedPrompts.length === 0 || !historyLoaded || sending) return;
    const [next, ...rest] = queuedPrompts;
    setQueuedPrompts(rest);
    void sendText(next.text);
  }, [state, queuedPrompts, historyLoaded, sending, sendText]);
  useEffect(() => {
    if (state === "closed") setQueuedPrompts([]);
  }, [state]);

  // Opening the panel is a context switch — put the caret in the composer so
  // the next keystrokes land in the conversation, not behind the dialog.
  // Only fires for a genuinely open panel, not a dock/peek transition.
  useEffect(() => {
    if (state === "open") inputRef.current?.focus();
  }, [state]);

  // ---- dock / peek / open GSAP choreography ----
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  // The peek click-catcher shares the panel's exact base box (see
  // .cd-chat-peek-catch) and is driven by the same transition executor below,
  // so its hit area always coincides with whatever the panel visually shows —
  // including in peek, where the panel is slid mostly off-screen and only a
  // sliver remains visible.
  const peekCatchRef = useRef<HTMLButtonElement>(null);
  const prevPanelStateRef = useRef<PanelState>("closed");

  const { contextSafe } = useGSAP({ scope: containerRef });

  // One contextSafe-wrapped executor, built once (lazy ref-init, not on every
  // render — contextSafe(fn) allocates a fresh wrapper on every call, and this
  // component re-renders on every keystroke in the composer) instead of a
  // hand-written function per transition. Driven by the PANEL_TARGET/
  // PILL_TARGET tables above, so docked/peek/open can't drift out of sync
  // with each other the way five independent functions could.
  // Mount slide-in (closed -> open), contextSafe like every other tween so it
  // reverts on unmount. See the [state] effect for why this is GSAP, not CSS.
  const runMountOpenRef = useRef<(() => void) | null>(null);
  if (runMountOpenRef.current === null) {
    runMountOpenRef.current = contextSafe(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // x:0 explicitly clears any pixel offset GSAP may have parsed from a
      // stale computed transform; xPercent drives the slide.
      if (reduced()) {
        gsap.set(panel, { x: 0, xPercent: 0, scale: 1, opacity: 1, pointerEvents: "auto" });
      } else {
        gsap.fromTo(
          panel,
          { x: 0, xPercent: 110, scale: 1, opacity: 1 },
          { xPercent: 0, pointerEvents: "auto", duration: 0.42, ease: "power3.out", overwrite: "auto" },
        );
      }
      if (peekCatchRef.current) {
        gsap.set(peekCatchRef.current, { x: 0, xPercent: 0, scale: 1, pointerEvents: "none" });
      }
    });
  }

  const runTransitionRef = useRef<
    ((target: "open" | "docked" | "peek", opts?: { pulse?: boolean }) => void) | null
  >(null);
  if (runTransitionRef.current === null) {
    runTransitionRef.current = contextSafe((target: "open" | "docked" | "peek", opts?: { pulse?: boolean }) => {
      const panel = panelRef.current;
      if (!panel) return;
      const pill = pillRef.current;
      const catchEl = peekCatchRef.current;
      const p = PANEL_TARGET[target];
      // The catcher only ever needs to intercept clicks in peek — in every
      // other state the real panel (open) or nothing at all (docked) should
      // handle them, so pointer-events is derived from `target` directly
      // rather than reused from PANEL_TARGET (whose own peek entry is "none",
      // since the *panel* mustn't catch clicks while it's non-interactive).
      const catchPointerEvents: "auto" | "none" = target === "peek" ? "auto" : "none";
      if (reduced()) {
        gsap.set(panel, {
          xPercent: p.xPercent,
          scale: p.scale,
          opacity: p.opacity,
          pointerEvents: p.pointerEvents,
        });
        if (catchEl) {
          gsap.set(catchEl, { xPercent: p.xPercent, scale: p.scale, pointerEvents: catchPointerEvents });
        }
        if (pill && target !== "open") gsap.set(pill, PILL_TARGET[target]);
        return;
      }
      gsap.to(panel, {
        xPercent: p.xPercent,
        scale: p.scale,
        opacity: p.opacity,
        pointerEvents: p.pointerEvents,
        duration: p.duration,
        ease: p.ease,
        overwrite: "auto",
      });
      if (catchEl) {
        // Same xPercent/scale/duration/ease as the panel above — tracking it
        // exactly, frame for frame, is what keeps the hit box glued to the
        // visible sliver instead of a static box that drifts out of register.
        gsap.to(catchEl, {
          xPercent: p.xPercent,
          scale: p.scale,
          pointerEvents: catchPointerEvents,
          duration: p.duration,
          ease: p.ease,
          overwrite: "auto",
        });
      }
      if (pill && target !== "open") {
        if (opts?.pulse) {
          // One subtle attention pulse announcing the dock — not a loop.
          // killTweensOf first so a rapid re-dock (open->dock->open->dock)
          // can't stack a second pulse on top of one still settling.
          gsap.killTweensOf(pill);
          gsap
            .timeline({ delay: 0.12 })
            .fromTo(pill, { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1.08, duration: 0.3, ease: "power3.out" })
            .to(pill, { scale: 1, duration: 0.18, ease: "power2.out" });
        } else {
          gsap.to(pill, { ...PILL_TARGET[target], duration: 0.3, ease: "power2.out", overwrite: "auto" });
        }
      }
    });
  }

  useEffect(() => {
    const prev = prevPanelStateRef.current;
    prevPanelStateRef.current = state;
    if (prev === state) return;
    if (prev === "open" && state === "docked") {
      // Docking pulls the panel out of the pointer/tab interaction surface —
      // release focus explicitly rather than relying on the inert toggle
      // below to land in the same commit, so a merchant who kept typing
      // after navigating away isn't silently typing into a hidden composer.
      const active = document.activeElement;
      if (active instanceof HTMLElement && panelRef.current?.contains(active)) {
        active.blur();
      }
    }
    const run = runTransitionRef.current;
    if (!run) return;
    if (state === "open") {
      if (prev === "closed") {
        // First open (mount from closed): GSAP plays the drawer slide-in
        // itself. This MUST NOT be a CSS keyframe — GSAP reading the
        // computed transform mid-keyframe caches the keyframe's pixel
        // offset (436px) and persists it inline, parking the panel
        // permanently off-screen. One transform owner: GSAP.
        runMountOpenRef.current?.();
      } else {
        run("open");
      }
    } else if (state === "docked") {
      run("docked", { pulse: prev === "open" });
    } else if (state === "peek") {
      run("peek");
    }
    // state === "closed": nothing to animate, the panel unmounts below.
  }, [state]);

  // `inert` — not just aria-hidden — must cover the panel whenever it isn't
  // fully open. Docked/peek only *look* hidden (opacity/pointer-events), so
  // without `inert` every control inside stays tab-reachable and
  // Enter-activatable: a merchant tabbing through the page could land on a
  // PendingConfirmCard's "Confirm" button they can't see and fire a real
  // action (e.g. a refund). `inert` also strips the subtree from the
  // accessibility tree, which is why the old aria-hidden on this node is
  // gone — pairing aria-hidden with focusable descendants was itself a WCAG
  // 4.1.2 violation. Set via a ref effect rather than the `inert` JSX prop:
  // the installed @types/react only exposes `inert` in experimental.d.ts, so
  // the prop doesn't typecheck against the stable React types this repo
  // pins.
  useEffect(() => {
    panelRef.current?.toggleAttribute("inert", state !== "open" || tourDemoActive);
  }, [state, tourDemoActive]);

  const openFull = () => setState("open");
  const enterDockZone = () => setState((cur) => (cur === "docked" ? "peek" : cur));
  const leaveDockZone = () => setState((cur) => (cur === "peek" ? "docked" : cur));

  if (state === "closed") return null;

  return (
    <div ref={containerRef} onMouseEnter={enterDockZone} onMouseLeave={leaveDockZone}>
      <div
        ref={panelRef}
        className="cd-chat-panel"
        data-state={state}
        role="dialog"
        aria-label="Ask Calderyn"
        aria-hidden={tourDemoActive ? true : undefined}
      >
        <div className="cd-chat-head">
          <div className="cd-chat-head-title">
            <span className="cd-chat-head-mark">
              <CDIcon name="assist" size={15} strokeWidth={2} />
            </span>
            <div>
              <div className="cd-h3">Ask Calderyn</div>
              <div className="cd-caption">Sees your store and can act on it</div>
            </div>
          </div>
          <div className="cd-chat-head-btns">
            <Btn small disabled={tourDemoActive} onClick={newChat}>
              New chat
            </Btn>
            <button
              type="button"
              className="cd-chat-close"
              aria-label="Close assistant"
              disabled={tourDemoActive}
              onClick={() => setState("closed")}
            >
              <CDIcon name="x" size={16} strokeWidth={2} />
            </button>
          </div>
        </div>

      <div className="cd-chat-msgs" ref={msgsRef}>
        {tourDemoActive && tourDemoStage >= 1 && (
          <div className="cd-chat-bubble" data-role="user" aria-label="You">
            <div className="cd-chat-bubble-body">
              <p className="cd-body">What should I reorder this week?</p>
            </div>
          </div>
        )}
        {tourDemoActive && tourDemoStage >= 2 && (
          <div className="cd-chat-bubble" data-role="assistant" aria-label="Calderyn">
            <div className="cd-chat-bubble-body">
              <p className="cd-body">Linen Shirt is first—only 3 left and selling fastest.</p>
            </div>
          </div>
        )}
        {!tourDemoActive && historyLoaded && messages.length === 0 && (
          <div className="cd-chat-empty">
            <p className="cd-sub">
              Ask anything about your store&rsquo;s alerts, campaigns, inventory, or action
              history — or ask it to take action, like pausing a campaign or issuing a refund.
              Start with one of these:
            </p>
            <div className="cd-chat-chips">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="cd-chat-chip"
                  disabled={sending}
                  onClick={() => sendText(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {!tourDemoActive && messages.map((m) => (
          <div
            key={m.id}
            className="cd-chat-bubble"
            data-role={m.role}
            aria-label={m.role === "assistant" ? "Calderyn" : "You"}
          >
            <div className="cd-chat-bubble-body">
              {m.role === "assistant" ? (
                <Markdown source={m.content} />
              ) : (
                <p className="cd-body">{m.content}</p>
              )}
              {m.draftedAction && (
                <DraftActionCard
                  action={m.draftedAction}
                  app={app}
                  onClose={() => setState("closed")}
                />
              )}
              {m.receipts.map((r, i) => (
                // Receipts have no id of their own; a message's list is fixed
                // once persisted, so index is a stable key.
                <ReceiptChip key={i} receipt={r} />
              ))}
              {m.pendingAction && (
                <PendingConfirmCard
                  pending={m.pendingAction}
                  onConfirmed={(receipt, message) => {
                    if (message) {
                      setMessages((prev) => [...prev, message]);
                    } else {
                      // Bookkeeping-only failure (rare): the action already ran
                      // server-side but persisting the follow-up turn didn't.
                      // Fall back to the receipt the action call itself always
                      // returns, so the thread still shows what happened AND
                      // keeps the Undo affordance instead of going silent.
                      setMessages((prev) => [
                        ...prev,
                        {
                          id: nextLocalId(),
                          role: "assistant",
                          content: `Confirmed — ${receipt.summary}`,
                          draftedAction: null,
                          receipts: [receipt],
                          pendingAction: null,
                          createdAt: new Date().toISOString(),
                        },
                      ]);
                    }
                  }}
                />
              )}
            </div>
          </div>
        ))}
        {!tourDemoActive && sending && (
          <div className="cd-chat-thinking" role="status">
            <span className="cd-chat-dot" />
            <span className="cd-chat-dot" />
            <span className="cd-chat-dot" />
            <span className="cd-chat-thinking-text">{thinking}</span>
          </div>
        )}
        {!tourDemoActive && errorText && <div className="cd-chat-error">{errorText}</div>}
      </div>

      <div className="cd-chat-composer">
        <textarea
          ref={inputRef}
          className="cd-input cd-chat-input"
          rows={1}
          placeholder="Ask about your data…"
          value={tourDemoActive ? tourDemoInput : input}
          disabled={tourDemoActive || sending}
          onChange={(e) => {
            if (!tourDemoActive) setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (tourDemoActive) return;
            // Chat convention: Enter sends, Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText(input);
            }
          }}
        />
        <Btn
          kind="primary"
          small
          disabled={tourDemoActive || !input.trim() || sending}
          onClick={() => sendText(input)}
        >
          Send
        </Btn>
      </div>
      </div>

      {
        // Rendered as a sibling of the panel, not nested inside it, so it
        // sits outside the inert subtree above and stays clickable while the
        // panel itself is inert. Always mounted (not just during peek) so
        // peekCatchRef is stable across state changes and the GSAP executor
        // above can tween it in lockstep with the panel — sharing the
        // panel's own base box (.cd-chat-peek-catch) plus the identical
        // per-state xPercent means this control's hit area always coincides
        // with whatever the panel visually shows: nothing in closed/open (no
        // catch needed there — open is where the real panel takes clicks),
        // and exactly the visible sliver in peek. `data-state` plus the
        // pointerEvents the executor sets are the belt-and-braces gate: it
        // only ever catches clicks while state is "peek". Mouse-only by
        // design: aria-hidden + tabIndex=-1 keep it out of the tab order and
        // accessibility tree, since the dock pill is the accessible way to
        // reopen.
      }
      <button
        ref={peekCatchRef}
        type="button"
        className="cd-chat-peek-catch"
        data-state={state}
        aria-label="Open assistant"
        aria-hidden="true"
        tabIndex={-1}
        onClick={openFull}
      />

      {(state === "docked" || state === "peek") && (
        <div className="cd-chat-dock-wrap">
          <button
            ref={pillRef}
            type="button"
            className="cd-chat-dock"
            aria-label="Reopen assistant"
            onClick={openFull}
          >
            <CDIcon name="assist" size={16} strokeWidth={2} />
            <span>Chat</span>
          </button>
          <button
            type="button"
            className="cd-chat-dock-dismiss"
            aria-label="Dismiss assistant"
            onClick={(e) => {
              // The dismiss button is a sibling of the pill, not nested
              // inside it, so this click wouldn't bubble into the pill's own
              // onClick anyway — stop it explicitly so a future restructure
              // can't silently reopen-then-close on the same click.
              e.stopPropagation();
              setState("closed");
            }}
          >
            <CDIcon name="x" size={11} strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
}
