import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  BlockStack,
  Box,
  Button,
  InlineStack,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import type { ChatMessage, ConversationSummary } from "~/lib/assistant/types";
import { SUGGESTED_PROMPTS } from "~/lib/assistant/suggested-prompts";
import { Markdown } from "~/components/Markdown";
import { DraftActionCard } from "./DraftActionCard";

type LoaderData = {
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: ChatMessage[];
};
type ActionData = {
  conversationId?: string;
  assistantMessage?: ChatMessage;
  draftedAction?: DraftedActionData;
  error?: { code: string; message: string };
};
type DraftedActionData = ChatMessage["draftedAction"];

let localId = 0;
const nextLocalId = () => `local-${++localId}`;

export function AssistantSlideout() {
  const [open, setOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);

  const history = useFetcher<LoaderData>();
  const send = useFetcher<ActionData>();
  const sending = send.state !== "idle";
  const messagesRef = useRef<HTMLDivElement>(null);

  // Load history the first time the panel opens.
  useEffect(() => {
    if (open && history.state === "idle" && history.data === undefined) {
      history.load("/app/assistant");
    }
  }, [open, history]);

  useEffect(() => {
    if (history.data) {
      setMessages(history.data.messages);
      setConversationId(history.data.conversationId);
    }
  }, [history.data]);

  // The optimistically-added user turn for the in-flight send; rolled back on
  // error so the transcript never shows a message the server didn't process.
  const pendingRef = useRef<{ id: string; text: string } | null>(null);

  // Reconcile the assistant reply when a send completes.
  useEffect(() => {
    if (send.state === "idle" && send.data) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (send.data.error) {
        setErrorText(send.data.error.message);
        if (pending) {
          // Remove the unprocessed optimistic turn and put the text back in
          // the composer so the merchant can retry without retyping.
          setMessages((prev) => prev.filter((m) => m.id !== pending.id));
          setInput((cur) => cur || pending.text);
        }
        return;
      }
      setErrorText(null);
      if (send.data.conversationId) setConversationId(send.data.conversationId);
      if (send.data.assistantMessage) {
        const reply = send.data.assistantMessage;
        setMessages((prev) => [...prev, reply]);
      }
    }
  }, [send.state, send.data]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [messages, sending]);

  function sendText(raw: string) {
    const text = raw.trim();
    if (!text || sending) return;
    const id = nextLocalId();
    pendingRef.current = { id, text };
    setMessages((prev) => [
      ...prev,
      { id, role: "user", content: text, draftedAction: null, createdAt: new Date().toISOString() },
    ]);
    const fd = new FormData();
    fd.set("message", text);
    if (conversationId) fd.set("conversationId", conversationId);
    send.submit(fd, { method: "post", action: "/app/assistant" });
    setInput("");
  }

  function newChat() {
    setMessages([]);
    setConversationId(null);
    setErrorText(null);
  }

  if (!open) {
    return (
      <div className="calderyn-assistant-launcher">
        <Button variant="primary" onClick={() => setOpen(true)}>
          Ask Calderyn
        </Button>
      </div>
    );
  }

  return (
    <div className="calderyn-assistant-panel" role="dialog" aria-label="Calderyn assistant">
      <div className="calderyn-assistant-header">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingSm">
            Calderyn assistant
          </Text>
          <InlineStack gap="200">
            <Button size="slim" onClick={newChat}>
              New chat
            </Button>
            <Button size="slim" variant="tertiary" accessibilityLabel="Close assistant" onClick={() => setOpen(false)}>
              Close
            </Button>
          </InlineStack>
        </InlineStack>
      </div>

      <div className="calderyn-assistant-messages" ref={messagesRef}>
        <BlockStack gap="0">
          {messages.length === 0 && (
            <BlockStack gap="300">
              <Text as="p" tone="subdued" variant="bodySm">
                Ask about your alerts, campaigns, SKUs, or audit log — or start with one of these:
              </Text>
              <div className="calderyn-assistant-suggestions">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="calderyn-assistant-chip"
                    disabled={sending}
                    onClick={() => sendText(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </BlockStack>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className="calderyn-assistant-bubble"
              data-role={m.role}
              aria-label={m.role === "assistant" ? "Calderyn" : "You"}
            >
              <div className="calderyn-assistant-bubble-body">
                {m.role === "assistant" ? (
                  <Markdown source={m.content} />
                ) : (
                  <Text as="p" variant="bodyMd">
                    {m.content}
                  </Text>
                )}
                {m.draftedAction && <DraftActionCard action={m.draftedAction} />}
              </div>
            </div>
          ))}
          {sending && (
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" accessibilityLabel="Claude is thinking" />
              <Text as="span" tone="subdued" variant="bodySm">
                Claude is thinking&hellip;
              </Text>
            </InlineStack>
          )}
          {errorText && (
            <Box paddingBlockStart="200">
              <Text as="p" tone="critical" variant="bodySm">
                {errorText}
              </Text>
            </Box>
          )}
        </BlockStack>
      </div>

      <div className="calderyn-assistant-composer">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <div
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              // Chat convention: Enter sends, Shift+Enter inserts a newline.
              // (Polaris TextField doesn't expose onKeyDown; intercepting on
              // the wrapper still cancels the textarea's default insert.)
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText(input);
              }
            }}
          >
            <TextField
              label="Message"
              labelHidden
              value={input}
              onChange={setInput}
              placeholder="Ask about your data… (Shift+Enter for a new line)"
              autoComplete="off"
              multiline
            />
          </div>
          <Button variant="primary" loading={sending} disabled={!input.trim()} onClick={() => sendText(input)}>
            Send
          </Button>
        </InlineStack>
      </div>
    </div>
  );
}
