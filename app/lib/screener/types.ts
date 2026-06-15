// app/lib/screener/types.ts

export const MIN_SPEND_CENTS = 1000;       // $10 floor for the spend assumption
export const MAX_SPEND_CENTS = 10_000_000; // $100k ceiling
export const DEFAULT_SPEND_CENTS = 50_000; // $500 default

/** Fallbacks used only on cold start (no SKU price / CVR). Documented + labeled. */
export const DEFAULT_CVR = 0.02;              // 2% order conversion
export const DEFAULT_AOV_CENTS = 4000;        // $40 average order value
export const DEFAULT_BASELINE_CTR = 0.01;     // 1% click-through
export const DEFAULT_BASELINE_CPM_CENTS = 1500; // $15 CPM
export const DEFAULT_ENGAGEMENT_RATE = 0.05;  // 5% hold/engagement
export const DEFAULT_BREAK_EVEN_ROAS = 2.0;

export const METRIC_GROUPS = [
  "attention",
  "message",
  "offer_conversion",
  "trust_safety",
] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

export const METRIC_GROUP_LABELS: Record<MetricGroup, string> = {
  attention: "Attention",
  message: "Message",
  offer_conversion: "Offer & Conversion",
  trust_safety: "Trust & Safety",
};

/** The 13 creative dimensions, each scored 0..100 by Claude with reasoning. */
export const DIMENSIONS: { id: string; group: MetricGroup; label: string }[] = [
  { id: "hook_strength", group: "attention", label: "Hook strength" },
  { id: "visual_focal_clarity", group: "attention", label: "Visual focal clarity" },
  { id: "brand_presence", group: "attention", label: "Brand presence / recall" },
  { id: "headline_clarity", group: "message", label: "Headline clarity" },
  { id: "copy_concision", group: "message", label: "Copy concision" },
  { id: "readability_tone", group: "message", label: "Readability / tone match" },
  { id: "offer_strength", group: "offer_conversion", label: "Offer strength" },
  { id: "creative_offer_fit", group: "offer_conversion", label: "Creative ↔ offer fit" },
  { id: "cta_strength", group: "offer_conversion", label: "CTA strength" },
  { id: "audience_fit", group: "offer_conversion", label: "Audience / targeting fit" },
  { id: "social_proof", group: "trust_safety", label: "Social proof / trust signals" },
  { id: "policy_risk", group: "trust_safety", label: "Policy / compliance safety" },
  { id: "text_in_image", group: "trust_safety", label: "Text-in-image restraint" },
];
export type DimensionId = (typeof DIMENSIONS)[number]["id"];

export interface MetricScore {
  id: string;          // DimensionId
  group: MetricGroup;
  label: string;
  score: number;       // 0..100
  reasoning: string;
  benchmarkAds?: string[];
}

export type Grade = "winning" | "okay" | "poor";
export type Confidence = "high" | "medium" | "low";

export interface PredictedOutcomes {
  estimatedRoas: number;
  roasLow: number;
  roasHigh: number;
  breakEvenRoas: number;
  predictedCtr: number;          // fraction 0..1
  holdRate: number;              // fraction 0..1
  assumedSpendCents: number;
  predictedRevenueCents: number;
  mappedSku: string | null;
  skuPriceCents: number | null;
}

/**
 * One improvement tip. `title` is a short, scannable action line (what to do);
 * `detail` is the product-specific weakness → paste-ready example → payoff,
 * revealed on click. Split so the UI stays concise by default but keeps the
 * specificity merchants act on (see PR #79).
 */
export interface TipDetail {
  title: string;
  detail: string;
}

/**
 * A tip is normally a {@link TipDetail}, but runs persisted before tips were
 * structured stored a plain string. Accept both; render through
 * {@link normalizeTip} so old scorecards keep working.
 */
export type Tip = string | TipDetail;

/** Coerce a legacy string tip or a structured tip into {@link TipDetail}. */
export function normalizeTip(tip: Tip): TipDetail {
  return typeof tip === "string" ? parseLegacyTip(tip) : tip;
}

/**
 * Legacy runs stored each tip as one plain string, usually shaped like
 * "1. ACTION LINE — the product-specific detail…". Split it into the same
 * {title, detail} shape new runs emit, so every surface shows a scannable title
 * and reveals the rest on click. Splits on the FIRST separator only (details can
 * contain their own dashes, e.g. a quoted headline) and strips any leading list
 * marker. With no separator the whole string stays the title with no detail.
 */
function parseLegacyTip(raw: string): TipDetail {
  const s = raw.trim().replace(/^(?:\d+[.)]|[-*•])\s+/, "");
  // Title/detail boundary: an em/en dash, a spaced hyphen, or a colon.
  const sep = /\s+[—–]\s+|\s+-\s+|:\s+/.exec(s);
  if (!sep) return { title: s, detail: "" };
  const title = s.slice(0, sep.index).trim();
  const detail = s.slice(sep.index + sep[0].length).trim();
  return title && detail ? { title, detail } : { title: s, detail: "" };
}

export interface ScoreCard {
  composite: number;             // 0..100
  grade: Grade;
  confidence: Confidence;
  summary: string;
  metrics: MetricScore[];
  outcomes: PredictedOutcomes;
  tips: Tip[];
}

export type MediaKind = "image" | "video";

/** What the merchant enters (Plan 1) or what we fetch from Meta (Plan 2). */
export interface CreativeInput {
  /** Image creative, or the poster (first frame) for a video. data: or https:. */
  imageUrl: string | null;
  /** Absent/null on legacy rows and Meta-sourced creatives. */
  mediaKind?: MediaKind | null;
  /** Extracted key frames (data URLs, start → end). Video only. */
  videoFrameUrls?: string[];
  videoDurationSec?: number | null;
  headline: string;
  primaryText: string;
  cta: string;
  destinationUrl: string;
  audience: string;
}

/** Read from Supabase by history.server.ts; consumed (pure) by calibrate. */
export interface CalibrationInputs {
  accountBaselineCtr: number;       // fraction
  accountBaselineCpmCents: number;
  accountEngagementRate: number;    // fraction
  breakEvenRoas: number;
  mappedSku: string | null;
  skuPriceCents: number | null;
  skuCvr: number | null;            // fraction
  topAdNames: string[];
  historyAdCount: number;           // drives confidence / cold-start
}

export type RunStatus = "running" | "done" | "error";
export type RunSource = "manual" | "meta_ad";

/** DTO returned to the client — never the raw DB row. */
export interface CreativeScreenRun {
  id: string;
  status: RunStatus;
  source: RunSource;
  metaAdId: string | null;
  assumedSpendCents: number;
  scorecard: ScoreCard | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  creativeInput: CreativeInput | null;
  variants: Variant[];
}

/** One ad the merchant can pick to screen (Meta source). */
export interface ScreenableAd {
  id: string;
  name: string;
  effectiveStatus: string;
}

export type GenerationMode = "copy" | "image" | "video";

/** A generator's raw output: a regenerated creative + why it addresses the flaws. */
export interface GeneratedCandidate {
  input: CreativeInput;
  rationale: string;
}

/** A re-scored candidate that beat the original. */
export interface Variant {
  mode: GenerationMode;
  input: CreativeInput;
  rationale: string;
  composite: number;
  delta: number; // composite - original composite
  summary: string;
}
