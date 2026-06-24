import { CDIcon } from "./icons";
import { normalizeTip, type Tip } from "~/lib/screener/types";

export type TipCategory =
  | "headline"
  | "hook"
  | "offer"
  | "proof"
  | "destination"
  | "audience"
  | "brand"
  | "visual"
  | "general";

// Category → CDIcon name.
const CATEGORY_ICON: Record<TipCategory, string> = {
  headline: "doc",
  hook: "megaphone",
  offer: "bag",
  proof: "shield",
  destination: "globe",
  audience: "scan",
  brand: "sparkle",
  visual: "box",
  general: "bolt",
};

// Keyword → category, most specific first. Matched against the tip's title +
// detail. Deterministic so the icon never depends on a model call (rule 5).
const RULES: { category: TipCategory; re: RegExp }[] = [
  { category: "proof", re: /proof|review|rating|testimonial|ugc|star|trust|social/i },
  { category: "offer", re: /offer|discount|free shipping|\bcta\b|call to action|urgency|incentive|deal|coupon|sale/i },
  { category: "destination", re: /destination|\burl\b|link|landing|marketplace|\bpdp\b|product page|where the click/i },
  { category: "audience", re: /audience|targeting|advantage\+|demographic|interest|broad|lookalike|retarget/i },
  { category: "brand", re: /brand|logo|identity|recall|watermark/i },
  { category: "visual", re: /image|video|visual|frame|footage|clip|background|crop|colou?r|lighting|thumbnail/i },
  { category: "hook", re: /hook|first line|opening|primary text|scroll|see more|attention/i },
  { category: "headline", re: /headline|title|header/i },
];

/** Pick a tip's icon category deterministically from its text. */
export function categorizeTip(tip: Tip): TipCategory {
  const t = normalizeTip(tip);
  const hay = `${t.title} ${t.detail}`;
  for (const r of RULES) if (r.re.test(hay)) return r.category;
  return "general";
}

/** Render the icon for a category from the in-house CDIcon set. */
export function TipIcon({ category, size = 15 }: { category: TipCategory; size?: number }) {
  return <CDIcon name={CATEGORY_ICON[category]} size={size} />;
}
