// Calderyn DashV2 — "Ask Calderyn" chat panel: floating launcher + glass
// slide-over. Same assistant brain as the embedded slideout, rendered with
// the dashboard's own cd-* design system (no Polaris here).
import { useCallback, useEffect, useRef, useState } from "react";

import * as client from "~/lib/dashboard/client";
import { AssistantSendError } from "~/lib/dashboard/client";
import type { ChatMessage, DraftedAction } from "~/lib/assistant/types";
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

export default function AssistantPanel({ app }: { app: DashboardCtx }) {
  const [open, setOpen] = useState(false);
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
          createdAt: new Date().toISOString(),
        },
      ]);
      setInput("");
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

  if (!open) {
    return (
      <button
        type="button"
        className="cd-chat-launcher"
        onClick={() => setOpen(true)}
        aria-label="Ask Calderyn"
      >
        <CDIcon name="assist" size={18} strokeWidth={1.9} />
        <span>Ask Calderyn</span>
      </button>
    );
  }

  return (
    <div className="cd-chat-panel" role="dialog" aria-label="Ask Calderyn">
      <div className="cd-chat-head">
        <div className="cd-chat-head-title">
          <span className="cd-chat-head-mark">
            <CDIcon name="assist" size={15} strokeWidth={2} />
          </span>
          <div>
            <div className="cd-h3">Ask Calderyn</div>
            <div className="cd-caption">Knows your alerts, campaigns &amp; stock</div>
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
              history — or start with one of these:
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
