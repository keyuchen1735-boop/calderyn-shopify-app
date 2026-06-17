// Business-hours window editor: a single "only act during business hours"
// toggle, and (when on) whole-hour start/end selects in the store's timezone.
// No timezone picker — the merchant edits wall-clock hours; the server hides
// the UTC conversion. onChangeWindow always emits the full {start,end,tz}.
import { Toggle } from "./ui";

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);

export function BusinessHoursEditor({
  enabled,
  start,
  end,
  tz,
  onToggle,
  onChangeWindow,
  disabled,
}: {
  enabled: boolean;
  start: string;
  end: string;
  tz: string;
  onToggle: (on: boolean) => void;
  onChangeWindow: (next: { start: string; end: string; tz: string }) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div className="cd-setting">
        <div className="min-w-0 flex-1">
          <div className="cd-row-title">Only act during business hours</div>
          <div className="cd-caption" style={{ maxWidth: "46ch" }}>
            Outside this window, actions queue for review. Times are in {tz}.
          </div>
        </div>
        <Toggle value={enabled} disabled={disabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div className="cd-setting">
          <div className="min-w-0 flex-1">
            <div className="cd-row-title">Window</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              className="cd-input"
              value={start}
              disabled={disabled}
              onChange={(e) => onChangeWindow({ start: e.target.value, end, tz })}
            >
              {HOURS.map((hh) => (
                <option key={hh} value={hh}>
                  {hh}
                </option>
              ))}
            </select>
            <span className="cd-caption">to</span>
            <select
              className="cd-input"
              value={end}
              disabled={disabled}
              onChange={(e) => onChangeWindow({ start, end: e.target.value, tz })}
            >
              {HOURS.map((hh) => (
                <option key={hh} value={hh}>
                  {hh}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  );
}
