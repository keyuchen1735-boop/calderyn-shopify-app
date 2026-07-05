// The 340px "Build with Calderyn" chat rail: thread + composer. Purely a
// renderer — Store.tsx owns the message list, the composer text, and what
// happens on send/attach. Each "ai-working" message carries its own phase
// snapshot (see chat-types.ts), so an older, already-finished card in history
// can never be flipped back to "running" by a later, unrelated build.
import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { CDIcon } from "../icons";
import { buildStep } from "../screens/store-logic";
import BuildStepsCard from "./BuildStepsCard";
import type { ChatMsg } from "./chat-types";

// The brand hexagon mark, matching the sidebar's inline SVG exactly (see
// DashboardApp.tsx) — sized down for the rail header.
function RailMark() {
  return (
    <svg className="cd-rail-mark" viewBox="0 0 32 32" fill="none" role="img" aria-label="Calderyn">
      <path d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z" fill="var(--accent)" />
      <path
        d="M24.4 11.15 L16 6.3 L7.6 11.15 L7.6 20.85 L16 25.7 L24.4 20.85"
        stroke="var(--on-accent)"
        strokeWidth="3.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WorkingCard({ msg }: { msg: Extract<ChatMsg, { kind: "ai-working" }> }) {
  return <BuildStepsCard rows={[buildStep(msg.phase)]} />;
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
    return (
      <div className="cd-bub cd-bub-ai">
        <WorkingCard msg={msg} />
      </div>
    );
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

export default function ChatRail({
  messages,
  prompt,
  onPromptChange,
  onSend,
  busy,
  attaching,
  onAttachFiles,
}: {
  messages: ChatMsg[];
  prompt: string;
  onPromptChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  attaching: boolean;
  onAttachFiles: (files: File[]) => void;
}) {
  const threadRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    if (!prompt.trim() || busy) return;
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

  return (
    <div className="cd-rail">
      <div className="cd-rail-head">
        <RailMark />
        <b>Build with Calderyn</b>
      </div>
      <div className="cd-thread" ref={threadRef}>
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
      </div>
      <div className="cd-rail-foot">
        <div className="cd-composer">
          <textarea
            className="cd-composer-in"
            rows={2}
            placeholder="Tell Calderyn what to change…"
            aria-label="Tell Calderyn what to change"
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="cd-composer-row">
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
            <button
              type="button"
              className="cd-composer-send"
              aria-label="Send"
              disabled={!prompt.trim() || busy}
              onClick={send}
            >
              <CDIcon name="arrowUp" size={14} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
