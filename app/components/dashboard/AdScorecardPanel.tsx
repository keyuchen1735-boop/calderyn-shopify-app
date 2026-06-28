// app/components/dashboard/AdScorecardPanel.tsx
// Dashboard render of one ad's predictive ScoreCard. The dashboard uses its own
// design system, so instead of the Polaris Scorecard this renders the same score
// data with the dashboard's primitives. Pure render — no server import;
// ~/lib/screener/types is a types-only module.
import {
  METRIC_GROUPS,
  METRIC_GROUP_LABELS,
  normalizeTip,
  type MetricGroup,
  type ScoreCard,
} from "~/lib/screener/types";
import { RingGauge, ScoreBar, Pill } from "./ui";

const GRADE_TONE: Record<string, "success" | "warn" | "critical"> = {
  winning: "success",
  okay: "warn",
  poor: "critical",
};
const GRADE_LABEL: Record<string, string> = {
  winning: "Winning",
  okay: "Okay",
  poor: "Poor",
};

export default function AdScorecardPanel({ card }: { card: ScoreCard }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <RingGauge value={card.composite} />
        <div className="flex flex-col gap-1">
          <Pill tone={GRADE_TONE[card.grade] ?? "neutral"}>
            {GRADE_LABEL[card.grade] ?? card.grade}
          </Pill>
          <span className="cd-caption">Confidence: {card.confidence}</span>
        </div>
      </div>
      <p className="cd-body">{card.summary}</p>
      {METRIC_GROUPS.map((g: MetricGroup) => {
        const rows = card.metrics.filter((m) => m.group === g);
        if (rows.length === 0) return null;
        return (
          <div key={g} className="flex flex-col gap-2">
            <span style={{ fontWeight: 600 }}>{METRIC_GROUP_LABELS[g]}</span>
            {rows.map((m) => (
              <div key={m.id} className="flex flex-col gap-0.5">
                <span className="cd-body">{m.label}</span>
                <ScoreBar score={m.score} />
              </div>
            ))}
          </div>
        );
      })}
      {card.tips.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span style={{ fontWeight: 600 }}>How to improve it</span>
          {card.tips.map((t, i) => {
            const d = normalizeTip(t);
            return (
              <p key={i} className="cd-body">
                {i + 1}. {d.detail ? `${d.title} — ${d.detail}` : d.title}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}
