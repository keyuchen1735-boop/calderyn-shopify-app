import type { BindingScopeKind } from "~/lib/storefront-compiler/bindings";
import type { RouteSource } from "~/lib/storefront-compiler/compile";
import { motionAttributes } from "../library/motion";
import { compileRecipeConfig, type RecipeConfig } from "../factory";
import { EMBER_ASSETS } from "./assets";

function route(html: string, css: string, rootScopeKind?: BindingScopeKind): RouteSource {
  if (rootScopeKind === "search") {
    html = html.replace(/(<main\b[^>]*>)/, '$1<aside class="ember-search-tasting-note">Search the live tasting shelf by product or flavor.</aside>');
  }
  return { html, css, requiredData: [], requiredCapabilities: [], ...(rootScopeKind ? { rootScopeKind } : {}) };
}

const sharedCss = `
  .ember-page{min-height:70dvh;background:var(--char);color:var(--bone)}
  .ember-display{font-family:var(--font-display);font-weight:900;letter-spacing:-.045em;line-height:.84;text-transform:uppercase}
  .ember-kicker{font-family:var(--font-body);font-size:.72rem;letter-spacing:.18em;text-transform:uppercase}
  .ember-button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border:2px solid var(--bone);background:var(--pepper);color:var(--bone);padding:.75rem 1.1rem;text-decoration:none;text-transform:uppercase;font-weight:800}
  .ember-empty{padding:2rem;border-top:1px solid var(--ash);overflow-wrap:anywhere}
  @media(max-width:720px){.ember-button,.ember-controls button,.ember-controls select,.ember-controls input{min-height:44px}.ember-display{letter-spacing:-.025em}}
`;

export const EMBER_RECIPE_CONFIG = {
  templateId: "ember",
  templateVersion: 1,
  concept: {
    name: "Ember",
    rationale: "A blackened tasting counter that lets real products move from a merchant-authored heat spectrum into an honest tasting flight.",
    noveltySignature: ["blackened-tasting-counter", "pepper-red-spectrum", "vertical-live-proof"],
  },
  designSystem: {
    displayFontId: "archivo-black",
    bodyFontId: "barlow-condensed",
    tokens: {
      char: "#0b0909",
      coal: "#181111",
      bone: "#fff4df",
      pepper: "#d12214",
      ember: "#ff8a00",
      ash: "#65504a",
      "space-counter": "24px",
    },
    breakpoints: { compact: 720, wide: 1240 },
    iconStyle: "pepper-scale marks and raw tasting stamps",
    motionStyle: "hard-cut reveals and restrained heat-spectrum progress",
    globalCss: "",
  },
  archetype: {
    composition: "tasting-counter",
    hero: "heat-spectrum-hero",
    scroll: "heat-tasting",
    cards: "tasting-flights",
    iconography: ["pepper-scale marks", "raw tasting stamps"],
  },
  surfaces: {
    shell: {
      signature: "black utility counter with heat-led navigation and protected cart drawer",
      source: route(`
        <header class="ember-masthead"><a class="ember-mark" data-cd-route="home"><span data-cd-text="store.name"></span></a><nav aria-label="Main navigation"><a data-cd-route="collections">Sauces</a><a data-cd-route="collection">Taste all</a><a data-cd-route="story">Our fire</a></nav><div><a data-cd-route="search">Search</a><a data-cd-route="cart">Cart <span data-cd-text="cart.count"></span></a></div></header>
        <aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="char bone pepper"></aside>
        <footer class="ember-footer"><b data-cd-text="store.name"></b><nav data-cd-policy-links></nav></footer>
      `, `.ember-masthead{display:grid;grid-template-columns:1fr auto 1fr;gap:1.5rem;align-items:center;min-height:64px;padding:.75rem 1.25rem;background:var(--char);color:var(--bone);border-bottom:1px solid var(--ash)}.ember-masthead nav,.ember-masthead>div,.ember-footer{display:flex;gap:1.2rem}.ember-masthead>div{justify-content:flex-end}.ember-masthead a,.ember-footer a{color:inherit;text-decoration:none;text-transform:uppercase}.ember-mark{font-family:var(--font-display);font-size:1.3rem}.ember-footer{justify-content:space-between;padding:2rem;background:var(--pepper);color:var(--bone)}@media(max-width:720px){.ember-mark,.ember-masthead>div a{display:inline-flex;align-items:center;min-height:44px}.ember-masthead{grid-template-columns:1fr auto}.ember-masthead nav{grid-column:1/-1;overflow:auto}.ember-masthead nav a{min-height:44px;display:inline-flex;align-items:center}}`),
    },
    home: {
      signature: "sauce-pour hero above a pepper spectrum, tasting flight, and raw live-stock strip",
      source: route(`
        <main class="ember-page ember-home">
          <section class="ember-hero" aria-label="Sauce pouring across a black tasting counter"><img class="ember-hero-image" data-cd-asset="hero" alt="Hot sauce and peppers arranged on a black tasting counter" width="1600" height="900"><div class="ember-hero-copy" ${motionAttributes("reveal")}><span class="ember-kicker">Heat / taste / repeat</span><h1 class="ember-display">Find your<br>bright burn.</h1><p>Move through the merchant's current catalog by declared heat, flavor, price, and availability.</p><a class="ember-button" data-cd-route="collection">Taste the lineup</a></div><div class="ember-spectrum" aria-label="Heat spectrum"><span>Mellow</span><i></i><span>Wild</span></div></section>
          <section class="ember-flight ember-flight-intro" ${motionAttributes("reveal")}><header><span class="ember-kicker">Tasting flight / live catalog</span><h2 class="ember-display">Build a tasting flight.</h2><p>Review the current lineup, then choose any three live products, including the same product more than once. The protected builder verifies current variants, prices, and availability before adding the flight.</p></header></section>
        </main><section data-cd-slot="bundleBuilder" data-cd-bundle-slots="3" data-cd-host-size="block" data-cd-theme-tokens="char bone pepper"></section><section class="ember-flight-catalog"><div class="ember-flight-rail" data-cd-repeat="featured.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="900"><h3 data-cd-text="product.title"></h3></a><p data-cd-text="product.description"></p><div class="ember-flight-meta"><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></div></article></div><p class="ember-empty" data-cd-empty-state>No products are ready for this tasting flight.</p></section><aside class="ember-proof-strip" aria-label="Current catalog proof"><b>Raw stock signal</b><div class="ember-proof-list" data-cd-repeat="featured.products"><span data-cd-key="product.id"><strong data-cd-text="product.title"></strong><em data-cd-text="product.description"></em><i data-cd-text="product.availability"></i></span></div></aside>
      `, `${sharedCss}
        .ember-hero{position:relative;display:grid;min-height:min(860px,90dvh);align-items:end;overflow:hidden;padding:clamp(1.5rem,7vw,7rem);background:radial-gradient(circle at 72% 45%,rgba(242,41,24,.45),transparent 8%),linear-gradient(115deg,#070606 46%,#35100c);isolation:isolate}.ember-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(11,9,9,.94),transparent 68%);z-index:-1}.ember-hero-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2}.ember-hero-copy{max-width:48rem}.ember-hero h1{font-size:clamp(4.6rem,12vw,11rem);margin:.5rem 0}.ember-hero-copy p{max-width:34rem;font-size:1.15rem;line-height:1.5}.ember-spectrum{position:absolute;right:1.5rem;bottom:1.5rem;display:grid;grid-template-columns:auto minmax(120px,20vw) auto;gap:.75rem;align-items:center;text-transform:uppercase}.ember-spectrum i{height:10px;background:linear-gradient(90deg,var(--bone),var(--ember),var(--pepper))}.ember-flight{padding:clamp(3rem,7vw,7rem)}.ember-flight header{max-width:64rem}.ember-flight h2{font-size:clamp(3.5rem,8vw,8rem);margin:.5rem 0 2rem}.ember-flight-catalog{padding:0 clamp(1rem,7vw,7rem) clamp(3rem,7vw,7rem);background:var(--char);color:var(--bone)}.ember-flight-rail{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--ash)}.ember-flight-rail article{display:grid;gap:.9rem;padding:1rem;background:var(--coal)}.ember-flight-rail img{width:100%;aspect-ratio:4/5;object-fit:cover}.ember-flight-rail a{color:inherit;text-decoration:none}.ember-flight-meta{display:flex;justify-content:space-between;gap:1rem}.ember-proof-strip{display:grid;grid-template-columns:180px 1fr;padding:1.25rem;background:var(--pepper);color:var(--bone);text-transform:uppercase}.ember-proof-list{display:grid}.ember-proof-strip span{display:grid;grid-template-columns:1fr auto;gap:1rem;padding:.55rem;border-bottom:1px solid rgba(255,244,223,.45)}.ember-proof-strip i{font-style:normal}
        @media(max-width:720px){.ember-hero{min-height:78dvh;padding-bottom:6rem}.ember-spectrum{left:1rem;right:1rem}.ember-flight-rail{grid-template-columns:1fr}.ember-proof-strip{grid-template-columns:1fr}.ember-flight-rail aside{min-height:44px}.ember-hero-copy .ember-button{width:100%}}
        @media(prefers-reduced-motion:reduce){.ember-hero-image,.ember-hero-copy,.ember-flight{animation:none;transition:none;scroll-behavior:auto}}
      `),
    },
    collections: {
      signature: "single live-catalog doorway with an availability ticker for current featured products",
      source: route(`<main class="ember-page ember-directory"><header><span class="ember-kicker">Sauce wall / live catalog</span><h1 class="ember-display">Choose the shelf.</h1><p>Enter the merchant's current collection, then filter using declared catalog facts.</p><a class="ember-button" data-cd-route="collection">All products</a></header><section data-cd-repeat="featured.products"><article data-cd-key="product.id"><h2 data-cd-text="product.title"></h2><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></article></section><p class="ember-empty" data-cd-empty-state>No products are on the tasting counter.</p></main>`, `${sharedCss}.ember-directory>header{padding:clamp(3rem,8vw,8rem);background:var(--pepper)}.ember-directory h1{font-size:clamp(4rem,11vw,10rem);margin:.5rem 0}.ember-directory>section article{display:grid;grid-template-columns:1fr auto auto;gap:1.5rem;padding:1rem 1.5rem;border-bottom:1px solid var(--ash)}@media(max-width:720px){.ember-directory>section article{grid-template-columns:1fr auto}.ember-directory>section article span{grid-column:1/-1}}`),
    },
    collection: {
      signature: "sticky pepper-tag controls beside a live collection grid with heat facts in merchant copy",
      source: route(`<main class="ember-page ember-collection"><header><span class="ember-kicker">Merchant heat spectrum</span><h1 class="ember-display" data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p><b><span data-cd-text="collection.productCount"></span> live products</b></header><nav class="ember-controls" aria-label="Filter by merchant-supplied heat tags"><span>Filter by merchant-supplied heat tags</span><button value="mild" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Mild</button><button value="medium" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Medium</button><button value="hot" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Hot</button><button value="wild" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Wild</button><button value="smoky" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Smoky</button></nav><section class="ember-collection-grid" data-cd-repeat="collection.products"><article class="ember-product-card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="900"><h2 data-cd-text="product.title"></h2></a><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></article></section><p class="ember-empty" data-cd-empty-state>No products match this declared heat tag.</p></main><section data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="char bone pepper"></div></section>`, `${sharedCss}.ember-collection>header{padding:clamp(3rem,7vw,7rem);background:linear-gradient(110deg,var(--pepper),#5c0b08)}.ember-collection h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.ember-collection>nav{position:sticky;top:0;z-index:2;display:flex;gap:.5rem;align-items:center;overflow:auto;padding:.75rem;background:var(--bone);color:var(--char)}.ember-collection>nav button{min-height:44px;border:2px solid var(--char);background:transparent;padding:.55rem .9rem;font-weight:800;text-transform:uppercase}.ember-collection-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--ash)}.ember-product-card{display:grid;gap:.8rem;padding:1rem;background:var(--coal)}.ember-product-card img{width:100%;aspect-ratio:4/5;object-fit:cover}.ember-product-card a{color:inherit;text-decoration:none}@media(max-width:720px){.ember-collection>nav span{display:none}.ember-collection-grid{grid-template-columns:1fr}.ember-collection>nav button{flex:0 0 auto;min-width:92px}}`, "collection"),
    },
    product: {
      signature: "sticky product pour and texture stage beside live variants, availability, policy, and purchase",
      source: route(`<main><section class="ember-product-media"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="1000" height="1200"><div data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="800" height="1000"></div><div class="ember-detail-fallback"></div></section><article class="ember-purchase"><div class="ember-purchase-copy"><span class="ember-kicker">Live product / current facts</span><h1 class="ember-display" data-cd-text="product.title"></h1><b data-cd-money="product.price"></b><strong data-cd-text="product.availability"></strong><p data-cd-text="product.description"></p><section class="ember-facts"><h2>Merchant-supplied facts</h2><dl data-cd-repeat="product.facts"><div class="ember-fact" data-cd-key="fact.id"><dt data-cd-text="fact.label"></dt><dd data-cd-text="fact.value"></dd><a data-cd-href="fact.url">Open merchant reference</a></div></dl></section><h2>Available options</h2><div class="ember-variants" data-cd-repeat="product.variants"><div class="ember-variant" data-cd-key="variant.id"><b data-cd-text="variant.title"></b><span data-cd-text="variant.availability"></span><strong data-cd-money="variant.price"></strong></div></div><nav data-cd-policy-links></nav></div><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="char bone pepper"></div><div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="char bone pepper"></div></article></main>`, `${sharedCss}.ember-product-media{display:grid;float:left;gap:1px;width:62%;background:var(--ash);position:sticky;top:0}.ember-product-media img{width:100%;aspect-ratio:4/5;object-fit:cover}.ember-detail-fallback{min-height:300px;background:radial-gradient(circle at 50% 40%,var(--pepper),var(--char) 55%)}.ember-purchase-copy{display:grid;gap:1.2rem;margin-left:62%;padding:clamp(1.5rem,4vw,4rem);background:var(--bone);color:var(--char)}.ember-purchase h1{font-size:clamp(3.5rem,7vw,7rem);margin:.5rem 0}.ember-facts dl,.ember-facts dd{margin:0}.ember-fact,.ember-variant{display:grid;grid-template-columns:1fr auto;gap:.35rem 1rem;padding:.8rem 0;border-top:1px solid var(--ash)}.ember-fact a{grid-column:1/-1;color:inherit}.ember-variants{display:grid}@media(max-width:720px){.ember-product-media{float:none;position:static;width:auto}.ember-purchase-copy{margin-left:0}}` , "product"),
    },
    search: {
      signature: "high-contrast catalog search with live product cards and no inferred flavor claims",
      source: route(`<main class="ember-page ember-search"><header><span class="ember-kicker">Search the shelf</span><h1 class="ember-display">Call the flavor.</h1><p data-cd-text="search.query"></p><div class="ember-controls" role="search"><input type="search" aria-label="Search products" placeholder="Sauce, snack, flavor" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div></header><section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="240" height="300"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open product</a></article></section><p class="ember-empty" data-cd-empty-state>No products match that taste. Try a broader term.</p></main>`, `${sharedCss}.ember-search>header{padding:clamp(3rem,8vw,8rem);background:var(--pepper)}.ember-search h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.ember-search input,.ember-search button{min-height:44px;border:2px solid var(--bone);background:var(--char);color:var(--bone);padding:.7rem}.ember-search>section article{display:grid;grid-template-columns:100px 1fr 2fr auto auto auto;gap:1rem;align-items:center;padding:1rem;border-bottom:1px solid var(--ash)}.ember-search img{width:100px;aspect-ratio:4/5;object-fit:cover}@media(max-width:720px){.ember-search>section article{grid-template-columns:72px 1fr}.ember-search>section article>*:not(img):not(h2){grid-column:2}}`, "search"),
    },
    story: {
      signature: "tasting-table color field and a three-step manifesto grounded in current catalog evidence",
      source: route(`<main class="ember-page ember-story"><header><div class="ember-story-media" aria-hidden="true"></div><span class="ember-kicker">The tasting table</span><h1 class="ember-display">Flavor first.<br>Fire follows.</h1><p><span data-cd-text="store.name"></span> lets product descriptions and live availability do the talking.</p></header><section><article><b>01</b><h2>Taste</h2><p>Start from flavor written by the merchant.</p></article><article><b>02</b><h2>Heat</h2><p>Use declared heat tags to narrow the shelf.</p></article><article><b>03</b><h2>Choose</h2><p>Confirm a real option and current availability.</p></article></section><a class="ember-button" data-cd-route="collection">Open the shelf</a><nav data-cd-policy-links></nav></main>`, `${sharedCss}.ember-story{padding:clamp(2rem,7vw,7rem)}.ember-story>header{max-width:74rem}.ember-story-media{width:100%;aspect-ratio:16/9;object-fit:cover;background:linear-gradient(120deg,var(--char),var(--pepper))}.ember-story h1{font-size:clamp(4rem,11vw,10rem);margin:.5rem 0}.ember-story>section{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:4rem 0;background:var(--ash)}.ember-story article{min-height:240px;padding:1.5rem;background:var(--coal)}@media(max-width:720px){.ember-story>section{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.ember-story-media{animation:none;transition:none}}`),
    },
    cart: {
      signature: "pepper-red tasting ledger with live lines, totals, controls, and protected checkout summary",
      source: route(`<main class="ember-page ember-cart"><header><span class="ember-kicker">Tasting tray / cart</span><h1 class="ember-display">Your flight.</h1><span><b data-cd-text="cart.count"></b> items</span><span>Live subtotal <b data-cd-money="cart.subtotal"></b></span></header><section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><span>Qty <b data-cd-text="cartLine.quantity"></b></span><span data-cd-money="cartLine.unitPrice"></span><strong data-cd-money="cartLine.total"></strong></article></section><aside><span>Subtotal</span><b data-cd-money="cart.subtotal"></b><span>Total</span><strong data-cd-money="cart.total"></strong></aside><p class="ember-empty" data-cd-empty-state>Your tasting tray is empty.</p></main><section data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls" data-cd-host-size="inline"></div></section><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="char bone pepper"></div>`, `${sharedCss}.ember-cart>header{padding:clamp(3rem,7vw,7rem);background:var(--pepper)}.ember-cart h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.ember-cart>section article{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:1rem;padding:1.2rem;border-bottom:1px solid var(--ash)}.ember-cart>aside{display:grid;grid-template-columns:1fr auto;gap:1rem;max-width:34rem;margin:2rem 2rem 2rem auto}@media(max-width:720px){.ember-cart>section article{grid-template-columns:1fr 1fr}}`, "cart"),
    },
    checkout: {
      signature: "clean bone checkout frame carrying the black-and-pepper tasting identity into protected payment",
      source: {
        html: `<article class="ember-checkout-frame"><header class="ember-checkout"><span>Secure checkout / final pour</span><h1 data-cd-text="store.name"></h1><p>Products, delivery, payment, and final totals remain controlled by the platform.</p></header><aside class="ember-checkout-note"><b>Review the flight</b><span>Selected variants retained</span><span>Final availability confirmed at checkout</span></aside><footer data-cd-policy-links></footer></article>`,
        css: `.ember-checkout{max-width:760px;padding:48px}.ember-checkout h1{font-size:64px}.ember-checkout-note{display:grid;gap:12px;padding:32px;border-left-width:2px;border-style:solid;border-color:var(--pepper)}`,
        layout: { columnMode: "summaryAside", sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"], spacingTokenId: "space-counter", surfaceTokenIds: ["bone", "char", "pepper"] },
      },
    },
    notFound: {
      signature: "charred 404 recovery screen pointing shoppers back to the live shelf and search",
      source: route(`<main class="ember-page ember-lost"><span class="ember-kicker">404 / no bottle here</span><h1 class="ember-display">This shelf is cold.</h1><p>The requested page is not in the current storefront.</p><nav><a class="ember-button" data-cd-route="collection">Browse the shelf</a><a data-cd-route="search">Search products</a></nav></main>`, `${sharedCss}.ember-lost{display:grid;align-content:center;min-height:72dvh;padding:clamp(2rem,8vw,8rem);background:radial-gradient(circle at 78% 50%,#7b0f09,var(--char) 40%)}.ember-lost h1{max-width:10ch;font-size:clamp(4rem,11vw,10rem);margin:.5rem 0}.ember-lost nav{display:flex;gap:1rem;align-items:center}.ember-lost nav a{color:inherit}`),
    },
  },
  assets: EMBER_ASSETS,
} satisfies RecipeConfig<"ember">;

export const EMBER_RECIPE = compileRecipeConfig(EMBER_RECIPE_CONFIG);
export const EMBER_BUNDLE = EMBER_RECIPE.bundle;
