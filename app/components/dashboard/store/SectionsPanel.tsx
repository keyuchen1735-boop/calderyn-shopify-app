// Floating section editor for the home page: list the page's sections in order,
// move / remove any of them, and redo a design section with an optional
// instruction. Presentational plus local open/instruction state; Store.tsx owns
// the section data and the network calls.
import { useState } from "react";
import { CDIcon } from "../icons";
import { Btn } from "../ui";
import type { StudioSection } from "~/lib/dashboard/store-client";

const KIND_ICON: Record<StudioSection["kind"], string> = {
  design: "sparkle",
  products: "grid",
  collections: "tag",
  content: "pencil",
};

export default function SectionsPanel({
  sections,
  busyId,
  onMove,
  onRemove,
  onRegenerate,
}: {
  sections: StudioSection[];
  /** Section id a mutation is in flight for (disables its row), or null. */
  busyId: string | null;
  onMove: (id: string, direction: "up" | "down") => void;
  onRemove: (id: string) => void;
  onRegenerate: (id: string, instruction?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /** Section whose redo-instruction input is open. */
  const [redoId, setRedoId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");

  if (sections.length === 0) return null;

  const submitRedo = (id: string) => {
    onRegenerate(id, instruction.trim() || undefined);
    setRedoId(null);
    setInstruction("");
  };

  return (
    <div className="cd-sections" data-open={open ? "1" : "0"}>
      <button
        type="button"
        className="cd-sections__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <CDIcon name="layers" size={13} strokeWidth={1.9} />
        Sections
      </button>
      {open && (
        <div className="cd-sections__panel" role="list" aria-label="Home page sections">
          {sections.map((s, i) => {
            const busy = busyId === s.id;
            return (
              <div key={s.id} className="cd-sections__row" role="listitem" data-busy={busy ? "1" : "0"}>
                <CDIcon name={KIND_ICON[s.kind]} size={13} strokeWidth={1.9} />
                <span className="cd-sections__title" title={s.title}>{s.title}</span>
                <span className="cd-sections__actions">
                  <button type="button" aria-label="Move up" disabled={busy || i === 0} onClick={() => onMove(s.id, "up")}>
                    <CDIcon name="chevronUp" size={13} strokeWidth={2} />
                  </button>
                  <button type="button" aria-label="Move down" disabled={busy || i === sections.length - 1} onClick={() => onMove(s.id, "down")}>
                    <CDIcon name="chevronDown" size={13} strokeWidth={2} />
                  </button>
                  {s.kind === "design" && (
                    <button
                      type="button"
                      aria-label="Redo this section"
                      disabled={busy}
                      onClick={() => {
                        setRedoId(redoId === s.id ? null : s.id);
                        setInstruction("");
                      }}
                    >
                      <CDIcon name="sparkle" size={13} strokeWidth={2} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label="Remove section"
                    disabled={busy || sections.length <= 1}
                    onClick={() => onRemove(s.id)}
                  >
                    <CDIcon name="x" size={13} strokeWidth={2} />
                  </button>
                </span>
                {redoId === s.id && (
                  <div className="cd-sections__redo">
                    <input
                      type="text"
                      value={instruction}
                      maxLength={500}
                      placeholder="What should change? (optional)"
                      onChange={(e) => setInstruction(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") submitRedo(s.id);
                        if (e.key === "Escape") setRedoId(null);
                      }}
                    />
                    <Btn kind="primary" small disabled={busy} onClick={() => submitRedo(s.id)}>
                      {busy ? "Redoing…" : "Redo"}
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
