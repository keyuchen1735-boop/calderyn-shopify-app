// A guardrail control: preset chips + a "Custom" reveal that shows a number
// input. Reused for every numeric guardrail. Pure preset-matching is exported
// for unit tests; the input commits on blur or Enter, presets commit on click.
import { useEffect, useState } from "react";
import { Segmented } from "./ui";

const CUSTOM = "__custom__";

export function activePreset(value: number, presetValues: number[]): string {
  return presetValues.includes(value) ? String(value) : CUSTOM;
}

export function GuardrailField({
  value,
  presets,
  onCommit,
  toInput,
  fromInput,
  suffix,
  disabled,
}: {
  value: number;
  presets: { value: number; label: string }[];
  onCommit: (next: number) => void;
  /** stored unit -> input display (e.g. cents -> dollars). Defaults to String(value). */
  toInput?: (v: number) => string;
  /** input string -> stored unit; return null to reject (e.g. dollars -> cents). */
  fromInput?: (raw: string) => number | null;
  suffix?: string;
  disabled?: boolean;
}) {
  const presetValues = presets.map((p) => p.value);
  const [mode, setMode] = useState(activePreset(value, presetValues));
  const [draft, setDraft] = useState(toInput ? toInput(value) : String(value));

  // Re-sync when the upstream value changes (refresh / optimistic revert).
  useEffect(() => {
    setMode(activePreset(value, presetValues));
    setDraft(toInput ? toInput(value) : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const options = [
    ...presets.map((p) => ({ value: String(p.value), label: p.label })),
    { value: CUSTOM, label: "Custom" },
  ];

  const commitDraft = () => {
    const parsed = fromInput ? fromInput(draft) : Number(draft);
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) return;
    onCommit(parsed);
  };

  return (
    <div className="cd-guardrail-field">
      <Segmented
        small
        value={mode}
        options={options}
        onChange={(v) => {
          setMode(v);
          if (v !== CUSTOM) onCommit(Number(v));
        }}
      />
      {mode === CUSTOM && (
        <label className="cd-field" style={{ marginTop: 8, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <input
            className="cd-input tabular-nums"
            type="number"
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
            }}
          />
          {suffix && <span className="cd-caption">{suffix}</span>}
        </label>
      )}
    </div>
  );
}
