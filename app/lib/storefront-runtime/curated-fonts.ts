import type { CuratedFontId, StorefrontBundleV1, StoreTemplateId } from "~/lib/storefront-bundle/types";

interface CuratedFontDefinition {
  family: string;
  fallback: string;
  faces: readonly { file: string; style: "normal" | "italic"; weight: string }[];
}

const face = (file: string, weight: string, style: "normal" | "italic" = "normal") =>
  [{ file, style, weight }] as const;

export const CURATED_STOREFRONT_FONTS: Readonly<Record<CuratedFontId, CuratedFontDefinition>> = Object.freeze({
  "archivo-black": { family: "Archivo Black", fallback: "Arial Black, sans-serif", faces: face("archivo-black-400", "400") },
  "archivo-narrow": { family: "CD Archivo Narrow", fallback: "Arial Narrow, sans-serif", faces: face("archivo-narrow", "100 900") },
  "atkinson-hyperlegible": { family: "CD Atkinson Hyperlegible", fallback: "Arial, sans-serif", faces: face("atkinson-hyperlegible", "400") },
  "barlow-condensed": { family: "Barlow Condensed", fallback: "Arial Narrow, sans-serif", faces: [500, 600, 700, 800].map((weight) => ({ file: `barlow-condensed-${weight}`, style: "normal" as const, weight: String(weight) })) },
  "chakra-petch": { family: "Chakra Petch", fallback: "Arial, sans-serif", faces: [400, 500, 600, 700].map((weight) => ({ file: `chakra-petch-${weight}`, style: "normal" as const, weight: String(weight) })) },
  "cormorant-garamond": { family: "Cormorant Garamond", fallback: "Georgia, serif", faces: [
    ...[400, 500, 600].map((weight) => ({ file: `cormorant-garamond-${weight}`, style: "normal" as const, weight: String(weight) })),
    { file: "cormorant-garamond-500-italic", style: "italic", weight: "500" },
  ] },
  "dm-mono": { family: "DM Mono", fallback: "ui-monospace, monospace", faces: [300, 400, 500].map((weight) => ({ file: `dm-mono-${weight}`, style: "normal" as const, weight: String(weight) })) },
  fraunces: { family: "CD Fraunces", fallback: "Georgia, serif", faces: face("fraunces", "100 900") },
  "ibm-plex-mono": { family: "CD IBM Plex Mono", fallback: "ui-monospace, monospace", faces: face("ibm-plex-mono", "400") },
  inter: { family: "CD Inter", fallback: "Arial, sans-serif", faces: face("inter", "100 900") },
  manrope: { family: "Manrope", fallback: "Arial, sans-serif", faces: face("manrope", "400 700") },
  newsreader: { family: "Newsreader", fallback: "Georgia, serif", faces: face("newsreader", "400 600") },
  oswald: { family: "Oswald", fallback: "Arial Narrow, sans-serif", faces: face("oswald", "400 700") },
  "roboto-slab": { family: "CD Roboto Slab", fallback: "Georgia, serif", faces: face("roboto-slab", "100 900") },
  "source-fraunces": { family: "Fraunces", fallback: "Georgia, serif", faces: face("source-fraunces", "400 700") },
  "source-serif-4": { family: "CD Source Serif 4", fallback: "Georgia, serif", faces: face("source-serif-4", "100 900") },
  "space-grotesk": { family: "CD Space Grotesk", fallback: "Arial, sans-serif", faces: face("space-grotesk", "300 700") },
  syne: { family: "Syne", fallback: "Arial, sans-serif", faces: face("syne", "400 700") },
  "young-serif": { family: "Young Serif", fallback: "Georgia, serif", faces: face("young-serif-400", "400") },
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
  const family = definition.family.startsWith("CD ") ? definition.family : `'${definition.family}'`;
  return definition.faces.map(({ file, style, weight }) =>
    `@font-face{font-family:${family};src:url(/storefront-fonts/${file}-latin.woff2);font-style:${style};font-weight:${weight};font-display:swap}`,
  ).join("");
}

function fontStack(fontId: CuratedFontId): string {
  const definition = CURATED_STOREFRONT_FONTS[fontId];
  const family = definition.family.startsWith("CD ") ? definition.family : `'${definition.family}'`;
  return `${family},${definition.fallback}`;
}

/** Creates only closed, runtime-owned CSS from the already compiled design system. */
export function storefrontDesignSystemCss(designSystem: StorefrontBundleV1["designSystem"], templateId?: StoreTemplateId, templateVersion?: number): string {
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
    ...(templateId === "forge" && templateVersion !== undefined && templateVersion >= 4 ? [
      ':where([data-cd-bundle-route="product"])>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:sticky;bottom:0;z-index:72;display:grid;grid-template-columns:minmax(10rem,16rem) minmax(14rem,28rem);justify-content:end;gap:.75rem;padding:1rem clamp(1rem,3vw,3rem);border-block:1px solid var(--steel);background:var(--parchment);box-shadow:0 -12px 30px rgb(32 36 38/.14)}',
      ':where([data-cd-bundle-route="product"])>section:not([class])>[data-cd-trusted-slot="variantPicker"] select{width:100%;min-height:3.25rem;padding:.75rem;border:1px solid var(--steel);background:var(--parchment);color:var(--steel)}',
      ':where([data-cd-bundle-route="product"])>section:not([class])>[data-cd-trusted-slot="addToCart"]{display:grid;min-height:3.25rem;background:#a63a1e;color:#eceae3}',
      ':where([data-cd-bundle-route="product"])>section:not([class])>[data-cd-trusted-slot="addToCart"] form{display:grid;height:100%}',
      ':where([data-cd-bundle-route="product"])>section:not([class])>[data-cd-trusted-slot="addToCart"] :where(button,input[type="submit"]){width:100%!important;min-height:3.25rem!important;padding:.75rem 1.25rem!important;border:1px solid #a63a1e!important;background:#a63a1e!important;color:#eceae3!important;font-weight:700!important;text-transform:uppercase;cursor:pointer}',
      '@media(max-width:600px){:where([data-cd-bundle-route="product"])>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){grid-template-columns:1fr 1.35fr;padding:.75rem}}',
    ] : []),
    ...(templateId === "soft-chemistry" && templateVersion !== undefined && templateVersion < 6 ? [
      ':where([data-cd-bundle-route="product"])>main:has(>section:not([class])>[data-cd-trusted-slot="variantPicker"]){position:relative}',
      ':where([data-cd-bundle-route="product"])>main>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:absolute;right:max(47px,calc((100% - 1090px)/2 + 47px));bottom:34px;display:grid;grid-template-columns:auto 1fr;gap:.5rem;width:min(450px,calc(48% - 68px));font-size:10px;text-transform:uppercase}',
      '@media(max-width:780px){:where([data-cd-bundle-route="product"])>main>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:static;width:auto;margin:0 34px 34px}}',
    ] : []),
    ...(templateId === "soft-chemistry" && templateVersion !== undefined && templateVersion >= 6 ? [
      ':where([data-cd-bundle-route="collection"])>.commerce-contract{display:none}',
      ':where([data-cd-bundle-shell="search"],[data-cd-bundle-shell="cart"],[data-cd-bundle-shell="checkout"])>.head{background:var(--ink)}',
      ':where([data-cd-bundle-route="product"])>main.overlay{position:fixed}',
      ':where([data-cd-bundle-route="product"])>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){position:fixed;right:max(47px,calc((100vw - 1090px)/2 + 47px));bottom:max(47px,calc((100vh - 770px)/2 + 47px));z-index:72;display:grid;grid-template-columns:auto 1fr;gap:.5rem;width:min(450px,calc(48vw - 68px));font-size:10px;text-transform:uppercase}',
      '@media(max-width:780px){[data-cd-bundle-route="product"] main.overlay .panel .detail h1{font-size:36px;line-height:.9}:where([data-cd-bundle-route="product"])>section:not([class]):has(>[data-cd-trusted-slot="variantPicker"]){right:40px;bottom:6px;left:40px;width:auto;padding:10px 0;background:var(--milk)}}',
    ] : []),
  ].join("");
}
