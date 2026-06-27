// Shared, browser-safe assembly for a pending proposal's "why" + decision copy,
// used by BOTH the dashboard inspector (client-side, inspector-vm.ts) and the
// server-side Live Engine builder (live-engine-page.server.ts) so the embedded
// and dashboard surfaces present an identical card. Pure — only depends on the
// evidence-label machinery in labels.ts; no `.server` imports.
import { formatEvidenceKey, getEvidenceFormatter, INTERNAL_EVIDENCE_ID_KEYS } from "../labels";
import type { InspectorStat } from "./live-engine-types";

export type { InspectorStat };

// Evidence keys suppressed from the figures: internal platform IDs (plumbing,
// never merchant-facing) and the product name, which already heads the card.
const SUPPRESSED_KEYS = new Set<string>([...INTERNAL_EVIDENCE_ID_KEYS, "title", "sku_title", "sku"]);
// A glanceable "why" shows the few most salient figures; the full evidence set
// stays one click away on the alert detail page.
const STAT_LIMIT = 3;

/** Turn an alert's evidence map into a few clean, humanized figures. */
export function pendingEvidenceStats(
  evidence: Record<string, unknown> | null | undefined,
): InspectorStat[] {
  if (!evidence) return [];
  const out: InspectorStat[] = [];
  for (const [key, raw] of Object.entries(evidence)) {
    if (raw === null || raw === undefined || raw === "") continue;
    if (SUPPRESSED_KEYS.has(key)) continue;
    const format = getEvidenceFormatter(key);
    out.push({ label: formatEvidenceKey(key), value: format ? format(raw) : String(raw) });
    if (out.length >= STAT_LIMIT) break;
  }
  return out;
}

/** "Calderyn will reallocate inventory now. You can undo it anytime…" */
export function pendingApproveText(actionLabel: string): string {
  return `Calderyn will ${actionLabel.toLowerCase()} now. You can undo it anytime from your history.`;
}

export const PENDING_DENY_TEXT =
  "Nothing changes, and Calderyn gets more cautious about this kind of call.";

export const PENDING_TRUST_LINE =
  "Still learning this one, so it checks with you first. Approve a few and it'll start handling them on its own.";
