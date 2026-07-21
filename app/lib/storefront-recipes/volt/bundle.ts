import type { BindingScopeKind } from "~/lib/storefront-compiler/bindings";
import type { RouteSource } from "~/lib/storefront-compiler/compile";
import { proofBandFragment } from "../library/commerce";
import { motionAttributes } from "../library/motion";
import { compileRecipeConfig, type RecipeConfig } from "../factory";
import { VOLT_ASSETS } from "./assets";

function route(html: string, css: string, rootScopeKind?: BindingScopeKind): RouteSource {
  if (rootScopeKind === "search") {
    html = html.replace(/(<main\b[^>]*>)/, '$1<nav class="volt-search-channel" aria-label="Search signal path"><span>Query</span><span>Signal</span><span>Result</span></nav>');
  }
  if (rootScopeKind === "cart") {
    html = html.replace(/(<main\b[^>]*>)/, '$1<nav class="volt-cart-system" aria-label="System checkout path"><span>Components</span><span>Review</span><span>Checkout</span></nav>');
  }
  return { html, css, requiredData: [], requiredCapabilities: [], ...(rootScopeKind ? { rootScopeKind } : {}) };
}

const catalogProof = proofBandFragment({
  className: "volt-proof",
  copy: "Live pricing, availability, and options from this store's catalog.",
});

const sharedRouteCss = `
  .volt-page{background:var(--paper);color:var(--ink);min-height:70dvh}
  .volt-kicker{font-family:var(--font-body);font-size:.72rem;letter-spacing:.14em;text-transform:uppercase}
  .volt-display{font-family:var(--font-display);font-weight:500;letter-spacing:-.055em;line-height:.92}
  .volt-button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border:1px solid var(--ink);background:var(--ink);color:var(--paper);padding:.8rem 1.1rem;text-decoration:none}.volt-button-ghost{margin-left:.75rem;border-color:currentColor;background:transparent;color:inherit}
  .volt-proof{padding:1rem 1.25rem;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-family:var(--font-body);font-size:.75rem;letter-spacing:.05em}
  .volt-empty{padding:2rem;overflow-wrap:anywhere}
  @media(max-width:720px){.volt-display{letter-spacing:-.04em}}
`;

export const VOLT_RECIPE_CONFIG = {
  templateId: "volt",
  templateVersion: 1,
  concept: {
    name: "Volt",
    rationale: "A premium product catalog organized as an honest system-planning surface, led by a cinematic product silhouette.",
    noveltySignature: ["rim-lit-silhouette", "system-planner", "live-product-comparison"],
  },
  designSystem: {
    displayFontId: "space-grotesk",
    bodyFontId: "ibm-plex-mono",
    tokens: {
      ink: "#0a0b0d",
      panel: "#15181d",
      paper: "#f2f3ef",
      signal: "#b7ff3c",
      muted: "#9ba2aa",
      line: "#333941",
      "space-system": "24px",
    },
    breakpoints: { compact: 720, wide: 1240 },
    iconStyle: "precision line diagrams with channel and battery marks",
    motionStyle: "measured system reveals with static reduced-motion fallback",
    globalCss: ".volt-product-copy{box-sizing:border-box;width:40%;max-width:40%;min-width:0;overflow-wrap:anywhere}@media(max-width:720px){.volt-product-copy{width:auto;max-width:none}}",
  },
  archetype: {
    composition: "system-architecture",
    hero: "cinematic-rim-hero",
    scroll: "system-sequence",
    cards: "spec-modules",
    iconography: ["precision line diagrams", "channel and battery marks"],
  },
  surfaces: {
    shell: {
      signature: "technical masthead with system navigation, catalog search, and protected cart drawer",
      source: route(`
        <header class="volt-masthead">
          <a class="volt-wordmark" data-cd-route="home"><span data-cd-text="store.name"></span></a>
          <nav aria-label="Main navigation">
            <a data-cd-route="collections">Systems</a><a data-cd-route="collection">Catalog</a><a data-cd-route="story">Engineering</a>
          </nav>
          <div class="volt-utilities"><a data-cd-route="search">Search</a><a data-cd-route="cart">Cart <span data-cd-text="cart.count"></span></a></div>
        </header>
        <aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="ink paper signal"></aside>
        <footer class="volt-footer"><span data-cd-text="store.name"></span><nav data-cd-policy-links></nav></footer>
      `, `
        .volt-masthead{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:1.5rem;min-height:64px;padding:.75rem 1.25rem;background:var(--ink);color:var(--paper);border-bottom:1px solid var(--line)}
        .volt-masthead nav,.volt-utilities{display:flex;gap:1.25rem}.volt-utilities{justify-content:flex-end}.volt-masthead a,.volt-footer a{color:inherit;text-decoration:none}.volt-masthead nav a{display:inline-flex;min-height:44px;align-items:center}.volt-wordmark{font-family:var(--font-display);font-size:1.25rem;font-weight:700;letter-spacing:.08em}.volt-footer{display:flex;justify-content:space-between;gap:2rem;padding:2rem;background:var(--ink);color:var(--paper)}
        @media(max-width:720px){.volt-masthead{grid-template-columns:1fr auto}.volt-masthead nav{grid-column:1/-1;overflow:auto}.volt-utilities a:first-child{display:none}}
      `),
    },
    home: {
      signature: "rim-lit cinematic hero flowing into live product comparison and a protected three-piece builder",
      source: route(`
        <main class="volt-page volt-home">
          <section class="volt-hero-fallback" aria-label="Premium product silhouette in a dark studio">
            <img class="volt-hero-image" data-cd-asset="hero" alt="Premium product silhouette in a dark studio" width="1600" height="900">
            <div class="volt-hero-orbit" aria-hidden="true"></div>
            <div class="volt-hero-copy" ${motionAttributes("reveal")}>
              <span class="volt-kicker">Live catalog / product-by-product planning</span>
              <h1 class="volt-display"><span class="volt-hero-line">Choose the pieces.</span><span class="volt-hero-line">Build the system.</span></h1>
              <p>Plan a setup from the products, prices, options, and availability in this store right now.</p>
              <a class="volt-button" data-cd-route="collection">Explore the system</a><a class="volt-button volt-button-ghost" data-cd-route="collections">Collection discovery</a>
            </div>
          </section>
          <section class="volt-collection-hooks" ${motionAttributes("reveal")}><header><span class="volt-kicker">Collection discovery</span><h2 class="volt-display">Pick the entry point.</h2><p>Route shoppers into current collections or search without inventing categories.</p></header><div class="volt-collection-hook-grid"><a data-cd-route="collections"><span>Systems index</span><b>Browse collection paths</b></a><a data-cd-route="collection"><span>Live collection</span><b>Filter and sort products</b></a><a data-cd-route="search"><span>Search recovery</span><b>Find a component</b></a></div></section>
          ${catalogProof.html}
          <section class="volt-catalog" ${motionAttributes("reveal")}>
            <header><span class="volt-kicker">Live catalog modules</span><h2 class="volt-display">Choose the components.</h2></header>
            <div class="volt-product-grid" data-cd-repeat="featured.products">
              <article class="volt-product-module" data-cd-key="product.id">
                <a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="720"><h3 data-cd-text="product.title"></h3></a>
                <p data-cd-text="product.description"></p><div class="volt-product-meta"><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></div>
              </article>
            </div>
            <p class="volt-empty" data-cd-empty-state>No products are available in this system yet.</p>
          </section>
          <section class="volt-compare" ${motionAttributes("scroll-progress")}>
            <header><span class="volt-kicker">Live catalog evidence</span><h2 class="volt-display">Compare live products.</h2><p>Compare current price and availability here; open a product for its merchant-supplied options and full details.</p></header>
            <div class="volt-compare-rail" data-cd-repeat="featured.products"><article class="volt-compare-row" data-cd-key="product.id"><span data-cd-text="product.title"></span><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">View product details</a></article></div>
          </section>
          <section class="volt-planner-intro" ${motionAttributes("pinned")}><header><span class="volt-kicker">Ecosystem builder</span><h2 class="volt-display">Build a three-piece setup.</h2><p>Choose any three live products, including the same product more than once. The protected builder verifies current variants, prices, and availability before adding the complete setup.</p></header></section>
        </main>
        <section data-cd-slot="bundleBuilder" data-cd-bundle-slots="3" data-cd-host-size="block" data-cd-theme-tokens="ink paper signal"></section>
      `, `${sharedRouteCss}
        .volt-hero-fallback{position:relative;display:grid;min-height:min(820px,88dvh);align-items:end;overflow:hidden;padding:clamp(1.5rem,6vw,6rem);background:radial-gradient(circle at 72% 44%,rgba(183,255,60,.18),transparent 8%),radial-gradient(ellipse at 72% 48%,#4b515b 0,#20242a 18%,#0a0b0d 52%);color:var(--paper)}
        .volt-hero-image{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.volt-hero-fallback:after{content:"";position:absolute;inset:9% 8% 9% 57%;border:1px solid rgba(242,243,239,.22);border-radius:48% 48% 42% 42%;box-shadow:0 0 70px rgba(183,255,60,.12)}.volt-hero-orbit{position:absolute;width:52vw;height:52vw;right:-9vw;top:4%;border:1px solid rgba(242,243,239,.12);border-radius:50%}.volt-hero-copy{position:relative;z-index:1;max-width:44rem}.volt-hero-copy h1{font-size:clamp(4rem,10vw,6rem);margin:.5rem 0}.volt-hero-line{display:block}.volt-hero-copy p{max-width:38rem;font-size:1.05rem;line-height:1.6}
        .volt-collection-hooks,.volt-catalog,.volt-compare,.volt-planner-intro{padding:clamp(3rem,7vw,7rem) clamp(1rem,4vw,4rem)}.volt-collection-hooks header,.volt-catalog header,.volt-compare header,.volt-planner-intro header{max-width:64rem;margin-bottom:2rem}.volt-collection-hooks h2,.volt-catalog h2,.volt-compare h2,.volt-planner-intro h2{font-size:clamp(3rem,7vw,7rem);margin:.5rem 0}.volt-product-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}.volt-product-module{display:grid;gap:1rem;padding:1rem;background:var(--paper)}.volt-product-module img{width:100%;aspect-ratio:1;object-fit:cover;background:var(--panel)}.volt-product-module a{color:inherit;text-decoration:none}.volt-product-module h3{font-size:1.4rem}.volt-product-meta{display:flex;justify-content:space-between;gap:1rem;font-family:var(--font-body);font-size:.78rem}.volt-collection-hook-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}.volt-collection-hook-grid a{display:grid;gap:.75rem;min-height:180px;padding:1rem;background:var(--paper);color:inherit;text-decoration:none}
        .volt-compare{background:var(--ink);color:var(--paper)}.volt-compare-rail{display:grid;border-top:1px solid var(--line)}.volt-compare-row{display:grid;grid-template-columns:1.5fr 2fr 1fr 1fr auto;gap:1rem;align-items:center;min-height:70px;border-bottom:1px solid var(--line);font-family:var(--font-body)}.volt-compare-rail a{color:var(--signal)}
        @media(max-width:720px){.volt-hero-fallback{min-height:76dvh}.volt-hero-fallback:after{inset:14% -20% 18% 46%}.volt-product-grid,.volt-collection-hook-grid{grid-template-columns:1fr}.volt-compare-row{grid-template-columns:1fr 1fr}.volt-compare-row a{grid-column:1/-1;min-height:44px}}
        @media(prefers-reduced-motion:reduce){.volt-hero-orbit{transform:none}.volt-hero-copy,.volt-catalog,.volt-compare,.volt-planner-intro{animation:none;transition:none;scroll-behavior:auto}}
      `),
    },
    collections: {
      signature: "collection index with live merchant product signals and clear catalog destinations",
      source: route(`
        <main class="volt-page volt-directory"><header><span class="volt-kicker">Catalog directory / collection discovery</span><h1 class="volt-display">Choose a system path.</h1><p>Start with the merchant's current collection records. Each path remains bound to the live catalog.</p></header><section class="volt-collection-index-grid" data-cd-repeat="featured.collections"><article data-cd-key="collection.id"><span class="volt-kicker">Live collection</span><h2 data-cd-text="collection.title"></h2><a class="volt-button" data-cd-route="collection" data-cd-param-handle="collection.handle">Open collection</a></article></section><p class="volt-empty" data-cd-empty-state>No collection records are available.</p></main>
      `, `${sharedRouteCss}.volt-directory>header{padding:clamp(3rem,8vw,8rem);background:var(--ink);color:var(--paper)}.volt-directory h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.volt-directory-routes{display:flex;flex-wrap:wrap;gap:.75rem}.volt-collection-index-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}.volt-collection-index-grid article{display:grid;gap:.8rem;padding:1.25rem;background:var(--paper)}@media(max-width:720px){.volt-collection-index-grid{grid-template-columns:1fr}}`),
    },
    collection: {
      signature: "architectural collection matrix with live title, price, and availability evidence",
      source: route(`
        <main class="volt-page volt-collection"><header><nav class="volt-breadcrumbs" aria-label="Collection hierarchy"><a data-cd-route="collections">Systems</a><span>/</span><span data-cd-text="collection.title"></span></nav><span class="volt-kicker">Live collection</span><h1 class="volt-display" data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p><b><span data-cd-text="collection.productCount"></span> products</b></header><nav class="volt-sibling-nav" aria-label="Sibling systems"><span>Sibling systems</span><a data-cd-route="collection">All products</a><a data-cd-route="collection">Available now</a><a data-cd-route="collection">Price scan</a></nav><section class="volt-collection-tools" aria-label="Collection controls"><div><span class="volt-kicker">Filter by merchant data</span><button value="" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">All</button><button value="true" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">Available</button></div><label>Sort <select aria-label="Sort live products" data-cd-on="change" data-cd-action="collection.sort"><option value="featured">System order</option><option value="price_asc">Price low</option><option value="price_desc">Price high</option><option value="title_asc">Title A-Z</option></select></label><p class="volt-applied-state">Applied signal: current collection controls update the live result set.</p></section><section class="volt-collection-grid" data-cd-repeat="collection.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="720"><h2 data-cd-text="product.title"></h2></a><p data-cd-text="product.description"></p><div class="volt-product-meta"><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></div><a data-cd-route="product" data-cd-param-handle="product.handle">Inspect full product record</a></article></section><p class="volt-empty" data-cd-empty-state>No products match the current collection controls.</p></main><section data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="ink paper signal"></div></section>
      `, `${sharedRouteCss}.volt-collection>header{padding:clamp(3rem,7vw,7rem);background:var(--ink);color:var(--paper)}.volt-collection h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.volt-sibling-nav,.volt-collection-tools{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;padding:1rem;border-bottom:1px solid var(--line)}.volt-sibling-nav a,.volt-breadcrumbs a{color:inherit}.volt-collection-tools button,.volt-collection-tools select{min-height:44px;border:1px solid var(--ink);background:transparent;padding:.6rem}.volt-applied-state{margin-left:auto}.volt-collection-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line)}.volt-collection-grid article{display:grid;gap:.8rem;padding:1rem;background:var(--paper)}.volt-collection-grid img{width:100%;aspect-ratio:1;object-fit:cover;background:var(--panel)}.volt-collection-grid a{color:inherit;text-decoration:none}@media(max-width:720px){.volt-collection-grid{grid-template-columns:1fr}}`, "collection"),
    },
    product: {
      signature: "cinematic product runway beside variant evidence and adjacent protected purchase hosts",
      source: route(`
        <main class="volt-product">
          <section class="volt-product-gallery"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="1000" height="1000"><div data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="720"></div><div class="volt-detail-fallback" role="img" aria-label="Abstract close view of product materials"></div></section>
          <article class="volt-product-dossier"><div class="volt-product-copy"><span class="volt-kicker">Product / live specification</span><h1 class="volt-display" data-cd-text="product.title"></h1><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><p data-cd-text="product.description"></p>${catalogProof.html}<section class="volt-facts"><h2>Merchant-supplied facts</h2><dl data-cd-repeat="product.facts"><div class="volt-fact" data-cd-key="fact.id"><dt data-cd-text="fact.label"></dt><dd data-cd-text="fact.value"></dd><a data-cd-href="fact.url">Open merchant reference</a></div></dl></section><h2>Available configurations</h2><div class="volt-variants" data-cd-repeat="product.variants"><div class="volt-variant" data-cd-key="variant.id"><b data-cd-text="variant.title"></b><span data-cd-text="variant.availability"></span><strong data-cd-money="variant.price"></strong></div></div><aside class="volt-policy-reassurance"><b>Store policies</b><p>Review the merchant policy links before checkout; final totals and fulfillment details stay in protected commerce.</p><nav data-cd-policy-links></nav></aside><section class="volt-related"><h2>Related discovery</h2><div class="volt-related-rail" data-cd-repeat="related.products"><article class="volt-related-card" data-cd-key="product.id"><h3 data-cd-text="product.title"></h3><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><a data-cd-route="product" data-cd-param-handle="product.handle">Open related product</a></article></div></section></div></article><section><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink paper signal"></div><div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink paper signal"></div></section>
        </main>
      `, `${sharedRouteCss}.volt-product-gallery{position:sticky;top:0;float:left;display:grid;width:60%;gap:1px;background:var(--line)}.volt-product-gallery>img,.volt-product-gallery>div img{width:100%;aspect-ratio:1;object-fit:cover}.volt-detail-fallback{min-height:280px;background:radial-gradient(circle at 54% 46%,rgba(183,255,60,.18),transparent 10%),linear-gradient(135deg,#282e35,#0a0b0d)}.volt-product-copy{display:grid;gap:1.25rem;min-height:100dvh;margin-left:60%;padding:clamp(1.5rem,4vw,4rem);background:var(--paper)}.volt-product-copy h1{font-size:clamp(3.2rem,6vw,6rem);margin:.4rem 0}.volt-facts dl,.volt-facts dd{margin:0}.volt-fact,.volt-variant{display:grid;grid-template-columns:1fr auto;gap:.35rem 1rem;padding:.7rem 0;border-top:1px solid var(--line)}.volt-facts a{grid-column:1/-1;color:inherit}.volt-variants{display:grid;border-top:1px solid var(--line)}.volt-policy-reassurance,.volt-related{padding:1rem;border:1px solid var(--line)}.volt-related-rail{display:grid;gap:.75rem}.volt-related-card{padding:.75rem;border-top:1px solid var(--line)}@media(max-width:720px){.volt-product-gallery{position:static;float:none;width:auto}.volt-product-copy{min-height:auto;margin-left:0}}@media(prefers-reduced-motion:reduce){.volt-product-gallery{scroll-behavior:auto}}`, "product"),
    },
    search: {
      signature: "dark command search with live ranked product modules and explicit empty-state recovery",
      source: route(`
        <main class="volt-page volt-search"><header><span class="volt-kicker">Catalog search</span><h1 class="volt-display">Find your next component.</h1><p>Result count updates with matching live products.</p><p>Query <span data-cd-text="search.query"></span></p><div role="search"><input aria-label="Search the catalog" type="search" name="q" value="" placeholder="Product or format" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div></header><section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="320" height="320"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open product</a></article></section><p class="volt-empty" data-cd-empty-state>No products matched. Try a broader product name or return to collection discovery.</p><a class="volt-button" data-cd-route="collections">Browse collection paths</a></main>
      `, `${sharedRouteCss}.volt-search>header{padding:clamp(3rem,8vw,8rem);background:var(--ink);color:var(--paper)}.volt-search h1{max-width:10ch;font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.volt-search input,.volt-search button{min-height:44px;border:1px solid var(--muted);background:transparent;color:inherit;padding:.75rem}.volt-search>section article{display:grid;grid-template-columns:120px 1fr auto auto auto;gap:1rem;align-items:center;padding:1rem;border-bottom:1px solid var(--line)}.volt-search>section img{width:120px;aspect-ratio:1;object-fit:cover}@media(max-width:720px){.volt-search>section article{grid-template-columns:80px 1fr}.volt-search>section article>*:not(img):not(h2){grid-column:2}}`, "search"),
    },
    story: {
      signature: "engineering manifesto with quiet signal diagrams and merchant-owned policy evidence",
      source: route(`
        <main class="volt-page volt-story"><header><span class="volt-kicker">Engineering / product before promise</span><h1 class="volt-display">Plan with the facts available.</h1><p><span data-cd-text="store.name"></span> presents each live product as part of a clear planning path.</p></header><section><article><b>Inspect</b><h2>Begin with the live record.</h2><p>Choose from current products without inventing performance or availability claims.</p></article><article><b>Plan</b><h2>Compare what is known.</h2><p>Live catalog facts stay close to every path into purchase.</p></article><article><b>Support</b><h2>Keep the handoff clear.</h2><p>Review this store's policies before purchase.</p></article></section><a class="volt-button" data-cd-route="collection">Explore current products</a></main><nav data-cd-policy-links></nav>
      `, `${sharedRouteCss}.volt-story{padding:clamp(3rem,8vw,8rem)}.volt-story>header{max-width:72rem;padding:clamp(2rem,6vw,6rem);background:radial-gradient(circle at 70% 45%,#39413d,var(--ink) 50%);color:var(--paper)}.volt-story h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.volt-story>section{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:5rem 0;background:var(--line)}.volt-story article{min-height:280px;padding:1.5rem;background:var(--paper)}@media(max-width:720px){.volt-story>section{grid-template-columns:1fr}}`),
    },
    cart: {
      signature: "system rack cart ledger with trusted line controls, live totals, and checkout handoff",
      source: route(`
        <main class="volt-page volt-cart"><header><span class="volt-kicker">System rack / cart</span><h1 class="volt-display">Your selected products.</h1><span><b data-cd-text="cart.count"></b> items</span><span>Live subtotal <b data-cd-money="cart.subtotal"></b></span></header><section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><span>Quantity <b data-cd-text="cartLine.quantity"></b></span><span data-cd-money="cartLine.unitPrice"></span><strong data-cd-money="cartLine.total"></strong></article></section><aside><span>Subtotal</span><b data-cd-money="cart.subtotal"></b><span>Total</span><strong data-cd-money="cart.total"></strong></aside><section class="volt-cart-reassurance"><h2>Checkout handoff</h2><p>Line edits, taxes, fulfillment, payment, and final totals are resolved by protected Calderyn commerce.</p><nav data-cd-policy-links></nav></section><p class="volt-empty" data-cd-empty-state>Your cart is empty. <a data-cd-route="collection">Browse the live catalog</a>.</p></main><section data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls" data-cd-host-size="inline"></div></section><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="ink paper signal"></div>
      `, `${sharedRouteCss}.volt-cart>header{padding:clamp(3rem,7vw,7rem);background:var(--ink);color:var(--paper)}.volt-cart h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.volt-cart>section article{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:1rem;align-items:center;padding:1.25rem;border-bottom:1px solid var(--line)}.volt-cart>aside{display:grid;grid-template-columns:1fr auto;gap:1rem;max-width:34rem;margin:2rem 2rem 2rem auto}.volt-cart-reassurance{margin:2rem;padding:1.25rem;border:1px solid var(--line)}@media(max-width:720px){.volt-cart>section article{grid-template-columns:1fr 1fr}}`, "cart"),
    },
    checkout: {
      signature: "restrained secure checkout frame with system continuity and platform-owned order summary",
      source: {
        html: `<section class="volt-checkout-frame"><header class="volt-checkout"><span>Encrypted handoff</span><h1 data-cd-text="store.name"></h1><p>Your live cart, pricing, delivery, and payment remain controlled by the platform through checkout.</p></header><aside class="volt-checkout-proof"><b>System continuity</b><span>Selected variants retained</span><span>Final totals shown by checkout</span></aside><footer data-cd-policy-links></footer></section>`,
        css: `.volt-checkout{padding:48px;max-width:760px}.volt-checkout h1{font-size:64px}.volt-checkout-proof{display:grid;gap:12px;padding:32px;border-left-width:1px;border-style:solid;border-color:var(--line)}`,
        layout: {
          columnMode: "summaryAside",
          sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
          spacingTokenId: "space-system",
          surfaceTokenIds: ["paper", "ink", "signal"],
        },
      },
    },
    notFound: {
      signature: "lost-signal recovery panel routing shoppers back to live systems, search, and support policies",
      source: route(`
        <main class="volt-page volt-lost"><span class="volt-kicker">Signal unavailable</span><h1 class="volt-display">This channel is quiet.</h1><p>The requested page is not in the current storefront. Reconnect through the live catalog or search.</p><nav><a class="volt-button" data-cd-route="collection">Browse all products</a><a data-cd-route="search">Search the catalog</a></nav></main>
      `, `${sharedRouteCss}.volt-lost{display:grid;align-content:center;min-height:72dvh;padding:clamp(2rem,8vw,8rem);background:radial-gradient(circle at 80% 50%,#343b43,var(--ink) 38%);color:var(--paper)}.volt-lost h1{max-width:9ch;font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.volt-lost nav{display:flex;align-items:center;gap:1.25rem}.volt-lost nav a{color:inherit}`),
    },
  },
  assets: VOLT_ASSETS,
} satisfies RecipeConfig<"volt">;

export const VOLT_RECIPE = compileRecipeConfig(VOLT_RECIPE_CONFIG);
export const VOLT_BUNDLE = VOLT_RECIPE.bundle;
