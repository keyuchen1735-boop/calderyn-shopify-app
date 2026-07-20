import { compileRecipeConfig, type RecipeConfig } from "../factory";
import { videoFragment } from "../library/media";
import { motionAttributes } from "../library/motion";
import { FORGE_ASSETS } from "./assets";

const heroVideo = videoFragment({
  className: "forge-video",
  posterAssetKey: "hero-poster",
  webmAssetKey: "hero-webm",
  mp4AssetKey: "hero-mp4",
});
const storyVideo = videoFragment({
  className: "forge-video",
  posterAssetKey: "hero-alt-poster",
  webmAssetKey: "hero-alt-webm",
  mp4AssetKey: "hero-alt-mp4",
});
const detailVideo = videoFragment({
  className: "forge-video",
  posterAssetKey: "pdp-detail-poster",
  webmAssetKey: "pdp-detail-webm",
  mp4AssetKey: "pdp-detail-mp4",
});

const source = (html: string, css: string, rootScopeKind?: "product" | "search" | "cart") => ({
  html,
  css: `${css}.forge-copy{overflow-wrap:anywhere}`,
  requiredData: [],
  requiredCapabilities: [],
  ...(rootScopeKind ? { rootScopeKind } : {}),
});

const productCard = `<article class="forge-card forge-copy" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><figure><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="720"><span data-cd-text="product.availability"></span></figure><div class="forge-card-copy"><small>Live inventory / merchant record</small><h3 data-cd-text="product.title"></h3><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b></div></a></article>`;
const productCardsCss = `.forge-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}.forge-card{min-width:0;background:var(--parchment)}.forge-card a{display:block;color:inherit;text-decoration:none}.forge-card figure{position:relative;margin:0;aspect-ratio:4/3;overflow:hidden;background:var(--steel)}.forge-card img{width:100%;height:100%;object-fit:cover}.forge-card figure span{position:absolute;top:.75rem;left:.75rem;padding:.35rem .5rem;background:var(--steel);color:var(--parchment);font:600 .65rem var(--font-body);text-transform:uppercase}.forge-card-copy{padding:1rem}.forge-card h3{margin:.35rem 0;font:700 clamp(1.5rem,2.6vw,2.5rem)/.95 var(--font-display);text-transform:uppercase}.forge-card p{min-height:3.2rem;font-size:.78rem}.forge-card b{color:var(--orange)}@media(max-width:760px){.forge-grid{grid-template-columns:1fr}}`;

export const FORGE_RECIPE_CONFIG = {
  templateId: "forge",
  templateVersion: 1,
  concept: {
    name: "Forge",
    rationale: "A jobsite blueprint that lets working catalogs present merchant-authored compatibility evidence before protected purchase actions.",
    noveltySignature: ["blueprint-coordinate-grid", "exploded-tool-records", "verified-line-item-loadout"],
  },
  designSystem: {
    displayFontId: "oswald",
    bodyFontId: "dm-mono",
    tokens: {
      steel: "#24313a",
      "steel-dark": "#172027",
      orange: "#c94f18",
      parchment: "#efe4ce",
      ink: "#182127",
      line: "#89949a",
      "drawing-gap": "20px",
    },
    breakpoints: { compact: 760, wide: 1320 },
    iconStyle: "numbered drawing callouts and dimension ticks",
    motionStyle: "measured blueprint reveals with reduced-motion static sections",
    globalCss: `.forge-label{font:700 .68rem var(--font-body);letter-spacing:.12em;text-transform:uppercase}.forge-video{display:block;width:100%;height:100%;object-fit:cover;background:var(--steel-dark)}@media(prefers-reduced-motion:reduce){.forge-motion{animation:none!important;transform:none!important;transition:none!important}.forge-video{display:none}}`,
  },
  archetype: {
    composition: "jobsite-blueprint",
    hero: "exploded-tool-hero",
    scroll: "blueprint-flow",
    cards: "tool-diagrams",
    iconography: ["numbered component circles", "dimension lines"],
  },
  surfaces: {
    shell: {
      signature: "steel drawing-title block with project navigation and protected loadout drawer",
      source: source(
        `<header class="forge-shell"><a class="forge-mark" data-cd-route="home"><span aria-hidden="true">F//</span><b data-cd-text="store.name">Forge</b></a><nav aria-label="Primary navigation"><a data-cd-route="collections">Projects</a><a data-cd-route="collection">Tools</a><a data-cd-route="story">Field notes</a><a data-cd-route="search">Search</a><a data-cd-route="cart">Loadout <span data-cd-text="cart.count"></span></a></nav><a class="forge-account" data-cd-route="account">Account</a></header><aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="steel steel-dark orange parchment"></aside><footer class="forge-footer"><span data-cd-text="store.name"></span><nav data-cd-policy-links></nav></footer>`,
        `.forge-shell{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:1rem;padding:.8rem 1rem;background:var(--steel-dark);color:var(--parchment);border-bottom:4px solid var(--orange)}.forge-shell a{color:inherit;text-decoration:none}.forge-mark{display:flex;align-items:center;gap:.6rem;font-family:var(--font-display);font-size:1.45rem;text-transform:uppercase}.forge-mark>span{padding:.3rem;background:var(--orange);color:#fff}.forge-shell nav{display:flex;justify-content:center;gap:1.2rem;font:700 .68rem var(--font-body);text-transform:uppercase}.forge-account{font:700 .68rem var(--font-body);text-transform:uppercase}.forge-footer{display:flex;justify-content:space-between;gap:1rem;padding:1.5rem;background:var(--steel);color:var(--parchment)}.forge-footer nav{display:flex;gap:1rem}@media(max-width:760px){.forge-shell{grid-template-columns:1fr auto}.forge-shell nav{grid-column:1/-1;justify-content:flex-start;overflow:auto}.forge-account{grid-row:1;grid-column:2}.forge-shell nav a{min-width:max-content}}`,
      ),
    },
    home: {
      signature: "exploded-tool video plate over live catalog drawings and a verified line-item job loadout",
      source: source(
        `<main class="forge-frame"><section class="forge-hero"><div class="forge-hero-copy forge-copy forge-motion" ${motionAttributes("reveal")}><span class="forge-label">Drawing 01 / active catalog</span><h1>Build from<br>the drawing.</h1><p>Inspect merchant-listed fit, stock, and options before anything enters the loadout.</p><a data-cd-route="collection">Open the tool index</a></div><figure class="forge-hero-media">${heroVideo.html}<figcaption>Exploded tool study / optional approved media</figcaption><i class="callout c1">01</i><i class="callout c2">02</i></figure></section><section class="forge-live"><header><span class="forge-label">Plate 02 / current inventory</span><h2>Tools on the sheet</h2><p>Images, descriptions, prices, and availability come directly from the merchant catalog.</p></header><div class="forge-grid" data-cd-repeat="featured.products">${productCard}</div><p data-cd-empty-state>No live tools are available for this drawing.</p></section><section class="forge-bundle forge-motion" ${motionAttributes("reveal")}><div><span class="forge-label">Plate 03 / job loadout</span><h2>Verify every line.</h2><p>Add verified items one at a time. Open each live product, confirm its current option and availability, then use the protected purchase control. Forge never infers a kit or adds a hidden bundle.</p><a data-cd-route="cart">Review current loadout</a></div><ol data-cd-repeat="featured.products"><li data-cd-key="product.id"><span data-cd-text="product.title"></span><b data-cd-money="product.price"></b><small data-cd-text="product.availability"></small></li></ol></section><section data-cd-repeat="featured.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="steel steel-dark orange parchment"></div></section></main>`,
        `.forge-hero{display:grid;grid-template-columns:.86fr 1.14fr;min-height:680px;border-bottom:1px solid var(--steel)}.forge-hero-copy{display:flex;flex-direction:column;justify-content:center;padding:clamp(2rem,6vw,6rem)}.forge-hero h1{max-width:7ch;margin:.5rem 0;font:700 clamp(4.8rem,10vw,10rem)/.78 var(--font-display);letter-spacing:-.045em;text-transform:uppercase}.forge-hero-copy>a,.forge-bundle a{align-self:flex-start;margin-top:1rem;padding:.8rem 1rem;background:var(--orange);color:#fff;text-decoration:none;text-transform:uppercase}.forge-hero-media{position:relative;margin:1rem;background:var(--steel-dark);overflow:hidden}.forge-hero-media figcaption{position:absolute;right:1rem;bottom:1rem;padding:.5rem;background:var(--parchment);font:700 .6rem var(--font-body);text-transform:uppercase}.callout{position:absolute;display:grid;place-items:center;width:2.4rem;height:2.4rem;border-radius:50%;background:var(--orange);color:#fff;font:700 .7rem var(--font-body)}.c1{top:18%;left:14%}.c2{right:12%;bottom:24%}.forge-live{padding:clamp(2rem,5vw,5rem)}.forge-live>header{display:grid;grid-template-columns:1fr 1.5fr 1fr;align-items:end;gap:1rem;margin-bottom:2rem}.forge-live h2,.forge-bundle h2{margin:0;font:700 clamp(3rem,6vw,7rem)/.84 var(--font-display);text-transform:uppercase}.forge-bundle{display:grid;grid-template-columns:1fr 1fr;gap:2rem;padding:clamp(2rem,5vw,5rem);background:var(--steel);color:var(--parchment)}.forge-bundle ol{margin:0;padding:0;list-style:none;border-top:1px solid var(--line)}.forge-bundle li{display:grid;grid-template-columns:1fr auto;gap:.4rem;padding:1rem 0;border-bottom:1px solid var(--line)}.forge-bundle small{grid-column:1/-1}${productCardsCss}@media(max-width:760px){.forge-hero,.forge-bundle,.forge-live>header{grid-template-columns:1fr}.forge-hero{min-height:0}.forge-hero-media{min-height:52dvh}.forge-hero h1{font-size:4.7rem}}`,
      ),
    },
    collection: {
      signature: "sticky merchant-tag project filters beside live tool diagrams and quick-view purchase controls",
      source: source(
        `<main class="forge-frame forge-catalog"><header class="forge-catalog-head forge-copy"><span class="forge-label">Project index / merchant record</span><h1 data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p><b><span data-cd-text="collection.productCount"></span> live entries</b></header><nav class="forge-filters" aria-label="Project filters"><span>Merchant-supplied project tags</span><button value="framing" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Framing</button><button value="finish" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Finish</button><button value="electrical" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Electrical</button><button value="repair" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Repair</button><select aria-label="Sort live tools" value="featured" data-cd-on="change" data-cd-action="collection.sort"><option value="featured">Drawing order</option><option value="low">Price low</option><option value="high">Price high</option></select></nav><div class="forge-grid" data-cd-repeat="collection.products">${productCard}</div><p class="forge-empty" data-cd-empty-state>No live products carry this merchant tag.</p></main><section data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="steel steel-dark orange parchment"></div></section>`,
        `.forge-catalog{display:grid;grid-template-columns:18rem 1fr}.forge-catalog-head{grid-column:1/-1;padding:clamp(2rem,5vw,5rem);background:var(--steel);color:var(--parchment)}.forge-catalog-head h1{margin:.5rem 0;font:700 clamp(4rem,9vw,9rem)/.8 var(--font-display);text-transform:uppercase}.forge-filters{position:sticky;top:0;align-self:start;display:grid;gap:.5rem;padding:1rem;background:var(--steel-dark);color:var(--parchment)}.forge-filters span{font:700 .65rem var(--font-body);text-transform:uppercase}.forge-filters button,.forge-filters select{padding:.8rem;border:1px solid var(--line);background:transparent;color:inherit;text-align:left}.forge-catalog>.forge-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.forge-empty{padding:2rem}${productCardsCss}@media(max-width:920px){.forge-catalog{grid-template-columns:1fr}.forge-filters{position:static;grid-template-columns:repeat(2,1fr)}.forge-catalog>.forge-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.forge-catalog>.forge-grid{grid-template-columns:1fr}}`,
      ),
    },
    product: {
      signature: "exploded live product gallery paired with merchant compatibility record and protected controls",
      source: source(
        `<main class="forge-frame forge-product"><section class="forge-product-media"><div class="forge-detail-video">${detailVideo.html}</div><div class="forge-drawings" data-cd-repeat="product.images"><figure data-cd-key="product.primaryImage"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="920" height="920"></figure></div></section><article class="forge-spec forge-copy"><span class="forge-label">Merchant compatibility record</span><h1 data-cd-text="product.title"></h1><p data-cd-text="product.description"></p><div class="forge-price"><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></div><section><h2>Declared options</h2><p>Only options and availability supplied by this merchant appear below. Confirm the selected line before purchase.</p><div data-cd-repeat="product.variants"><div class="forge-variant" data-cd-key="variant.id"><b data-cd-text="variant.title"></b><span data-cd-money="variant.price"></span><small data-cd-text="variant.availability"></small></div></div></section></article></main><div data-cd-slot="variantPicker" data-cd-host-size="block" data-cd-theme-tokens="steel steel-dark orange parchment"></div><div data-cd-slot="addToCart" data-cd-host-size="block" data-cd-theme-tokens="steel steel-dark orange parchment"></div>`,
        `.forge-product{display:grid;grid-template-columns:1.15fr .85fr;min-height:80dvh}.forge-product-media{padding:1rem;border-right:1px solid var(--steel)}.forge-detail-video{height:48dvh;background:var(--steel-dark)}.forge-drawings{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;margin-top:1px;background:var(--line)}.forge-drawings figure{margin:0;background:var(--parchment)}.forge-drawings img{display:block;width:100%;aspect-ratio:1;object-fit:cover}.forge-spec{position:sticky;top:0;align-self:start;padding:clamp(2rem,5vw,5rem)}.forge-spec h1{margin:.5rem 0;font:700 clamp(4rem,7vw,8rem)/.8 var(--font-display);text-transform:uppercase}.forge-price{display:flex;justify-content:space-between;padding:1rem 0;border-block:1px solid var(--steel);font-size:1.1rem}.forge-spec h2{font-family:var(--font-display);text-transform:uppercase}.forge-variant{display:grid;grid-template-columns:1fr auto;gap:.35rem;padding:.7rem 0;border-bottom:1px solid var(--line)}.forge-variant small{grid-column:1/-1}@media(max-width:860px){.forge-product{grid-template-columns:1fr}.forge-product-media{border-right:0}.forge-spec{position:static}}`,
        "product",
      ),
    },
    search: {
      signature: "overscale drawing query with live merchant matches and explicit empty-plan state",
      source: source(
        `<main class="forge-frame forge-search"><header class="forge-search-head forge-copy"><span class="forge-label">Drawing query / live catalog</span><h1 data-cd-text="search.query">Find the right line.</h1><div><input aria-label="Search live catalog" type="search" name="q" placeholder="Tool, project tag, or merchant-listed detail" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Run query</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div></header><div class="forge-grid" data-cd-repeat="search.results">${productCard}</div><p class="forge-empty" data-cd-empty-state>No live catalog lines match this query.</p></main>`,
        `.forge-search-head{padding:clamp(2rem,7vw,7rem);background:var(--steel);color:var(--parchment)}.forge-search-head h1{margin:.5rem 0;font:700 clamp(4rem,10vw,11rem)/.78 var(--font-display);text-transform:uppercase}.forge-search-head input,.forge-search-head button{padding:1rem;border:1px solid var(--parchment);background:transparent;color:inherit}.forge-search-head input{width:min(35rem,100%)}.forge-empty{padding:2rem}${productCardsCss}`,
        "search",
      ),
    },
    cart: {
      signature: "construction loadout ledger with live line controls and trusted order summary",
      source: source(
        `<main class="forge-frame forge-cart"><header class="forge-cart-head"><span class="forge-label">Loadout drawing / current cart</span><h1>Every line accounted for.</h1><b><span data-cd-text="cart.count"></span> items</b></header><section class="forge-lines" data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><div><h2 data-cd-text="cartLine.title"></h2><span>Quantity <b data-cd-text="cartLine.quantity"></b></span></div><span data-cd-money="cartLine.unitPrice"></span><strong data-cd-money="cartLine.total"></strong></article></section><aside class="forge-total"><span>Subtotal</span><b data-cd-money="cart.subtotal"></b><span>Total</span><strong data-cd-money="cart.total"></strong></aside><p class="forge-empty" data-cd-empty-state>The loadout drawing is empty.</p></main><section data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls" data-cd-host-size="inline"></div></section><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="steel steel-dark orange parchment"></div>`,
        `.forge-cart-head{padding:clamp(2rem,6vw,6rem);background:var(--orange);color:#fff}.forge-cart-head h1{max-width:11ch;margin:.5rem 0;font:700 clamp(4rem,9vw,9rem)/.8 var(--font-display);text-transform:uppercase}.forge-lines{padding:1rem}.forge-lines article{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:1rem;padding:1rem;border-bottom:1px solid var(--steel)}.forge-total{display:grid;grid-template-columns:1fr auto;gap:1rem;width:min(34rem,100%);margin-left:auto;padding:2rem;background:var(--steel);color:var(--parchment)}.forge-empty{padding:2rem}@media(max-width:760px){.forge-lines article{grid-template-columns:1fr auto}}`,
        "cart",
      ),
    },
    checkout: {
      signature: "parchment drawing-title checkout with compact protected-flow trust rail",
      source: {
        html: `<header class="forge-checkout"><span>Final drawing / secure checkout</span><h1 data-cd-text="store.name">Forge</h1><p>Confirm contact, delivery, consent, and payment in the protected checkout flow.</p></header><aside class="forge-checkout-rail"><b>Live order summary</b><span>Merchant policies remain available below.</span></aside><footer data-cd-policy-links></footer>`,
        css: `.forge-checkout{padding:48px;background-color:var(--parchment);color:var(--ink)}.forge-checkout h1{font-family:var(--font-display);font-size:72px;font-weight:700;line-height:.8}.forge-checkout-rail{display:grid;gap:8px;padding:32px;background-color:var(--steel);color:var(--parchment)}`,
        layout: {
          columnMode: "summaryAside",
          sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
          spacingTokenId: "drawing-gap",
          surfaceTokenIds: ["parchment", "steel", "orange"],
        },
      },
    },
    collections: {
      signature: "project-doorway index that routes to live tagged inventory without asserting hidden bundles",
      source: source(
        `<main class="forge-frame forge-projects"><header><span class="forge-label">Project doorways / catalog navigation</span><h1>Start with the job.</h1><p>Each doorway opens the live tool index. Results appear only when the merchant has supplied the matching project tag.</p></header><nav aria-label="Project doorways"><a data-cd-route="collection">Framing <span>01</span></a><a data-cd-route="collection">Finish <span>02</span></a><a data-cd-route="collection">Electrical <span>03</span></a><a data-cd-route="collection">Repair <span>04</span></a></nav><section class="forge-grid" data-cd-repeat="featured.products">${productCard}</section></main>`,
        `.forge-projects>header{padding:clamp(2rem,6vw,6rem);background:var(--steel);color:var(--parchment)}.forge-projects h1{margin:.5rem 0;font:700 clamp(4rem,10vw,11rem)/.78 var(--font-display);text-transform:uppercase}.forge-projects>nav{display:grid;grid-template-columns:repeat(2,1fr)}.forge-projects>nav a{display:flex;justify-content:space-between;padding:clamp(2rem,5vw,5rem);border:1px solid var(--steel);color:inherit;font:700 clamp(2rem,5vw,5rem)/.9 var(--font-display);text-decoration:none;text-transform:uppercase}${productCardsCss}@media(max-width:700px){.forge-projects>nav{grid-template-columns:1fr}}`,
      ),
    },
    story: {
      signature: "field-note chronology pairing optional jobsite footage with merchant catalog evidence rules",
      source: source(
        `<main class="forge-frame forge-story"><section class="forge-story-hero"><div><span class="forge-label">Field notes / evidence rule</span><h1>Read the mark.<br>Check the record.</h1><p>Forge presents only the images, options, compatibility language, prices, and availability supplied by the merchant.</p><a data-cd-route="collection">Inspect live records</a></div><figure>${storyVideo.html}<figcaption>Jobsite context / optional approved media</figcaption></figure></section><section class="forge-notes"><article><b>01</b><h2>Observe</h2><p>Use live product imagery and descriptions as the source of truth.</p></article><article><b>02</b><h2>Compare</h2><p>Compare merchant-declared options without adding performance standards.</p></article><article><b>03</b><h2>Confirm</h2><p>Select the current variant and use protected commerce controls.</p></article></section></main>`,
        `.forge-story-hero{display:grid;grid-template-columns:1fr 1fr;min-height:72dvh}.forge-story-hero>div{display:flex;flex-direction:column;justify-content:center;padding:clamp(2rem,6vw,6rem);background:var(--steel);color:var(--parchment)}.forge-story h1{margin:.6rem 0;font:700 clamp(4rem,8vw,9rem)/.8 var(--font-display);text-transform:uppercase}.forge-story a{align-self:flex-start;padding:.8rem 1rem;background:var(--orange);color:#fff;text-decoration:none}.forge-story figure{position:relative;margin:0;background:var(--steel-dark)}.forge-story figure figcaption{position:absolute;right:1rem;bottom:1rem;padding:.5rem;background:var(--parchment);font-size:.65rem}.forge-notes{display:grid;grid-template-columns:repeat(3,1fr)}.forge-notes article{padding:clamp(2rem,4vw,4rem);border:1px solid var(--steel)}.forge-notes b{color:var(--orange)}.forge-notes h2{font:700 3rem var(--font-display);text-transform:uppercase}@media(max-width:760px){.forge-story-hero,.forge-notes{grid-template-columns:1fr}.forge-story figure{min-height:50dvh}}`,
      ),
    },
    notFound: {
      signature: "misread-coordinate recovery plate routing back to projects, tools, and search",
      source: source(
        `<main class="forge-frame forge-missing"><span class="forge-label">Drawing not found / 404</span><h1>Wrong coordinate.</h1><p>This route is not on the current plan.</p><nav><a data-cd-route="collections">Open projects</a><a data-cd-route="collection">Open tools</a><a data-cd-route="search">Search the catalog</a></nav></main>`,
        `.forge-missing{display:grid;place-content:center;min-height:75dvh;padding:2rem;text-align:center}.forge-missing h1{margin:.5rem 0;font:700 clamp(5rem,14vw,14rem)/.75 var(--font-display);text-transform:uppercase}.forge-missing nav{display:flex;justify-content:center;gap:.5rem;flex-wrap:wrap}.forge-missing a{padding:.8rem 1rem;background:var(--steel);color:var(--parchment);text-decoration:none}`,
      ),
    },
  },
  assets: FORGE_ASSETS,
} satisfies RecipeConfig<"forge">;

export const FORGE_RECIPE = compileRecipeConfig(FORGE_RECIPE_CONFIG);
export const FORGE_BUNDLE = FORGE_RECIPE.bundle;
