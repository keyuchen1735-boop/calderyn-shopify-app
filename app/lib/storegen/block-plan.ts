// app/lib/storegen/block-plan.ts
// The locked contract Claude emits, plus tolerant parsers. A BlockPlan is a raw, PRE-validation
// list of block intents (full props + optional layout) — sanitize.ts + validateDocument turn it
// into a safe BlockDocument. Parsers never throw; they return null or drop malformed entries.
import type { GridCell } from "~/lib/storebuilder/types";

export interface PlanBlock { type: string; props: Record<string, unknown>; layout?: Partial<GridCell> }
export interface BlockPlan { blocks: PlanBlock[] }
export interface BrandPlan {
  storeName: string;
  palette: { primary: string; background: string; text: string };
  voiceTagline: string;
}

function parseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { return null; }
}
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function parseBlockPlan(raw: string): BlockPlan | null {
  const parsed = asRecord(parseJson(raw));
  if (!Array.isArray(parsed.blocks)) return null;
  const blocks: PlanBlock[] = [];
  for (const entry of parsed.blocks) {
    const e = asRecord(entry);
    if (typeof e.type !== "string") continue;
    blocks.push({ type: e.type, props: asRecord(e.props), layout: (e.layout ? asRecord(e.layout) : undefined) as Partial<GridCell> | undefined });
  }
  return { blocks };
}

// Palette values flow into inline styles on the public storefront; anything
// that isn't strictly a hex color (e.g. a url(...) tracking pixel smuggled in
// via catalog-derived brand copy) falls back to the default.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

export function parseBrandPlan(raw: string): BrandPlan | null {
  const p = asRecord(parseJson(raw));
  if (typeof p.storeName !== "string") return null;
  const pal = asRecord(p.palette);
  const hex = (v: unknown, d: string) =>
    typeof v === "string" && HEX_COLOR_RE.test(v.trim()) ? v.trim() : d;
  // Enforce the prompt's length limits here: brand text is model output derived from
  // untrusted catalog text and flows on to saveStoreSettings/DB.
  return {
    storeName: p.storeName.slice(0, 60),
    palette: { primary: hex(pal.primary, "#0f766e"), background: hex(pal.background, "#ffffff"), text: hex(pal.text, "#111827") },
    voiceTagline: typeof p.voiceTagline === "string" ? p.voiceTagline.slice(0, 120) : "",
  };
}
