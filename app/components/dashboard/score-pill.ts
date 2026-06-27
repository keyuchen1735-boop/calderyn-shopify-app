// Pure band → Pill tone/label mapping for the Calderyn ScorePill. Kept in a .ts
// (no React) so the band-drives-color logic is unit-testable under the node-only
// vitest harness. ScorePill (ui.tsx) renders <Pill> from this.
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

export type ScorePillTone = "neutral" | "success" | "critical" | "warn";

const BAND_STYLE: Record<CampaignCalderynScore["band"], { label: string; tone: ScorePillTone }> = {
  strong: { label: "Strong", tone: "success" },
  fair: { label: "Fair", tone: "warn" },
  weak: { label: "Weak", tone: "critical" },
  nodata: { label: "Score pending", tone: "neutral" },
};

export function scorePillStyle(score: CampaignCalderynScore): { label: string; tone: ScorePillTone } {
  const base = BAND_STYLE[score.band];
  if (score.value == null) return { label: base.label, tone: base.tone };
  return { label: `${score.value} · ${base.label}`, tone: base.tone };
}
