import { useEffect, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import type { ChatMessage, ConversationSummary, DraftedAction } from "~/lib/assistant/types";
import { DraftActionCard } from "./DraftActionCard";

type LoaderData = {
  conversations: ConversationSummary[];
  conversationId: string | null;
  messages: ChatMessage[];
};
type ActionData = {
  conversationId?: string;
  assistantMessage?: ChatMessage;
  draftedAction?: DraftedAction | null;
  error?: { code: string; message: string };
};

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

  // Reconcile the assistant reply when a send completes.
  useEffect(() => {
    if (send.state === "idle" && send.data) {
      if (send.data.error) {
        setErrorText(send.data.error.message);
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

  function submit() {
    const text = input.trim();
    if (!text || sending) return;
    setMessages((prev) => [
      ...prev,
      { id: nextLocalId(), role: "user", content: text, draftedAction: null, createdAt: new Date().toISOString() },
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
            <Text as="p" tone="subdued" variant="bodySm">
              Ask about your alerts, campaigns, SKUs, or audit log — e.g. &ldquo;why did profit drop last week?&rdquo;
            </Text>
          )}
          {messages.map((m) => (
            <div key={m.id} className="calderyn-assistant-bubble" data-role={m.role}>
              <BlockStack gap="100">
                <Badge tone={m.role === "assistant" ? "info" : undefined}>
                  {m.role === "assistant" ? "Claude" : "You"}
                </Badge>
                <Text as="p" variant="bodyMd">
                  {m.content}
                </Text>
                {m.draftedAction && <DraftActionCard action={m.draftedAction} />}
              </BlockStack>
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
          <div style={{ flex: 1 }}>
            <TextField
              label="Message"
              labelHidden
              value={input}
              onChange={setInput}
              placeholder="Ask about your data…"
              autoComplete="off"
              multiline
            />
          </div>
          <Button variant="primary" loading={sending} disabled={!input.trim()} onClick={submit}>
            Send
          </Button>
        </InlineStack>
      </div>
    </div>
  );
}
