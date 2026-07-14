import type { CuratedFontId, StorefrontBundleV1 } from "~/lib/storefront-bundle/types";

interface CuratedFontDefinition {
  family: string;
  fallback: string;
  weight: string;
}

export const CURATED_STOREFRONT_FONTS: Readonly<Record<CuratedFontId, CuratedFontDefinition>> = Object.freeze({
  "archivo-narrow": { family: "CD Archivo Narrow", fallback: "Arial Narrow, sans-serif", weight: "100 900" },
  "atkinson-hyperlegible": { family: "CD Atkinson Hyperlegible", fallback: "Arial, sans-serif", weight: "400" },
  fraunces: { family: "CD Fraunces", fallback: "Georgia, serif", weight: "100 900" },
  "ibm-plex-mono": { family: "CD IBM Plex Mono", fallback: "ui-monospace, monospace", weight: "400" },
  inter: { family: "CD Inter", fallback: "Arial, sans-serif", weight: "100 900" },
  "roboto-slab": { family: "CD Roboto Slab", fallback: "Georgia, serif", weight: "100 900" },
  "source-serif-4": { family: "CD Source Serif 4", fallback: "Georgia, serif", weight: "100 900" },
  "space-grotesk": { family: "CD Space Grotesk", fallback: "Arial, sans-serif", weight: "300 700" },
});

function safeTokenId(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeTokenValue(value: string): boolean {
  if (value.length === 0 || value.length > 240 || /[{};<>\r\n]/.test(value)) return false;
  // Token values are deliberately narrower than full CSS. Excluding quotes,
  // escapes, colons, and at-rules prevents encoded network-capable values.
  if (!/^[A-Za-z0-9_#%(),.+/* -]+$/.test(value)) return false;
  const normalized = value.toLowerCase();
  const scriptProtocol = ["java", "script:"].join("");
  return !/(?:url|image-set|cross-fade|element|expression|javascript|data)\s*\(/.test(normalized) &&
    !normalized.includes("@import") && !normalized.includes(scriptProtocol) && !normalized.includes("data:");
}

function fontFace(fontId: CuratedFontId): string {
  const definition = CURATED_STOREFRONT_FONTS[fontId];
  return `@font-face{font-family:${definition.family};src:url(/storefront-fonts/${fontId}-latin.woff2);font-style:normal;font-weight:${definition.weight};font-display:swap}`;
}

function fontStack(fontId: CuratedFontId): string {
  const definition = CURATED_STOREFRONT_FONTS[fontId];
  return `${definition.family},${definition.fallback}`;
}

/** Creates only closed, runtime-owned CSS from the already compiled design system. */
export function storefrontDesignSystemCss(designSystem: StorefrontBundleV1["designSystem"]): string {
  const fontIds = [...new Set([designSystem.displayFontId, designSystem.bodyFontId])];
  const faces = fontIds.map(fontFace).join("");
  const tokens = Object.entries(designSystem.tokens)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([id, value]) => {
      if (!safeTokenId(id) || !safeTokenValue(value)) throw new Error(`Unsafe storefront design token ${JSON.stringify(id)}`);
      return `--${id}:${value}`;
    });
  const declarations = [
    ...tokens,
    `--font-display:${fontStack(designSystem.displayFontId)}`,
    `--font-body:${fontStack(designSystem.bodyFontId)}`,
  ].join(";");
  return `${faces}:where([data-cd-bundle-runtime]){${declarations}}`;
}
