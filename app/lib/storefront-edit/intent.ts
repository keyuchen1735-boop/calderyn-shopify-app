import { isCuratedFontId, type CuratedFontId } from "../storefront-bundle/types";
import type { ParsedEditIntent, PreviewEditContext, StorefrontPatchOperation } from "./types";

const FONT_ALIASES: Readonly<Record<string, CuratedFontId>> = {
  "archivo narrow": "archivo-narrow",
  archivo: "archivo-narrow",
  atkinson: "atkinson-hyperlegible",
  fraunces: "fraunces",
  "ibm plex mono": "ibm-plex-mono",
  inter: "inter",
  "roboto slab": "roboto-slab",
  "source serif": "source-serif-4",
  "space grotesk": "space-grotesk",
};

const RESET_RE = /\b(?:start\s+over|rebuild\s+(?:the\s+)?(?:whole\s+)?store|redesign\s+(?:the\s+)?(?:whole|entire)\s+store|completely\s+new\s+store|new\s+store\s+from\s+scratch|entirely\s+original\s+(?:store|storefront|design)|replace\s+the\s+entire\s+store|(?:no\s+|without\s+(?:a\s+)?)template)\b/i;
const FRESH_BUILD_RE = /^make\s+(?:a\s+)?(?:new\s+)?(?:store|storefront)[.!]?$/i;
const NEGATED_RESET_RE = /\b(?:don't|do\s+not|never)\s+(?:start\s+over|rebuild|redesign|replace)\b/gi;
const STORE_WIDE_RE = /\b(?:entire\s+storefront|whole\s+(?:shop|storefront|design)|every\s+(?:page|route)|all\s+(?:pages|routes)|across\s+(?:the\s+)?(?:store|storefront|shop)|store[-\s]?wide|site[-\s]?wide|cohesive\s+(?:store|storefront|shop))\b/i;
const HEX_RE = /#([0-9a-f]{6})\b/i;

function normalizedFont(prompt: string): CuratedFontId | null {
  const lower = prompt.toLowerCase();
  for (const [alias, id] of Object.entries(FONT_ALIASES)) if (lower.includes(alias)) return id;
  const dashed = lower.match(/\b(?:font|typeface)\s+([a-z0-9-]+)\b/)?.[1];
  return dashed && isCuratedFontId(dashed) ? dashed : null;
}

/** Pure allowlisted parser. Anything not exactly understood becomes a scoped structural edit. */
export function parseEditIntent(prompt: string, context?: PreviewEditContext): ParsedEditIntent {
  const clean = prompt.trim();
  // Drop negated reset phrases ("don't rebuild", "never start over") before
  // testing so a negation elsewhere in the prompt cannot suppress a genuine
  // reset request ("Start over. Never rebuild it section by section.").
  const resettable = clean.replace(NEGATED_RESET_RE, " ");
  if (FRESH_BUILD_RE.test(clean)) return { kind: "startOver", mode: "auto" };
  if (RESET_RE.test(resettable)) return { kind: "startOver", mode: "custom" };

  const operations: StorefrontPatchOperation[] = [];
  const color = clean.match(HEX_RE)?.[0]?.toLowerCase();
  if (color) operations.push({ kind: "setToken", tokenId: /background|canvas/i.test(clean) ? "background" : "accent", value: color });

  const font = normalizedFont(clean);
  if (font) operations.push({ kind: "setFont", target: /body|paragraph|copy/i.test(clean) ? "body" : "display", fontId: font });

  const quoted = clean.match(/(?:headline|title|text|copy)[^"“”]*["“]([^"“”]{1,300})["”]/i)?.[1]?.trim();
  if (quoted && context) operations.push({ kind: "setText", routeId: context.routeId, targetId: context.regionId, value: quoted });

  if (/\b(?:hide|remove)\b/i.test(clean) && context) {
    operations.push({ kind: "setVisibility", routeId: context.routeId, targetId: context.regionId, hidden: true });
  } else if (/\b(?:show|restore)\b/i.test(clean) && context) {
    operations.push({ kind: "setVisibility", routeId: context.routeId, targetId: context.regionId, hidden: false });
  }

  const move = clean.match(/\bmove\b[\s\S]*\b(up|down|before|after)\b/i)?.[1]?.toLowerCase();
  if (move && context) {
    operations.push({
      kind: "moveRegion",
      routeId: context.routeId,
      targetId: context.regionId,
      direction: move === "up" || move === "before" ? "up" : "down",
    });
  }

  if (operations.length > 0) return { kind: "deterministic", operations };
  // An explicit whole-store instruction outranks a stale canvas selection.
  // Selection context is a precision hint, not a permanent editing prison.
  return context && !STORE_WIDE_RE.test(clean) ? { kind: "structural", context } : { kind: "structural" };
}
