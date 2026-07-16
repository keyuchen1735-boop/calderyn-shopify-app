// Converts a recipe's authored HTML/CSS into a plain designer document. The
// recipes are used strictly as raw template material: their data-cd-* binding
// vocabulary becomes simple {{placeholders}} the designer renderer interprets,
// and everything engine-specific (trusted slots, interaction wiring) becomes
// ordinary markup the model can freely edit.
import { getStoreTemplate } from "../storefront-bundle/registry";
import { loadRecipe } from "../storefront-bundle/build.server";
import type { StoreTemplateId } from "../storefront-bundle/types";
import type { DefinedRecipe } from "../storefront-recipes/factory";

export interface DesignerDocument {
  route: "home" | "collection" | "product" | "search" | "cart";
  html: string;
  css: string;
}

export const DESIGNER_ROUTES = ["home", "collection", "product", "search", "cart"] as const;

/** data-cd paths → designer placeholders. Money paths render pre-formatted. */
const TEXT_PATHS: Record<string, string> = {
  "store.name": "{{store.name}}",
  "cart.count": "{{cart.count}}",
  "collection.title": "{{collection.title}}",
  "collection.description": "{{collection.description}}",
  "collection.productCount": "{{collection.count}}",
  "product.title": "{{product.title}}",
  "product.description": "{{product.description}}",
  "product.availability": "{{product.availability}}",
  "product.price": "{{product.price}}",
  "product.compareAtPrice": "{{product.compareAtPrice}}",
  "variant.title": "{{product.title}}",
  "variant.price": "{{product.price}}",
  "search.query": "{{search.query}}",
};

function stripAttribute(html: string, name: string): string {
  return html.replace(new RegExp(`\\s${name}="[^"]*"`, "g"), "");
}

function convertMarkup(html: string, templateId: string): string {
  let out = html;

  // Repeats: the repeated element renders once per product between loop tags.
  out = out.replace(/<(\w+)([^>]*)\sdata-cd-repeat="(?:featured\.products|collection\.products|search\.results)"([^>]*)>/g,
    "{{#products}}<$1$2$3>");
  // The loop closes at the repeated element's own close tag; recipes always
  // author the repeat element with a single well-formed close. Rather than
  // balance tags, lean on the renderer: {{#products}} scopes until {{/products}}
  // which we append right after the element via a marker pass below.
  out = out.replace(/\{\{#products\}\}<(\w+)/g, '{{#products}}<$1 data-designer-repeat="$1"');

  // Text bindings become inline placeholders inside their element.
  out = out.replace(/<(\w+)([^>]*)\sdata-cd-(?:text|money)="([^"]+)"([^>]*)>(\s*)<\/\1>/g, (match, tag, pre, path, post) => {
    const placeholder = TEXT_PATHS[path] ?? "";
    return `<${tag}${pre}${post}>${placeholder}</${tag}>`;
  });
  // Non-empty bound elements keep their authored fallback content.
  out = out.replace(/\sdata-cd-(?:text|money)="[^"]+"/g, "");

  // Images: product imagery binds to the catalog; template art keeps its file.
  out = out.replace(/\sdata-cd-src="product\.primaryImage"/g, ' src="{{product.image}}"');
  out = out.replace(/\sdata-cd-src="collection\.image"/g, ' src="{{product.image}}"');
  out = out.replace(/\sdata-cd-src="store\.logo"/g, ' src="{{store.logo}}"');
  out = out.replace(/\sdata-cd-alt="([^"]+)"/g, (match, path) => ` alt="${TEXT_PATHS[path] ? TEXT_PATHS[path] : "Product"}"`);
  out = out.replace(/\sdata-cd-asset="([A-Za-z0-9_-]+)"/g, ` src="/storefront-recipes/${templateId}/$1.webp"`);

  // Route links become plain storefront paths.
  out = out.replace(/<a([^>]*)\sdata-cd-route="product"([^>]*)\sdata-cd-param-handle="product\.handle"([^>]*)>/g,
    '<a$1 href="{{product.url}}"$2$3>');
  out = out.replace(/\sdata-cd-param-handle="[^"]*"/g, "");
  const ROUTE_HREFS: Record<string, string> = {
    home: "/storefront", collection: "/storefront/search", product: "/storefront/search",
    search: "/storefront/search", cart: "/storefront/cart", checkout: "/storefront/checkout",
    account: "/storefront/account", policy: "/storefront/policies/privacy",
  };
  out = out.replace(/\sdata-cd-route="(\w+)"/g, (match, route) => ` href="${ROUTE_HREFS[route] ?? "/storefront"}"`);
  // Anchors can end up with two hrefs when the recipe authored both; keep the first.
  out = out.replace(/(href="[^"]*")([^>]*)\shref="[^"]*"/g, "$1$2");

  // Trusted commerce hosts become a plain add-to-cart button the model can style.
  out = out.replace(/<(\w+)([^>]*)\sdata-cd-slot="quickViewCommerce"[^>]*><\/\1>/g,
    '<button class="designer-add-to-cart" type="button">Add to cart</button>');
  out = out.replace(/<(\w+)([^>]*)\sdata-cd-slot="[^"]*"[^>]*><\/\1>/g, "");
  out = out.replace(/\sdata-cd-policy-links(?:="[^"]*")?/g, "");

  // Remaining engine attributes are noise for the designer document.
  for (const attribute of [
    "data-cd-key", "data-cd-on", "data-cd-action", "data-cd-target", "data-cd-state", "data-cd-state-id",
    "data-cd-state-type", "data-cd-state-initial", "data-cd-state-values", "data-cd-state-min", "data-cd-state-max",
    "data-cd-bind-state", "data-cd-bind-property", "data-cd-value-field", "data-cd-facet", "data-cd-product",
    "data-cd-host-size", "data-cd-theme-tokens", "data-cd-param-query", "data-cd-param-policy-id",
  ]) {
    out = stripAttribute(out, attribute);
  }
  return out;
}

/** Close each product loop right after its repeated element. The repeated
 *  element's tag was stamped during conversion; a tiny depth counter finds its
 *  matching close tag without a full HTML parser. */
export function closeProductLoops(html: string): string {
  let out = html;
  for (;;) {
    const marker = out.match(/<(\w+)([^>]*)\sdata-designer-repeat="\w+"([^>]*)>/);
    if (!marker || marker.index === undefined) break;
    const tag = marker[1];
    const openLength = marker[0].length;
    const start = marker.index;
    let depth = 1;
    let cursor = start + openLength;
    const tagRe = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
    tagRe.lastIndex = cursor;
    let end = out.length;
    for (let step = tagRe.exec(out); step; step = tagRe.exec(out)) {
      depth += step[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = step.index + step[0].length;
        break;
      }
    }
    out = `${out.slice(0, start)}${marker[0].replace(/\sdata-designer-repeat="\w+"/, "")}${out.slice(start + openLength, end)}{{/products}}${out.slice(end)}`;
  }
  return out;
}

function designSystemCss(recipe: DefinedRecipe): string {
  const { tokens, displayFontId, bodyFontId } = recipe.config.designSystem;
  const fontFace = (id: string) =>
    `@font-face{font-family:"${id}";src:url(/storefront-fonts/${id}-latin.woff2);font-display:swap;font-weight:100 900}`;
  const variables = Object.entries(tokens).map(([id, value]) => `--${id}:${value}`).join(";");
  return [
    ...new Set([fontFace(displayFontId), fontFace(bodyFontId)]),
    `:root{${variables};--font-display:"${displayFontId}",sans-serif;--font-body:"${bodyFontId}",sans-serif}`,
    "*,*::before,*::after{box-sizing:border-box}body{margin:0;font-family:var(--font-body)}img{max-width:100%;display:block}",
    ".designer-add-to-cart{padding:10px 18px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer}",
  ].join("\n");
}

/** Builds the full document set for one template. Raw material only: the
 *  output is plain HTML/CSS with {{placeholders}}, owned by the designer. */
export async function convertTemplateToDocuments(templateId: StoreTemplateId): Promise<{ documents: DesignerDocument[]; baseCss: string }> {
  const recipe = await loadRecipe(templateId, getStoreTemplate(templateId).activeVersion);
  const shellSource = recipe.config.surfaces.shell.source;
  const shellHtml = closeProductLoops(convertMarkup(shellSource.html, templateId));
  const baseCss = [
    designSystemCss(recipe),
    recipe.config.designSystem.globalCss ?? "",
    shellSource.css ?? "",
  ].filter(Boolean).join("\n");

  // The shell's footer trails the route content; everything before it leads.
  const footerAt = shellHtml.search(/<footer/i);
  const lead = footerAt >= 0 ? shellHtml.slice(0, footerAt) : shellHtml;
  const trail = footerAt >= 0 ? shellHtml.slice(footerAt) : "";

  const documents = DESIGNER_ROUTES.map((route): DesignerDocument => {
    const surface = recipe.config.surfaces[route].source;
    const routeHtml = closeProductLoops(convertMarkup(surface.html, templateId));
    return {
      route,
      html: `${lead}\n<main data-designer-route="${route}">\n${routeHtml}\n</main>\n${trail}`,
      css: surface.css ?? "",
    };
  });
  return { documents, baseCss };
}
