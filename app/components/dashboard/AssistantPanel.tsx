import { useCallback, useEffect, useRef, useState } from "react";

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

// Kinds the dashboard can truly execute inline come from DASH_INLINE_ACTIONS
// (executeAction has a live endpoint for them). Everything else — exclude_geo,
// create_po_draft, reallocate_budget — deep-links to its review surface instead
// of faking a run.
let localSeq = 0;
const nextLocalId = () => `chat-local-${++localSeq}`;

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
      {canUndo &&
        (state === "undone" ? (
          <span className="cd-chat-action-done">
            <CDIcon name="check" size={13} strokeWidth={2.2} /> Undone
          </span>
        ) : (
          <div className="cd-chat-action-btns">
            <Btn small disabled={state === "undoing"} onClick={undo}>
              {state === "undoing" ? "Undoing…" : "Undo"}
            </Btn>
          </div>
        ))}
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
}: {
  app: DashboardCtx;
  openSignal?: number;
  /** A hand-off from Home's prompt bar: open the panel and send this text as
   *  the next user turn. `n` makes re-sends of the same text distinct. */
  prompt?: { n: number; text: string } | null;
}) {
  const [open, setOpen] = useState(false);

  // The sidebar "Ask Calderyn" button and the mobile "More" sheet open the
  // panel by bumping openSignal. Each increment re-opens it.
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const thinking = useThinkingPhrase(sending);
  const [errorText, setErrorText] = useState<string | null>(null);

  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load history once, the first time the panel opens.
  useEffect(() => {
    if (!open || historyLoaded) return;
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
  }, [open, historyLoaded]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [messages, sending, open]);

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
    setOpen(true);
    // Keyed on n so a re-run with the same hand-off (StrictMode) can't
    // enqueue it twice.
    setQueuedPrompts((q) => (q.some((p) => p.n === prompt.n) ? q : [...q, prompt]));
  }, [prompt]);
  useEffect(() => {
    if (!open || queuedPrompts.length === 0 || !historyLoaded || sending) return;
    const [next, ...rest] = queuedPrompts;
    setQueuedPrompts(rest);
    void sendText(next.text);
  }, [open, queuedPrompts, historyLoaded, sending, sendText]);
  useEffect(() => {
    if (!open) setQueuedPrompts([]);
  }, [open]);

  // Opening the panel is a context switch — put the caret in the composer so
  // the next keystrokes land in the conversation, not behind the dialog.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="cd-chat-panel" role="dialog" aria-label="Ask Calderyn">
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
          <Btn small onClick={newChat}>
            New chat
          </Btn>
          <button
            type="button"
            className="cd-chat-close"
            aria-label="Close assistant"
            onClick={() => setOpen(false)}
          >
            <CDIcon name="x" size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="cd-chat-msgs" ref={msgsRef}>
        {historyLoaded && messages.length === 0 && (
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
        {messages.map((m) => (
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
                  onClose={() => setOpen(false)}
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
        {sending && (
          <div className="cd-chat-thinking" role="status">
            <span className="cd-chat-dot" />
            <span className="cd-chat-dot" />
            <span className="cd-chat-dot" />
            <span className="cd-chat-thinking-text">{thinking}</span>
          </div>
        )}
        {errorText && <div className="cd-chat-error">{errorText}</div>}
      </div>

      <div className="cd-chat-composer">
        <textarea
          ref={inputRef}
          className="cd-input cd-chat-input"
          rows={1}
          placeholder="Ask about your data…"
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Chat convention: Enter sends, Shift+Enter inserts a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText(input);
            }
          }}
        />
        <Btn kind="primary" small disabled={!input.trim() || sending} onClick={() => sendText(input)}>
          Send
        </Btn>
      </div>
    </div>
  );
}
