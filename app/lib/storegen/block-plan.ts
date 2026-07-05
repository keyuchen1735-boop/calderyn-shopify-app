// app/lib/storegen/block-plan.ts
// The locked contract Claude emits, plus tolerant parsers. A BlockPlan is a raw, PRE-validation
// list of block intents (full props + optional layout) — sanitize.ts + validateDocument turn it
// into a safe BlockDocument. Parsers never throw; they return null or drop malformed entries.
import type { GridCell } from "~/lib/storebuilder/types";
import type { StudioVibe } from "~/lib/storebuilder/studio-types";

export interface PlanBlock { type: string; props: Record<string, unknown>; layout?: Partial<GridCell> }
export interface BlockPlan { blocks: PlanBlock[] }
export interface BrandPlan {
  storeName: string;
  palette: { primary: string; background: string; text: string };
  voiceTagline: string;
  vibe: StudioVibe;
}

/** A tasteful, AA-contrast (text-on-background) hex triad the brand prompt offers BY NAME so the
 *  model picks one instead of inventing free hex (which reliably produces ugly/low-contrast
 *  stores). Keep additions tasteful + AA-checked; this list is embedded verbatim in the prompt. */
export interface NamedPalette { name: string; primary: string; background: string; text: string }

export const PALETTE_LIBRARY: readonly NamedPalette[] = [
  { name: "Evergreen", primary: "#0f766e", background: "#ffffff", text: "#111827" },
  { name: "Midnight", primary: "#1e3a8a", background: "#f8fafc", text: "#0f172a" },
  { name: "Terracotta", primary: "#c2410c", background: "#fffaf5", text: "#292524" },
  { name: "Clay", primary: "#9a3412", background: "#fdf6ec", text: "#2b1d12" },
  { name: "Rose", primary: "#be185d", background: "#fff1f5", text: "#3f1d2b" },
  { name: "Plum", primary: "#6d28d9", background: "#faf5ff", text: "#2e1065" },
  { name: "Ocean", primary: "#0369a1", background: "#f0f9ff", text: "#0c2d48" },
  { name: "Forest", primary: "#166534", background: "#f7fdf9", text: "#052e16" },
  { name: "Charcoal", primary: "#18181b", background: "#fafafa", text: "#18181b" },
  { name: "Sand", primary: "#a16207", background: "#fffdf5", text: "#3f2d0a" },
  { name: "Berry", primary: "#9f1239", background: "#fff5f6", text: "#3f0d17" },
  { name: "Slate", primary: "#334155", background: "#f8fafc", text: "#0f172a" },
];
const DEFAULT_PALETTE = PALETTE_LIBRARY[0]; // Evergreen — the pre-v2 hardcoded default, unchanged
const VIBES: readonly StudioVibe[] = ["minimal", "bold", "warm"];

function paletteByName(raw: unknown): NamedPalette | null {
  if (typeof raw !== "string") return null;
  const needle = raw.trim().toLowerCase();
  return PALETTE_LIBRARY.find((p) => p.name.toLowerCase() === needle) ?? null;
}

/** #rrggbb -> hue in [0,360), or null when unparseable. */
function hexHue(hex: unknown): number | null {
  if (typeof hex !== "string") return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return null; // achromatic (gray/black/white) — no hue to match on
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Snap a junk/free hex value to the nearest curated palette by primary hue, so an
 *  ugly/low-contrast model-invented color never reaches the storefront — only its hue survives,
 *  as a pick among already-tasteful options. Falls back to the default palette when the input
 *  hex is missing/unparseable (e.g. achromatic or absent entirely). */
function nearestPaletteByHue(primaryHex: unknown): NamedPalette {
  const hue = hexHue(primaryHex);
  if (hue == null) return DEFAULT_PALETTE;
  let best: NamedPalette = DEFAULT_PALETTE;
  let bestDist = Infinity;
  for (const p of PALETTE_LIBRARY) {
    const d = hueDistance(hue, hexHue(p.primary) ?? 0);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
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

export function parseBrandPlan(raw: string): BrandPlan | null {
  const p = asRecord(parseJson(raw));
  if (typeof p.storeName !== "string") return null;
  // The prompt asks the model to name a curated palette; tolerate a hallucinated/legacy free-hex
  // `palette` object too (nearest-by-hue keeps it tasteful either way) so an off-contract reply
  // still resolves to something AA-contrast rather than being discarded.
  const pal = asRecord(p.palette);
  const resolved = paletteByName(p.paletteName) ?? nearestPaletteByHue(pal.primary);
  const vibe = VIBES.includes(p.vibe as StudioVibe) ? (p.vibe as StudioVibe) : "minimal";
  // Enforce the prompt's length limits here: brand text is model output derived from
  // untrusted catalog text and flows on to saveStoreSettings/DB.
  return {
    storeName: p.storeName.slice(0, 60),
    palette: { primary: resolved.primary, background: resolved.background, text: resolved.text },
    voiceTagline: typeof p.voiceTagline === "string" ? p.voiceTagline.slice(0, 120) : "",
    vibe,
  };
}
