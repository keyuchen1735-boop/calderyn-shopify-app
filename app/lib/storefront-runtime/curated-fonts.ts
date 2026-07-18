import type { CuratedFontId, StorefrontBundleV1, StoreTemplateId } from "~/lib/storefront-bundle/types";

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
export function storefrontDesignSystemCss(designSystem: StorefrontBundleV1["designSystem"], templateId?: StoreTemplateId): string {
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
  return [
    faces,
    `:where([data-cd-bundle-runtime]){${declarations};display:block;min-width:0;max-width:100%;overflow-x:clip;font-family:var(--font-body)}`,
    ":where([data-cd-bundle-runtime]),:where([data-cd-bundle-runtime]) *,:where([data-cd-bundle-runtime]) *::before,:where([data-cd-bundle-runtime]) *::after{box-sizing:border-box}",
    ":where([data-cd-bundle-runtime]) :where(header,footer,main,section,article,aside,nav,div,figure){min-width:0;max-width:100%}",
    ":where([data-cd-bundle-runtime]) :where(img,picture,video,canvas,svg){max-width:100%}",
    ":where([data-cd-bundle-runtime]) img{display:block;height:auto}",
    ":where([data-cd-bundle-runtime]) figure{margin:0}",
    ":where([data-cd-bundle-runtime]) :where(button,input,select,textarea){max-width:100%;font:inherit}",
    ":where([data-cd-bundle-runtime]) :where(p,a,button){overflow-wrap:anywhere}",
    ":where([data-cd-bundle-shell])>header,:where([data-cd-bundle-shell])>footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:4rem;padding:1rem}",
    "@media(max-width:720px){:where([data-cd-bundle-shell])>header,:where([data-cd-bundle-shell])>footer{align-items:flex-start;flex-wrap:wrap}}",
    // Trusted-slot hosts and their ancestors are compiler-protected, so recipes
    // cannot style their own quick-buy strips — layout for the two bare idioms
    // is runtime-owned. Idiom 1: a classless section wrapping repeated
    // classless items becomes a responsive strip grid. Idiom 2 (legacy): a
    // repeat cloned per-product into sibling sections, each holding a single
    // panel host, gets bounded instead of rendering as a raw full-width stack.
    ':where([data-cd-bundle-runtime]) :where(section:not([class])):has(>:where(div:not([class]))>:where([data-cd-trusted-slot="quickViewCommerce"][data-cd-host-size="panel"])){display:grid;grid-template-columns:repeat(auto-fill,minmax(16rem,1fr));gap:1rem;align-items:start;padding:1rem}',
    ':where([data-cd-bundle-runtime]) :where(section:not([class]))>:where(div:not([class])):has(>:where([data-cd-trusted-slot="quickViewCommerce"][data-cd-host-size="panel"])){min-width:0}',
    ':where([data-cd-bundle-runtime]) :where(section:not([class]))>:where([data-cd-trusted-slot="quickViewCommerce"][data-cd-host-size="panel"]:only-child){max-width:26rem;margin:0.35rem 1rem}',
    ...(templateId === "soft-chemistry" ? [
      ':where([data-cd-bundle-route="product"])>main:has(>section:not([class])>[data-cd-trusted-slot="variantPicker"]){position:relative}',
      ':where([data-cd-bundle-route="product"])>main>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:absolute;right:max(47px,calc((100% - 1090px)/2 + 47px));bottom:34px;display:grid;grid-template-columns:auto 1fr;gap:.5rem;width:min(450px,calc(48% - 68px));font-size:10px;text-transform:uppercase}',
      '@media(max-width:780px){:where([data-cd-bundle-route="product"])>main>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:static;width:auto;margin:0 34px 34px}}',
    ] : []),
  ].join("");
}
