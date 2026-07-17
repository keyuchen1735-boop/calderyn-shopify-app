import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { CDIcon } from "../icons";
import { buildSteps, canSendComposer } from "../screens/store-logic";
import BuildStepsCard from "./BuildStepsCard";
import type { ChatMsg } from "./chat-types";

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

function Bubble({ message }: { message: ChatMsg }) {
  if (message.kind === "user-text") return <div className="cd-bub cd-bub-user">{message.text}</div>;
  if (message.kind === "ai-working") {
    const rows = buildSteps(message.phase);
    return (
      <div className="cd-bub cd-bub-ai">
        <BuildStepsCard rows={rows} dimPending={rows.length > 1} />
      </div>
    );
  }
  return (
    <div className="cd-bub cd-bub-ai">
      {message.text}
      {message.actions?.length ? (
        <div className="cd-bub-btns">
          {message.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={action.kind === "primary" ? "cd-btn cd-btn-primary cd-btn-sm" : "cd-chip"}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ChatRail({
  messages,
  prompt,
  onPromptChange,
  onSend,
  onStop,
  busy,
  stoppable,
  attaching,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
}: {
  messages: ChatMsg[];
  prompt: string;
  onPromptChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  stoppable: boolean;
  attaching: boolean;
  attachments: Array<{ id: string; name: string; previewUrl?: string }>;
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const threadRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages.length]);

  const canSend = canSendComposer({ prompt, busy: busy || attaching });
  const send = () => {
    if (canSend) onSend();
  };
  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) onAttachFiles(files);
  };

  return (
    <div className="cd-rail">
      <div className="cd-rail-head">
        <RailMark />
        <b>Build with Calderyn</b>
      </div>
      <div className="cd-thread" ref={threadRef}>
        {messages.map((message) => <Bubble key={message.id} message={message} />)}
      </div>
      <div className="cd-rail-foot">
        <div className="cd-composer">
          {attachments.length > 0 ? (
            <div className="cd-composer-chips">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="cd-composer-chip">
                  {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : null}
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    className="cd-composer-chip-x"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <CDIcon name="x" size={12} strokeWidth={2.2} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            className="cd-composer-in"
            rows={2}
            placeholder="Tell Calderyn what to change…"
            aria-label="Tell Calderyn what to change"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="cd-composer-row">
            <button
              type="button"
              className="cd-composer-tool"
              title="Attach a design reference or shader"
              aria-label="Attach a design reference or shader"
              disabled={busy || attaching}
              onClick={() => fileInputRef.current?.click()}
            >
              <CDIcon name="paperclip" size={15} strokeWidth={1.9} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,.frag,.glsl,text/plain"
              multiple
              hidden
              aria-label="Attach a design reference or shader"
              onChange={onFileChange}
            />
            {stoppable ? (
              <button
                type="button"
                className="cd-composer-send cd-composer-stop"
                aria-label="Stop"
                title="Stop"
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
    </div>
  );
}
