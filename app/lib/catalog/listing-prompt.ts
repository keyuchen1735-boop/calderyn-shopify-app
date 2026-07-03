// app/lib/catalog/listing-prompt.ts
//
// Prompt → listing-edit contract + planner for the AI new-product flow. Pure
// and client-safe. Deterministic first: the known intents below parse locally
// (instant, no API spend). Anything the parser can't place goes to
// /dashboard/api/listing-draft, whose Claude call emits the SAME op contract —
// the applying UI is engine-agnostic. This module owns the whole wire shape
// (ops, plan, and the ListingDraftCurrent request context) so the client and
// the route can't drift.

import { seedFromString } from "~/lib/seed/rng";

export type ListingOp =
  | { op: "set_title"; title: string }
  | { op: "set_price"; priceCents: number }
  | { op: "scale_price"; factor: number }
  | { op: "set_stock"; stock: number }
  | { op: "set_description"; description: string }
  | { op: "set_tags"; tags: string[] }
  | { op: "add_option"; name: string; values: string[] }
  | { op: "set_shipping"; weightGrams: number; lengthMm: number; widthMm: number; heightMm: number }
  | { op: "set_status"; status: "draft" | "active" };

export interface ListingPlan {
  ops: ListingOp[];
  summaries: string[];
}

/** Listing state sent with a prompt so the draft engine edits in context —
 *  the request body's `current` field, shared by client and route. */
export interface ListingDraftCurrent {
  title: string;
  price_cents: number | null;
  stock: number | null;
  description: string;
  tags: string[];
  options: Array<{ name: string; values: string[] }>;
  status: "draft" | "active";
  has_shipping: boolean;
}

/** What the local planner knows about the listing being edited. */
export interface ListingContext {
  title: string;
  /** Current base price, so relative moves ("make it cheaper") only fire when
   *  there is a price to move. */
  priceCents: number | null;
  /** True when shipping data is already filled — the deterministic estimator
   *  must never overwrite real numbers (that's the AI's call). */
  hasShipping: boolean;
}

export function titleCaseWords(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Buyer-facing description templates, deterministic by seed. */
export function descriptionFor(title: string, seed: number): string {
  const t = title.trim() || "This piece";
  const variants = [
    `${t} — made for everyday use and built to last. Clean finish, dependable materials, and the details buyers ask about covered up front. Ships fast from your store, easy returns.`,
    `Meet ${t.toLowerCase().startsWith("the ") ? t.toLowerCase() : "the " + t.toLowerCase()}: the one buyers keep coming back for. Comfortable, durable, and true to size, with a finish that holds up.`,
    `${t}, done right. Premium feel without the premium markup — small-batch quality, quick dispatch, and easy returns your customers will notice.`,
  ];
  return variants[seed % variants.length];
}

const COLOR_WORDS = [
  "black", "white", "navy", "red", "blue", "green", "grey", "gray",
  "beige", "pink", "olive", "brown", "cream",
];

/** Fallback full draft when the AI endpoint is unreachable: deterministic,
 *  honest-but-basic values derived from the prompt. */
export function draftPlanFromPrompt(prompt: string): ListingPlan {
  const clean = prompt.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  const hash = seedFromString(clean);
  const title = titleCaseWords(clean).slice(0, 70);
  const words = clean.toLowerCase().split(" ").filter((w) => w.length > 3);
  return {
    ops: [
      { op: "set_title", title },
      { op: "set_price", priceCents: (18 + (hash % 46)) * 100 },
      { op: "set_stock", stock: 10 + (hash % 40) },
      { op: "set_description", description: descriptionFor(title, hash) },
      { op: "set_tags", tags: Array.from(new Set(words)).slice(0, 4) },
    ],
    summaries: ["Drafted the listing"],
  };
}

/** First number in the text that is not a percentage ("10%" is a relative
 *  move, not an amount). */
function firstPlainNumber(low: string): number | null {
  for (const m of low.matchAll(/(\d+(?:\.\d{1,2})?)(\s*%)?/g)) {
    if (!m[2]) return Number(m[1]);
  }
  return null;
}

/** Deterministic edit parser. Returns an empty plan when nothing matched —
 *  the caller then escalates to the AI endpoint. */
export function parseListingPrompt(prompt: string, ctx: ListingContext): ListingPlan {
  const low = prompt.toLowerCase();
  const ops: ListingOp[] = [];
  const summaries: string[] = [];

  if (/\bsizes?\b/.test(low)) {
    const many = /bunch|lots|many|all|full|every/.test(low);
    const sizes = many ? ["XS", "S", "M", "L", "XL", "2XL"] : ["S", "M", "L"];
    ops.push({ op: "add_option", name: "Size", values: sizes });
    summaries.push(`Added sizes ${sizes[0]}–${sizes[sizes.length - 1]}`);
  }

  if (/\bcolou?rs?\b/.test(low)) {
    const named = COLOR_WORDS.filter((c) => low.includes(c));
    const colors = (named.length ? named : ["black", "white", "navy"]).map(titleCaseWords);
    ops.push({ op: "add_option", name: "Color", values: colors });
    summaries.push(`Added colors ${colors.join(", ")}`);
  }

  // The lazy capture stops at a following clause ("call it midnight tee and
  // set the price…") instead of swallowing the rest of the sentence.
  const rename = low.match(/(?:call it|rename (?:it )?to|retitle (?:it )?to)\s+(.{2,60}?)(?=\s+and\s+|[.!?]|$)/);
  if (rename) {
    const t = titleCaseWords(rename[1].trim().replace(/["'.]+$/g, "").replace(/^["']+/g, ""));
    ops.push({ op: "set_title", title: t });
    summaries.push(`Renamed to “${t}”`);
  }

  // Price intents, in precedence order: an explicit $ amount wins; then
  // relative moves (which need an existing price); then a bare number next to
  // a price word — but never a percentage, which is relative by definition.
  const dollar = low.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  if (dollar) {
    const cents = Math.round(Number(dollar[1]) * 100);
    ops.push({ op: "set_price", priceCents: cents });
    summaries.push(`Set price to $${(cents / 100).toFixed(2)}`);
  } else if (/cheaper|lower the price|discount/.test(low)) {
    if (ctx.priceCents && ctx.priceCents > 0) {
      ops.push({ op: "scale_price", factor: 0.85 });
      summaries.push("Lowered the price ~15%");
    }
  } else if (/premium|more expensive|raise the price|luxury/.test(low)) {
    if (ctx.priceCents && ctx.priceCents > 0) {
      ops.push({ op: "scale_price", factor: 1.25 });
      summaries.push("Raised the price ~25%");
    }
  } else if (/\b(price|cost|charge)\b/.test(low)) {
    const n = firstPlainNumber(low);
    if (n !== null && n > 0) {
      const cents = Math.round(n * 100);
      ops.push({ op: "set_price", priceCents: cents });
      summaries.push(`Set price to $${(cents / 100).toFixed(2)}`);
    }
  }

  if (/\b(stock|inventory)\b/.test(low)) {
    // The count must sit next to the stock word — "charge $30 and stock 100"
    // must not read the 30.
    const m = low.match(/(?:stock|inventory)\D{0,10}?(\d+)/) || low.match(/(\d+)\s*(?:in\s+)?stock/);
    if (m) {
      ops.push({ op: "set_stock", stock: Number(m[1]) });
      summaries.push(`Set stock to ${m[1]}`);
    }
  }

  if (/description|describe|rewrite|copy|wording/.test(low)) {
    ops.push({ op: "set_description", description: descriptionFor(ctx.title, seedFromString(prompt)) });
    summaries.push("Rewrote the description");
  }

  if (/\btags?\b/.test(low)) {
    const words = low
      .split(/\s+/)
      .filter((w) => w.length > 3 && !/tags?|make|with|have|bunch|please/.test(w));
    if (words.length) {
      ops.push({ op: "set_tags", tags: Array.from(new Set(words)).slice(0, 5) });
      summaries.push("Updated tags");
    }
  }

  // Estimate shipping only when none is recorded — never overwrite real
  // numbers with derived ones (rephrase-y prompts fall through to the AI).
  if (!ctx.hasShipping && /weight|shipping|dimensions|box size/.test(low)) {
    const h = seedFromString(prompt);
    ops.push({
      op: "set_shipping",
      weightGrams: 150 + (h % 400),
      lengthMm: 250 + (h % 120),
      widthMm: 180 + (h % 90),
      heightMm: 20 + (h % 60),
    });
    summaries.push("Estimated shipping size & weight");
  }

  if (/publish|go live|put it on sale|make it active|sell it now/.test(low)) {
    ops.push({ op: "set_status", status: "active" });
    summaries.push("Will go live on save");
  } else if (/keep it (as a )?draft|as a draft|unpublish/.test(low)) {
    ops.push({ op: "set_status", status: "draft" });
    summaries.push("Kept as a draft");
  }

  return { ops, summaries };
}

// ---------- validation (shared by the API route for Claude output) ----------

const MAX_PRICE_CENTS = 10_000_000; // $100k cap — beyond this it's model noise
const MAX_STOCK = 1_000_000;
const MAX_MM = 10_000;
const MAX_GRAMS = 1_000_000;

/** Trimmed non-empty string within max length, else null. */
export function cleanString(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const s = x.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/** Non-negative integer within max, else null. */
export function cleanInt(x: unknown, max: number): number | null {
  const n = typeof x === "number" ? x : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= 0 && i <= max ? i : null;
}

function sanitizeOp(x: unknown): ListingOp | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  switch (o.op) {
    case "set_title": {
      const title = cleanString(o.title, 120);
      return title ? { op: "set_title", title: title.slice(0, 70) } : null;
    }
    case "set_price": {
      const priceCents = cleanInt(o.priceCents, MAX_PRICE_CENTS);
      return priceCents !== null && priceCents > 0 ? { op: "set_price", priceCents } : null;
    }
    case "scale_price": {
      const f = typeof o.factor === "number" ? o.factor : NaN;
      return Number.isFinite(f) && f >= 0.1 && f <= 10 ? { op: "scale_price", factor: f } : null;
    }
    case "set_stock": {
      const stock = cleanInt(o.stock, MAX_STOCK);
      return stock !== null ? { op: "set_stock", stock } : null;
    }
    case "set_description": {
      const description = cleanString(o.description, 2000);
      return description ? { op: "set_description", description } : null;
    }
    case "set_tags": {
      if (!Array.isArray(o.tags)) return null;
      const tags = o.tags
        .map((t) => cleanString(t, 40))
        .filter((t): t is string => t !== null)
        .slice(0, 8);
      return tags.length ? { op: "set_tags", tags } : null;
    }
    case "add_option": {
      const name = cleanString(o.name, 30);
      if (!name || !Array.isArray(o.values)) return null;
      const values = o.values
        .map((v) => cleanString(v, 40))
        .filter((v): v is string => v !== null)
        .slice(0, 20);
      return values.length ? { op: "add_option", name, values } : null;
    }
    case "set_shipping": {
      const weightGrams = cleanInt(o.weightGrams, MAX_GRAMS);
      const lengthMm = cleanInt(o.lengthMm, MAX_MM);
      const widthMm = cleanInt(o.widthMm, MAX_MM);
      const heightMm = cleanInt(o.heightMm, MAX_MM);
      if (weightGrams === null || lengthMm === null || widthMm === null || heightMm === null) return null;
      if (weightGrams === 0 || lengthMm === 0 || widthMm === 0 || heightMm === 0) return null;
      return { op: "set_shipping", weightGrams, lengthMm, widthMm, heightMm };
    }
    case "set_status":
      return o.status === "draft" || o.status === "active" ? { op: "set_status", status: o.status } : null;
    default:
      return null;
  }
}

/** Validate + clamp an untrusted plan (Claude output). Null when nothing
 *  usable survives — callers treat that as a failed draft, never a silent one.
 *  Summaries are positional receipts for the ops; when any op is dropped the
 *  correspondence is broken, so they collapse to a generic receipt rather than
 *  claiming changes that never landed. */
export function sanitizePlan(x: unknown): ListingPlan | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (!Array.isArray(o.ops)) return null;
  const ops = o.ops.map(sanitizeOp).filter((op): op is ListingOp => op !== null).slice(0, 12);
  if (!ops.length) return null;
  const intact = ops.length === o.ops.length;
  const summaries =
    intact && Array.isArray(o.summaries)
      ? o.summaries.map((s) => cleanString(s, 90)).filter((s): s is string => s !== null).slice(0, 12)
      : [];
  return { ops, summaries: summaries.length ? summaries : ["Applied your change"] };
}
