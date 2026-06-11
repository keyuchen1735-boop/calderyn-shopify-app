// app/lib/seed/screener.ts
//
// Demo seed for the Ad Pre-Screen feature (creative_screen_run table).
//
// The screener's "latest" run renders in full on page load (route opens on the
// `result` phase when a scorecard exists), and `listRuns` shows the rest as
// history. This module produces a small set of already-scored runs so the
// feature is live-demo-ready without any external API call at view time.
//
// Fidelity: we hand-author only the part a model would produce — the 13
// per-dimension scores, their reasoning, the summary, and the tips — then run
// them through the REAL `calibrate()` so the composite, grade, confidence, and
// predicted outcomes are computed by production math, not faked. A reseed is
// deterministic given `nowMs`.
//
// The demo creatives are copy-only (no image): a broken <img> in a live demo is
// worse than none, and "pre-screen the copy before you produce the visual" is a
// real workflow. The visual dimensions are scored honestly low with a "no image
// supplied" reasoning, which also sets up the "add a hero visual" tip.

import { calibrate } from "../screener/calibrate.server";
import {
  DIMENSIONS,
  type CalibrationInputs,
  type CreativeInput,
  type MetricScore,
  type ScoreCard,
  type Variant,
} from "../screener/types";

/** A row ready to insert into `creative_screen_run` (id/created defaults aside). */
export interface ScreenerRunRow {
  shop_id: string;
  status: "done";
  source: "manual" | "meta_ad";
  meta_ad_id: string | null;
  mapped_sku_id: string | null;
  assumed_spend_cents: number;
  scorecard: ScoreCard;
  creative_input: CreativeInput;
  variants: Variant[];
  created_at: string;
  completed_at: string;
}

/** Minimal SKU reference the builder needs to ground a run in a real product. */
export interface SkuRef {
  id: string;
  priceCents: number;
}

/** One scored dimension before it's expanded with its canonical group/label. */
type DimScore = { score: number; reasoning: string; benchmarkAds?: string[] };

/** Shared account profile. Mirrors the seeded ad history closely enough that the
 * calibrated outcomes read as this merchant's real numbers (break-even 1.51×,
 * ~$26 CPM, 1.8% baseline CTR). Per-creative price/SKU/spend vary below. */
const ACCOUNT = {
  accountBaselineCtr: 0.018,
  accountBaselineCpmCents: 2600,
  accountEngagementRate: 0.05,
  breakEvenRoas: 1.51,
  skuCvr: 0.022,
  topAdNames: [
    "Brand Search — Exact — US",
    "Retargeting — 30d Site Engagers",
    "Prospecting — Advantage+ Shopping — US",
  ],
  historyAdCount: 22,
};

// `mappedSku` here is the merchant-facing display label shown in the outcome
// panel (`value={o.mappedSku ...}`), so we use the human-readable product title
// rather than the raw SKU code. The real FK lives in the row's `mapped_sku_id`
// column; these are terminal `done` runs, so nothing re-derives price from this
// field (the realized price is already baked into `skuPriceCents`).
function calibInputs(opts: { mappedSku: string | null; skuPriceCents: number | null }): CalibrationInputs {
  return {
    accountBaselineCtr: ACCOUNT.accountBaselineCtr,
    accountBaselineCpmCents: ACCOUNT.accountBaselineCpmCents,
    accountEngagementRate: ACCOUNT.accountEngagementRate,
    breakEvenRoas: ACCOUNT.breakEvenRoas,
    skuCvr: ACCOUNT.skuCvr,
    topAdNames: ACCOUNT.topAdNames,
    historyAdCount: ACCOUNT.historyAdCount,
    mappedSku: opts.mappedSku,
    skuPriceCents: opts.skuPriceCents,
  };
}

/** Expand a {dimId -> score+reasoning} map into the full, canonically-ordered
 * 13-dimension metric array. Throws if any dimension is missing — the test and
 * the real UI both assume all 13 are present. */
function buildMetrics(dims: Record<string, DimScore>): MetricScore[] {
  return DIMENSIONS.map((d) => {
    const s = dims[d.id];
    if (!s) throw new Error(`screener seed: missing dimension "${d.id}"`);
    const metric: MetricScore = {
      id: d.id,
      group: d.group,
      label: d.label,
      score: s.score,
      reasoning: s.reasoning,
    };
    if (s.benchmarkAds) metric.benchmarkAds = s.benchmarkAds;
    return metric;
  });
}

/** Assemble a full ScoreCard: hand-authored judgments + real calibration math. */
function buildScoreCard(args: {
  dims: Record<string, DimScore>;
  summary: string;
  tips: string[];
  calib: CalibrationInputs;
  assumedSpendCents: number;
}): ScoreCard {
  const metrics = buildMetrics(args.dims);
  const { outcomes, composite, grade, confidence } = calibrate(
    metrics,
    args.calib,
    args.assumedSpendCents,
  );
  return { composite, grade, confidence, summary: args.summary, metrics, outcomes, tips: args.tips };
}

const STORE = "https://calderyn-review-store.myshopify.com";
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Build the demo screen runs for a shop, newest first. The first element is the
 * "winning" run that renders on page load. SKUs are looked up by title; an
 * absent title degrades gracefully to an unmapped run (medium confidence).
 */
export function buildScreenerRuns(args: {
  shopId: string;
  skuByTitle: Map<string, SkuRef>;
  nowMs: number;
}): ScreenerRunRow[] {
  const { shopId, skuByTitle, nowMs } = args;
  const sku = (title: string): SkuRef | null => skuByTitle.get(title) ?? null;

  const cascade = sku("Cascade Rain Shell — M");
  const bottle = sku("Basecamp Water Bottle 750ml");
  const tee = sku("Summit Logo Tee — L");
  const pack = sku("Crestline Pack 28L");

  // ── Run 1 — WINNING — Cascade Rain Shell (newest → renders on load) ──────
  const cascadeSpend = 75_000;
  const cascadeCard = buildScoreCard({
    assumedSpendCents: cascadeSpend,
    calib: calibInputs({ mappedSku: cascade ? "Cascade Rain Shell — M" : null, skuPriceCents: cascade?.priceCents ?? null }),
    summary:
      "A sharp, proof-backed copy concept that's ready to run — the only thing holding it back from an elite score is the missing hero visual.",
    tips: [
      "Add a single high-contrast hero shot of the shell mid-stuff (packing into its own pocket) — it's the one move that lifts all three visual scores and the composite together.",
      "Test a first-order incentive (e.g. '$15 off your first order') against the free-shipping line; your 'Retargeting — 30d Site Engagers' audience responds to urgency.",
      "Pull one real review quote into the primary text — a named '— Sarah K., PCT thru-hiker' line outperforms an aggregate star count for cold traffic.",
    ],
    dims: {
      hook_strength: { score: 84, reasoning: "Specific, situational hook ('mile 9') paired with a tangible benefit (packs to fist-size) earns the scroll-stop even without a visual.", benchmarkAds: ["Prospecting — Advantage+ Shopping — US"] },
      visual_focal_clarity: { score: 58, reasoning: "No image was supplied, so there's no focal point to score — the copy implies a clear hero product, but a single high-contrast shot would lift this materially." },
      brand_presence: { score: 62, reasoning: "The product name carries the brand, but with no image there's no logo, palette, or visual identity present." },
      headline_clarity: { score: 90, reasoning: "States exactly what it is and the two benefits that matter (packability + waterproofing) in one read." },
      copy_concision: { score: 82, reasoning: "Three tight lines, each doing a job: hook, proof spec, social proof. The parenthetical could be trimmed for pace." },
      readability_tone: { score: 86, reasoning: "Confident, outdoorsy tone that matches a technical-apparel buyer and scans at a glance." },
      offer_strength: { score: 74, reasoning: "The free-shipping threshold is a real incentive that nudges AOV, though there's no first-purchase or bundle hook to add urgency." },
      creative_offer_fit: { score: 80, reasoning: "The waterproofing spec and the free-shipping line both point at the same single product and page — tight fit." },
      cta_strength: { score: 83, reasoning: "Branded, specific CTA ('Shop the Cascade Shell') beats a generic 'Shop now' and sets a clear expectation." },
      audience_fit: { score: 85, reasoning: "Copy speaks directly to wet-climate hikers — the exact segment your top 'Prospecting — Advantage+ Shopping — US' campaign converts.", benchmarkAds: ["Prospecting — Advantage+ Shopping — US"] },
      social_proof: { score: 80, reasoning: "Concrete proof (4.8★, 1,200+ hikers) is specific and believable; a one-line testimonial would push it further." },
      policy_risk: { score: 92, reasoning: "No restricted claims or prohibited content; the waterproofing spec is verifiable and compliant." },
      text_in_image: { score: 60, reasoning: "No image to evaluate for text density — neutral until a visual is attached." },
    },
  });
  const cascadeInput: CreativeInput = {
    imageUrl: null,
    headline: "The shell that packs to fist-size and shrugs off a downpour",
    primaryText:
      "Caught in the rain on mile 9? The Cascade Rain Shell seals out weather at 12,000mm waterproofing, then stuffs into its own chest pocket the moment the sky clears. 4.8★ from 1,200+ hikers.\n\nFree shipping over $75.",
    cta: "Shop the Cascade Shell",
    destinationUrl: `${STORE}/products/cascade-rain-shell`,
    audience: "Hikers & trail runners 25–45 in cold, wet climates, in-market for technical outerwear",
  };
  const cascadeVariants: Variant[] = [
    {
      mode: "copy",
      composite: cascadeCard.composite + 5,
      delta: 5,
      summary: "Tighter hook and a named testimonial lift believability and click intent.",
      rationale:
        "Front-loads the two hard numbers (fist-size, 12,000mm) into the headline and swaps the aggregate star count for a named thru-hiker quote — fixes the two lowest copy levers (offer urgency, social-proof specificity).",
      input: {
        imageUrl: null,
        headline: "Packs to fist-size. Seals out a 12,000mm downpour.",
        primaryText:
          "Mile 9, the sky opens up — and you stay dry. The Cascade Rain Shell blocks weather cold, then stuffs into its own chest pocket the moment it clears.\n\n\"Lightest real rain shell I've owned.\" — Sarah K., PCT thru-hiker. 4.8★ · 1,200+ hikers. Free shipping over $75.",
        cta: "Shop the Cascade Shell",
        destinationUrl: `${STORE}/products/cascade-rain-shell`,
        audience: "Hikers & trail runners 25–45 in cold, wet climates, in-market for technical outerwear",
      },
    },
    {
      mode: "copy",
      composite: cascadeCard.composite + 3,
      delta: 3,
      summary: "A real first-purchase incentive raises the offer score without diluting the benefit-led hook.",
      rationale:
        "Adds a first-order incentive ('$15 off') to address the soft offer score, and leads on the packability benefit your audience cares most about.",
      input: {
        imageUrl: null,
        headline: "The rain shell that disappears into your pack",
        primaryText:
          "12,000mm waterproof when the weather turns, fist-size when it doesn't. Built for hikers who refuse to carry a brick. 4.8★ from 1,200+ trails.\n\n$15 off your first order.",
        cta: "Shop the Cascade Shell",
        destinationUrl: `${STORE}/products/cascade-rain-shell`,
        audience: "Hikers & trail runners 25–45 in cold, wet climates, in-market for technical outerwear",
      },
    },
  ];

  // ── Run 2 — OKAY — Basecamp Water Bottle ────────────────────────────────
  const bottleSpend = 50_000;
  const bottleCard = buildScoreCard({
    assumedSpendCents: bottleSpend,
    calib: calibInputs({ mappedSku: bottle ? "Basecamp Water Bottle 750ml" : null, skuPriceCents: bottle?.priceCents ?? null }),
    summary:
      "A clean, on-brand bottle ad that reads fine but blends in — a weak hook, no offer, and zero social proof keep it average.",
    tips: [
      "Lead with the one number that sells a bottle: '24 hours cold' belongs in the headline, not buried in line two.",
      "Add a star rating or review count — at a $24 price point, social proof is the cheapest conversion lift available.",
      "Replace 'all ages' with a real segment (gym-goers, day-hikers, commuters) and mirror that in the copy.",
    ],
    dims: {
      hook_strength: { score: 52, reasoning: "'Stay hydrated on every adventure' is a category-generic opener that doesn't differentiate this bottle from any other." },
      visual_focal_clarity: { score: 55, reasoning: "No image supplied; a bottle is a visual-first product, so the missing hero shot caps this hard." },
      brand_presence: { score: 58, reasoning: "Brand name is present in copy, but with no image there's no visual identity to recall." },
      headline_clarity: { score: 70, reasoning: "Clear what it is, but leads with a benefit every bottle claims rather than this one's edge." },
      copy_concision: { score: 72, reasoning: "Compact and readable, though it spends words on generic durability claims." },
      readability_tone: { score: 68, reasoning: "Tone is fine but flat — nothing about it is memorable or distinctly on-brand." },
      offer_strength: { score: 48, reasoning: "No incentive, urgency, or reason to buy now — 'grab yours today' is filler, not an offer." },
      creative_offer_fit: { score: 64, reasoning: "Copy and destination align on the product, but with no offer there's little to fit together." },
      cta_strength: { score: 50, reasoning: "Generic 'Shop now' with no specificity or motivation." },
      audience_fit: { score: 55, reasoning: "'All ages' targeting is too broad to speak to anyone in particular." },
      social_proof: { score: 40, reasoning: "No reviews, ratings, or trust signals anywhere in the creative." },
      policy_risk: { score: 90, reasoning: "No restricted claims or compliance concerns." },
      text_in_image: { score: 60, reasoning: "No image to evaluate — neutral." },
    },
  });
  const bottleInput: CreativeInput = {
    imageUrl: null,
    headline: "Stay hydrated on every adventure",
    primaryText:
      "The Basecamp Water Bottle keeps drinks cold for 24 hours and hot for 12. Durable stainless steel built for the trail. Grab yours today.",
    cta: "Shop now",
    destinationUrl: `${STORE}/products/basecamp-water-bottle`,
    audience: "Outdoor enthusiasts, all ages",
  };

  // ── Run 3 — POOR — Summit Logo Tee ──────────────────────────────────────
  const teeSpend = 30_000;
  const teeCard = buildScoreCard({
    assumedSpendCents: teeSpend,
    calib: calibInputs({ mappedSku: tee ? "Summit Logo Tee — L" : null, skuPriceCents: tee?.priceCents ?? null }),
    summary:
      "A placeholder-grade ad: it announces a tee but gives no hook, no offer, no audience, and no proof — it would burn budget.",
    tips: [
      "Give the shirt a reason to exist in the ad: what's the fabric, the fit, the moment someone wears it? 'New' is not a selling point.",
      "Swap 'Learn more' for 'Shop now' — a $32 tee is an impulse buy, not a research purchase; don't add a click.",
      "Define an audience and write to it. Right now the ad targets everyone, which on Meta means it converts no one efficiently.",
    ],
    dims: {
      hook_strength: { score: 25, reasoning: "'New [product name]' is a label, not a hook — nothing here interrupts a scroll." },
      visual_focal_clarity: { score: 30, reasoning: "No image, and for a logo tee the visual IS the product; without it there's almost nothing to evaluate." },
      brand_presence: { score: 45, reasoning: "'Summit Logo' implies branding, but no logo or visual identity is actually shown." },
      headline_clarity: { score: 55, reasoning: "Clear that it's a new tee, but communicates zero value beyond novelty." },
      copy_concision: { score: 60, reasoning: "Short, but says nothing — concision without substance." },
      readability_tone: { score: 50, reasoning: "Tone is neutral to the point of being forgettable." },
      offer_strength: { score: 20, reasoning: "No offer, price advantage, or reason to act; 'available now' is not a benefit." },
      creative_offer_fit: { score: 35, reasoning: "With no offer and no creative angle, there's little fit to assess." },
      cta_strength: { score: 30, reasoning: "'Learn more' on a simple tee signals low intent and adds a click before purchase." },
      audience_fit: { score: 25, reasoning: "No audience is defined at all — the ad targets no one in particular." },
      social_proof: { score: 20, reasoning: "No reviews, ratings, or trust signals." },
      policy_risk: { score: 85, reasoning: "No policy concerns, though a thin creative like this risks low delivery." },
      text_in_image: { score: 50, reasoning: "No image to evaluate — neutral." },
    },
  });
  const teeInput: CreativeInput = {
    imageUrl: null,
    headline: "New Summit Logo Tee",
    primaryText: "Check out our brand new tee. Available now in all sizes.",
    cta: "Learn more",
    destinationUrl: `${STORE}/products/summit-logo-tee`,
    audience: "",
  };

  // ── Run 4 — OKAY (strong, profitable) — Crestline Pack ──────────────────
  const packSpend = 60_000;
  const packCard = buildScoreCard({
    assumedSpendCents: packSpend,
    calib: calibInputs({ mappedSku: pack ? "Crestline Pack 28L" : null, skuPriceCents: pack?.priceCents ?? null }),
    summary:
      "A strong, offer-led concept that nearly grades winning — a hero visual and a tighter feature list are the last 10%.",
    tips: [
      "Cut the feature list to your two strongest (weatherproof zippers + laptop sleeve) and lead the visual with the pack on a real back.",
      "You're one good hero image away from a winning grade — the copy and offer are already there.",
      "Test the 'summit to commute' angle as the headline against a benefit-first variant; the duality is your strongest differentiator.",
    ],
    dims: {
      hook_strength: { score: 70, reasoning: "The 'summit to commute' duality is a real positioning hook, though it opens slightly slower than your top performers." },
      visual_focal_clarity: { score: 56, reasoning: "No image; a pack is a strongly visual product and the missing hero shot caps the attention scores." },
      brand_presence: { score: 62, reasoning: "Brand carried by the product name only — no visual identity without an image." },
      headline_clarity: { score: 78, reasoning: "Immediately clear what it is and the capacity, with a positioning angle baked in." },
      copy_concision: { score: 72, reasoning: "Feature list is strong but runs slightly long; trimming to the two best features would sharpen it." },
      readability_tone: { score: 80, reasoning: "Energetic, benefit-led tone that fits the urban-outdoor crossover buyer." },
      offer_strength: { score: 76, reasoning: "The free packing-cube-with-purchase plus 'this week only' is a genuine, time-boxed incentive." },
      creative_offer_fit: { score: 78, reasoning: "The offer and the product page line up cleanly on a single SKU." },
      cta_strength: { score: 80, reasoning: "Specific, branded CTA ('Get the Crestline Pack')." },
      audience_fit: { score: 74, reasoning: "Clearly targets the urban-outdoor crossover buyer the copy describes." },
      social_proof: { score: 72, reasoning: "4.7★ from 800+ adventurers is concrete and credible." },
      policy_risk: { score: 90, reasoning: "No restricted claims or compliance concerns." },
      text_in_image: { score: 58, reasoning: "No image to evaluate — neutral." },
    },
  });
  const packInput: CreativeInput = {
    imageUrl: null,
    headline: "Your 28L do-everything daypack",
    primaryText:
      "From summit pushes to city commutes, the Crestline Pack 28L carries it all — weatherproof zippers, a padded laptop sleeve, and a frame that disappears on your back. Rated 4.7★ by 800+ adventurers.\n\nThis week only: a free packing cube with every order.",
    cta: "Get the Crestline Pack",
    destinationUrl: `${STORE}/products/crestline-pack-28l`,
    audience: "Commuters & weekend hikers 22–40, urban + outdoor crossover",
  };

  // Newest first. Spacing keeps a stable created_at order: the winner is latest
  // and renders on page load; the rest fill the history list.
  const runs: Array<{
    minutesAgo: number;
    durationSec: number;
    input: CreativeInput;
    card: ScoreCard;
    mappedSkuId: string | null;
    assumedSpendCents: number;
    variants: Variant[];
  }> = [
    { minutesAgo: 24, durationSec: 27, input: cascadeInput, card: cascadeCard, mappedSkuId: cascade?.id ?? null, assumedSpendCents: cascadeSpend, variants: cascadeVariants },
    { minutesAgo: 182, durationSec: 26, input: packInput, card: packCard, mappedSkuId: pack?.id ?? null, assumedSpendCents: packSpend, variants: [] },
    { minutesAgo: 1_470, durationSec: 25, input: bottleInput, card: bottleCard, mappedSkuId: bottle?.id ?? null, assumedSpendCents: bottleSpend, variants: [] },
    { minutesAgo: 2_930, durationSec: 24, input: teeInput, card: teeCard, mappedSkuId: tee?.id ?? null, assumedSpendCents: teeSpend, variants: [] },
  ];

  return runs.map((r) => {
    const createdMs = nowMs - r.minutesAgo * MIN;
    return {
      shop_id: shopId,
      status: "done",
      source: "manual",
      meta_ad_id: null,
      mapped_sku_id: r.mappedSkuId,
      assumed_spend_cents: r.assumedSpendCents,
      scorecard: r.card,
      creative_input: r.input,
      variants: r.variants,
      created_at: iso(createdMs),
      completed_at: iso(createdMs + r.durationSec * 1000),
    };
  });
}

/** Titles the builder grounds runs in; the runner resolves these from sku_dim. */
export const SCREENER_SEED_SKU_TITLES = [
  "Cascade Rain Shell — M",
  "Crestline Pack 28L",
  "Basecamp Water Bottle 750ml",
  "Summit Logo Tee — L",
] as const;
