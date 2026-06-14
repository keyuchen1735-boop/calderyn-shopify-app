// SIMULATED demo data — TODO(other-agent): replace with live predictor/generator API.
// Ported verbatim from the prototype's data.js (SCORECARD / GENERATOR / GROUP_LABELS).
// These feed the Creative Predictor and Ad Generator screens, which are simulated
// locally; their real backend is owned by another agent.
import type { Scorecard, Generator } from "./view-models";

// Ad creative predictor — sample scorecard (Summit Tee static ad).
export const SCORECARD: Scorecard = {
  ad_name: "Static — Summit Tee flat lay",
  composite: 58,
  grade: "okay",
  confidence: "medium",
  summary:
    "Clean product shot with a clear headline, but the hook is weak for cold traffic and the offer is generic. Strongest fix: lead with the creator UGC angle that's already winning engagement, and give the CTA a concrete reason to click now.",
  outcomes: {
    estimatedRoas: 1.9,
    roasLow: 1.2,
    roasHigh: 2.6,
    breakEvenRoas: 1.7,
    predictedCtr: 0.011,
    holdRate: 0.042,
    assumedSpendCents: 50000,
    predictedRevenueCents: 95000,
    mappedSku: "Summit Logo Tee",
    skuPriceCents: 3200,
  },
  metrics: [
    {
      id: "hook_strength",
      group: "attention",
      label: "Hook strength",
      score: 41,
      reasoning: "Flat lay opens on product alone — nothing stops the scroll in the first 0.5s.",
    },
    {
      id: "visual_focal_clarity",
      group: "attention",
      label: "Visual focal clarity",
      score: 78,
      reasoning: "Single product, clean background, clear focal point.",
    },
    {
      id: "brand_presence",
      group: "attention",
      label: "Brand presence / recall",
      score: 62,
      reasoning: "Logo visible on the tee but no brand lockup in frame.",
    },
    {
      id: "headline_clarity",
      group: "message",
      label: "Headline clarity",
      score: 74,
      reasoning: "“The tee that survives the trail” is concrete and legible.",
    },
    {
      id: "copy_concision",
      group: "message",
      label: "Copy concision",
      score: 70,
      reasoning: "Primary text is two sentences; could cut the second.",
    },
    {
      id: "readability_tone",
      group: "message",
      label: "Readability / tone match",
      score: 68,
      reasoning: "Tone matches the brand's plainspoken outdoor voice.",
    },
    {
      id: "offer_strength",
      group: "offer_conversion",
      label: "Offer strength",
      score: 38,
      reasoning: "No offer beyond the product itself — full price, no urgency.",
    },
    {
      id: "creative_offer_fit",
      group: "offer_conversion",
      label: "Creative ↔ offer fit",
      score: 55,
      reasoning: "Creative shows the product but doesn't set up the destination page.",
    },
    {
      id: "cta_strength",
      group: "offer_conversion",
      label: "CTA strength",
      score: 47,
      reasoning: "Generic “Shop Now” — no reason to click today.",
    },
    {
      id: "audience_fit",
      group: "offer_conversion",
      label: "Audience / targeting fit",
      score: 66,
      reasoning: "Broad prospecting audience fits a hero product intro.",
    },
    {
      id: "social_proof",
      group: "trust_safety",
      label: "Social proof / trust signals",
      score: 33,
      reasoning:
        "No reviews, UGC, or wear-context — the account's UGC ads outperform 2.9×.",
    },
    {
      id: "policy_risk",
      group: "trust_safety",
      label: "Policy / compliance safety",
      score: 92,
      reasoning: "No claims or restricted content; clean.",
    },
    {
      id: "text_in_image",
      group: "trust_safety",
      label: "Text-in-image restraint",
      score: 88,
      reasoning: "Minimal text overlay, well under platform guidance.",
    },
  ],
  tips: [
    {
      title: "Lead with the JMT creator clip",
      detail:
        "Your hero frame is a flat-lay product shot, which scrolls past. Open on the “Three weeks on the JMT” UGC clip instead — your UGC ads hold 2.9× longer than statics, lifting hook strength and hold rate.",
    },
    {
      title: "Make the CTA an offer",
      detail:
        "“Shop Now” gives no reason to act today. Swap it for “Get trail-ready — free shipping over $75”, which pairs intent with a concrete incentive and lifts the offer/conversion score.",
    },
    {
      title: "Add a social-proof overlay",
      detail:
        "There’s no proof on the creative. Overlay one line — “4.8★ from 1,200+ hikers” — to raise trust and CTR without crowding the image.",
    },
  ],
  variants: [
    {
      mode: "copy",
      composite: 71,
      delta: 13,
      summary: "UGC-led rewrite with review proof and a concrete CTA.",
      headline: "1,200 hikers rated it 4.8★",
      cta: "Get trail-ready",
    },
    {
      mode: "image",
      composite: 66,
      delta: 8,
      summary: "Wear-context shot on trail replaces the flat lay.",
      headline: "The tee that survives the trail",
      cta: "Shop the Summit Tee",
    },
  ],
};

export const GROUP_LABELS: Record<string, string> = {
  attention: "Attention",
  message: "Message",
  offer_conversion: "Offer & Conversion",
  trust_safety: "Trust & Safety",
};

// Ad Generator — remake brief derived from the scorecard's weakest dimensions,
// plus the simulated Higgsfield outputs.
export const GENERATOR: Generator = {
  source_ad: "Static — Summit Tee flat lay",
  source_composite: 58,
  fixes: [
    { dim: "Hook strength", before: 41, fix: "Open on the creator's JMT clip — movement in the first 0.5s" },
    { dim: "Social proof", before: 33, fix: "Overlay “4.8★ from 1,200+ hikers” in the first frame" },
    { dim: "Offer strength", before: 38, fix: "Lead with free shipping over $75" },
    { dim: "CTA strength", before: 47, fix: "Replace “Shop Now” with “Get trail-ready”" },
  ],
  styles: ["Trail cinematic", "UGC handheld", "Studio product"],
  steps: [
    "Building brief from critique…",
    "Prompting Higgsfield (Soul · image-to-video)…",
    "Rendering 2 creatives…",
    "Applying brand kit…",
    "Re-scoring with predictor…",
  ],
  outputs: [
    {
      id: "gen-a",
      recommended: true,
      name: "UGC remake — JMT creator hook",
      format: "video",
      duration: "0:14",
      headline: "1,200 hikers rated it 4.8★",
      primaryText:
        "Three weeks on the John Muir Trail — one tee. Heavyweight organic cotton that holds up.",
      cta: "Get trail-ready",
      composite: 74,
      delta: 16,
      estRoas: 2.6,
      fixed: [
        ["Hook", 41, 78],
        ["Social proof", 33, 81],
        ["CTA", 47, 72],
      ],
    },
    {
      id: "gen-b",
      recommended: false,
      name: "Static remake — proof overlay",
      format: "static",
      duration: null,
      headline: "The tee that survives the trail",
      primaryText: "4.8★ from 1,200+ hikers. Free shipping over $75.",
      cta: "Shop the Summit Tee",
      composite: 69,
      delta: 11,
      estRoas: 2.3,
      fixed: [
        ["Social proof", 33, 76],
        ["Offer", 38, 70],
      ],
    },
  ],
};
