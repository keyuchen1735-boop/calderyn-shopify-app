// app/lib/social-digest/pack.server.ts
//
// Turns a week of GitHub activity into the marketing copy for the carousels.
// The model only writes PROSE (headlines, support lines, captions). All NUMBERS
// (things shipped, waitlist delta, date range) are injected deterministically by
// this module so the slides can never state a figure the data doesn't support
// (rule 12). If the AI key is missing or the call/parse fails, a deterministic
// template fills the copy from the merged-PR titles — the pack never degrades to
// nothing.

import type { Activity } from "../github-digest/collect.server";
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import type { SocialPack, PackFeature } from "./slides.server";

const ILLUSTRATIVE_PERCENTILE = "68th";

export interface PackInput {
  activity: Activity;
  range: string; // "June 13–19, 2026"
  shippedCount: number; // deterministic (merged PRs)
  waitlistDelta: number; // deterministic (new signups this week)
  variation?: {
    reasons: string[]; // reason-chip strings from the reject (e.g. "tone too salesy")
    note?: string; // optional free-text from the rejecter
    priorCopy?: string[]; // copy strings from previously-rejected versions
  };
}

/**
 * Returns a plain-text instruction block for the AI when this is a regeneration
 * (i.e. a prior version was rejected). Returns "" when variation is absent or
 * carries no meaningful content — so the caller can always safely append it.
 */
export function variationInstruction(variation: PackInput["variation"]): string {
  if (!variation || variation.reasons.length === 0) return "";

  const lines: string[] = [
    "REGENERATION NOTE: The previous version of this post was rejected and must NOT be reused.",
    `Rejection reasons: ${variation.reasons.join("; ")}.`,
  ];

  if (variation.note) {
    lines.push(`Rejecter note: ${variation.note}`);
  }

  if (variation.priorCopy && variation.priorCopy.length > 0) {
    lines.push(
      "Do NOT reuse any of the following rejected copy:",
      ...variation.priorCopy.map((s) => `  - ${s}`),
    );
  }

  lines.push("Take a clearly different angle and tone from the rejected version.");

  return lines.join("\n");
}

interface AiCopy {
  liHook: string;
  liFeatures: [PackFeature, PackFeature];
  igCoverA: string;
  igCoverHi: string;
  igCoverB: string;
  igBigLabel: string;
  igFeature: PackFeature;
  linkedinCaption: string;
  instagramCaption: string;
}

const SYSTEM_PROMPT = [
  "You write weekly social posts for Calderyn, a Shopify app that watches inventory + ads and protects merchant margin.",
  "Voice: calm, plain-English operator. Anti-jargon, anti-hype, never salesy, no emoji except at most one in the Instagram caption.",
  "You are given this week's shipped work (merged pull request titles + commit subjects). Translate the engineering into MERCHANT-FACING benefits — what a store owner gets, never the implementation.",
  "Respond with ONLY a JSON object (no markdown, no code fences) of EXACTLY this shape:",
  '{"liHook":string,"liFeatures":[{"title":string,"support":string,"metric":string},{"title":string,"support":string,"metric":string}],"igCoverA":string,"igCoverHi":string,"igCoverB":string,"igBigLabel":string,"igFeature":{"title":string,"support":string,"metric":string},"linkedinCaption":string,"instagramCaption":string}',
  "Rules: liHook is a punchy second cover line (<=8 words). Each feature title reads like a chart title (<=9 words); support is ONE short sentence; metric is a tiny proof/label (<=6 words, no invented dollar amounts).",
  "igCoverA + igCoverHi + igCoverB form one short question, e.g. 'Is your store' / 'actually' / 'doing well?'. igBigLabel is one sentence that follows a percentile figure about peer benchmarks.",
  "Captions: 3-5 short lines each, end with 'calderyncompany.com', then a few relevant hashtags (#Shopify #DTC #Ecommerce ...). Do NOT state specific counts of features or signups — those are added separately.",
  "Pick the 2-3 most merchant-relevant items; ignore refactors/tests/CI/chores. Output JSON only.",
].join(" ");

function activityForPrompt(a: Activity): string {
  const prs = a.mergedPRs.slice(0, 25).map((p) => `- ${p.title}`);
  const commits = a.commits
    .slice(0, 40)
    .map((c) => `- ${c.subject}`)
    .filter((l) => !/^- (chore|test|ci|docs|refactor|merge)/i.test(l));
  return [
    "Merged pull requests this week:",
    ...(prs.length ? prs : ["(none)"]),
    "",
    "Notable commit subjects:",
    ...(commits.length ? commits.slice(0, 30) : ["(none)"]),
  ].join("\n");
}

function asFeature(v: unknown): PackFeature | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.title !== "string" || typeof o.support !== "string" || typeof o.metric !== "string") return null;
  return { title: o.title, support: o.support, metric: o.metric };
}

function parseAi(raw: string): AiCopy | null {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const f0 = Array.isArray(o.liFeatures) ? asFeature(o.liFeatures[0]) : null;
  const f1 = Array.isArray(o.liFeatures) ? asFeature(o.liFeatures[1]) : null;
  const igf = asFeature(o.igFeature);
  const strs = ["liHook", "igCoverA", "igCoverHi", "igCoverB", "igBigLabel", "linkedinCaption", "instagramCaption"];
  if (!f0 || !f1 || !igf || strs.some((k) => typeof o[k] !== "string")) return null;
  return {
    liHook: o.liHook as string,
    liFeatures: [f0, f1],
    igCoverA: o.igCoverA as string,
    igCoverHi: o.igCoverHi as string,
    igCoverB: o.igCoverB as string,
    igBigLabel: o.igBigLabel as string,
    igFeature: igf,
    linkedinCaption: o.linkedinCaption as string,
    instagramCaption: o.instagramCaption as string,
  };
}

// Best-effort cleanup of a PR title into a merchant-ish line for the fallback.
function tidyTitle(t: string): string {
  const stripped = t.replace(/^(feat|fix|chore|refactor|docs|test|perf)(\([^)]*\))?:\s*/i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function fallbackCopy(a: Activity): AiCopy {
  const picks = a.mergedPRs.slice(0, 3).map((p) => tidyTitle(p.title));
  const feat = (i: number): PackFeature => ({
    title: picks[i] ?? "New this week",
    support: "Shipped this week as part of Calderyn's inventory + ads guardrails.",
    metric: "New this week",
  });
  const cap = [
    "Heads-down week of building Calderyn.",
    picks.length ? `Shipped: ${picks.join("; ")}.` : "More guardrails for your inventory and ad spend.",
    "Join the waitlist → calderyncompany.com",
    "#Shopify #DTC #Ecommerce #ShopifyMerchants #BuildInPublic",
  ].join("\n\n");
  return {
    liHook: "Here's what's new.",
    liFeatures: [feat(0), feat(1)],
    igCoverA: "Is your store",
    igCoverHi: "actually",
    igCoverB: "doing well?",
    igBigLabel: "percentile in your niche — we shipped peer benchmarks so you finally know.",
    igFeature: feat(0),
    linkedinCaption: cap,
    instagramCaption: cap,
  };
}

export async function buildSocialPack(input: PackInput): Promise<{ pack: SocialPack; mode: "ai" | "template" }> {
  let copy: AiCopy | null = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const client = getAnthropic();
      const baseContent = activityForPrompt(input.activity);
      const variationBlock = variationInstruction(input.variation);
      const userContent = variationBlock ? `${baseContent}\n\n${variationBlock}` : baseContent;
      // Raise temperature only when an actual regeneration directive is present
      // (empty reasons → no directive → keep the steadier first-gen temperature).
      const temperature = variationBlock ? 1 : 0.7;
      // No prompt caching: SYSTEM_PROMPT is ~300 tokens, below the model's
      // 2048-token minimum cacheable prefix, so cache_control would be a no-op.
      // This also runs ~weekly and regeneration is human-paced, so no two calls
      // re-send the same prefix inside the 5-minute cache TTL.
      const msg = await client.messages.create({
        model: assistantModel(),
        max_tokens: 1400,
        temperature,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      copy = parseAi(text);
    } catch {
      copy = null;
    }
  }
  const mode = copy ? "ai" : "template";
  const c = copy ?? fallbackCopy(input.activity);

  const shipped =
    input.shippedCount > 0
      ? `We shipped ${input.shippedCount} thing${input.shippedCount === 1 ? "" : "s"} this week.`
      : "A quieter week of building.";
  const ctaLi =
    input.waitlistDelta > 0
      ? `${input.waitlistDelta} store owner${input.waitlistDelta === 1 ? "" : "s"} joined the waitlist this week.`
      : "We're building this in the open.";

  const pack: SocialPack = {
    range: input.range,
    shippedCount: input.shippedCount,
    waitlistDelta: input.waitlistDelta,
    linkedin: {
      coverA: shipped,
      coverB: c.liHook,
      features: c.liFeatures,
      ctaHeadline: ctaLi,
    },
    instagram: {
      coverA: c.igCoverA,
      coverHi: c.igCoverHi,
      coverB: c.igCoverB,
      bigNum: ILLUSTRATIVE_PERCENTILE,
      bigLabel: c.igBigLabel,
      feature: c.igFeature,
      ctaHeadline: "Built this week. Building in the open.",
    },
    linkedinCaption: c.linkedinCaption,
    instagramCaption: c.instagramCaption,
  };
  return { pack, mode };
}
