import { defineRecipe, type RecipeConfig } from "../factory";
import { CUSTOM_BENCH_ASSETS } from "./assets";

const shell = {
  html: `
    <header class="workshop-shell">
      <a class="brand-mark" data-cd-route="home"><span class="niche-icon niche-icon--bench" aria-hidden="true">&#9638;</span><span data-cd-text="store.name"></span><b>Custom Bench</b></a>
      <nav class="workshop-nav" aria-label="Primary navigation">
        <a data-cd-route="collection">Objects</a>
        <a data-cd-route="search">Search</a>
        <a data-cd-route="account">Account</a>
        <a data-cd-route="cart">Cart <span data-cd-text="cart.count"></span></a>
      </nav>
      <div id="cart-drawer" data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="ink cobalt paper"></div>
    </header>
    <footer class="workshop-footer"><span data-cd-text="store.name"></span><nav data-cd-policy-links></nav></footer>
  `,
  css: `
    .brand-mark { color: var(--ink); font-family: var(--font-display); font-size: 1.4rem; font-weight: 700; text-decoration: none }
    .brand-mark b { color: var(--signal); display: block; font-family: var(--font-body); font-size: .65rem; letter-spacing: .12em; text-transform: uppercase }
    .workshop-nav { display: flex; gap: 1.4rem; font-family: var(--font-body); font-size: .72rem; text-transform: uppercase }
    .workshop-nav a { color: var(--ink); text-decoration: none }
    .workshop-footer span { font-family: var(--font-display); font-weight: 700 }
    @media(max-width:720px){.workshop-nav{max-width:100%;overflow-x:auto;padding-bottom:.45rem}.workshop-nav a{min-width:max-content}}
  `,
  requiredData: [],
  requiredCapabilities: [],
};

const home = {
  html: `
    <main class="bench-home">
      <section class="bench-hero">
        <div class="bench-copy">
          <small>Made to order</small>
          <h1>Your mark, made real.</h1>
          <p class="recipe-copy">Choose the object, set the material, place your mark, then approve the workshop proof.</p>
          <a class="primary-action" data-cd-route="collection">Choose an object</a>
        </div>
        <figure class="proof-stage"><img data-cd-asset="hero" alt="Personalized object on the Custom Bench worktable"><figcaption>Live workshop proof</figcaption></figure>
      </section>
      <section id="configurator" class="configurator" data-cd-state-id="bench-step" data-cd-state-type="enum" data-cd-state-initial="choose" data-cd-state-values="choose personalize approve" data-cd-bind-state="bench-step" data-cd-bind-property="classToken">
        <h2>Build the commission</h2>
        <div class="step-rail">
          <button value="choose" data-cd-on="click" data-cd-action="state.set" data-cd-state="bench-step">Choose the piece</button>
          <button value="personalize" data-cd-on="click" data-cd-action="state.set" data-cd-state="bench-step">Set your mark</button>
          <button value="approve" data-cd-on="click" data-cd-action="state.set" data-cd-state="bench-step">Approve your proof</button>
        </div>
      </section>
      <section class="featured"><h2>Objects on the bench</h2><div class="specimen-grid" data-cd-repeat="featured.products">
        <article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" loading="lazy"><h3 data-cd-text="product.title"></h3><p data-cd-money="product.price"></p><a data-cd-route="product" data-cd-param-handle="product.handle">Configure</a></article>
      </div></section>
      <section data-cd-repeat="featured.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink cobalt paper"></aside></section>
      <button data-cd-on="click" data-cd-action="scroll.to" data-cd-target="configurator">Return to configuration</button>
    </main>
  `,
  css: `
    .bench-hero { display: grid; grid-template-columns: minmax(0, .82fr) minmax(0, 1.18fr); min-height: 42rem; border-bottom: 1px solid var(--rule) }
    .bench-copy { align-content: center; display: grid; padding: clamp(2rem, 6vw, 6rem) }
    .bench-copy h1 { font-family: var(--font-display); font-size: clamp(4rem, 9vw, 8.5rem); line-height: .78; margin: .5rem 0; text-transform: uppercase }
    .bench-copy p { max-width: 34rem }
    .proof-stage img { aspect-ratio: 2 / 1; height: 100%; object-fit: cover }
    .proof-stage figcaption { background: var(--cobalt); color: var(--paper); font-family: var(--font-body); padding: .7rem }
    .configurator h2, .featured h2 { font-family: var(--font-display); font-size: clamp(2.5rem, 5vw, 5rem); text-transform: uppercase }
    .step-rail { display: grid; grid-template-columns: repeat(3, 1fr) }
    .step-rail button { background: var(--paper); border: 1px solid var(--rule); min-height: 5rem }
    .configurator[data-cd-class-token="choose"] { border-top: 5px solid var(--cobalt) }
    .configurator[data-cd-class-token="personalize"] { border-top: 5px solid var(--signal) }
    .configurator[data-cd-class-token="approve"] { border-top: 5px double var(--ink) }
    .specimen-grid { display: grid; grid-template-columns: repeat(4, 1fr) }
    .specimen-grid img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }
    .configurator { scroll-margin-top:2rem }
    @media(prefers-reduced-motion:reduce){.configurator{scroll-margin-top:0}}
    .specimen-grid h3 { font-family: var(--font-display); text-transform: uppercase }
    @media (max-width: 760px) { .bench-hero { grid-template-columns: 1fr; min-height: 0 } .step-rail { grid-template-columns: 1fr } .specimen-grid { grid-template-columns: 1fr 1fr } }
  `,
  requiredData: [],
  requiredCapabilities: [],
};

const collection = {
  html: `
    <main class="workshop-catalog">
      <header class="catalog-intro"><small>Material specimen index</small><h1 data-cd-text="collection.title"></h1><p class="recipe-copy" data-cd-text="collection.description"></p><img data-cd-src="collection.image" data-cd-alt="collection.title"></header>
      <aside class="filters" aria-label="Workshop filters">
        <button value="leather" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Leather</button>
        <button value="paper" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Paper</button>
        <button value="true" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">Ready soon</button>
        <button value="price_asc" data-cd-on="click" data-cd-action="collection.sort">Sort by price</button>
      </aside>
      <section class="catalog-grid" data-cd-repeat="collection.products">
        <article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" loading="lazy"><h2 data-cd-text="product.title"></h2><p data-cd-money="product.price"></p><small data-cd-text="product.availability"></small><a data-cd-route="product" data-cd-param-handle="product.handle">Open work order</a><div data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="ink cobalt paper"></div></article>
      </section>
      <p class="empty-state">No objects match these workshop filters. Clear a material filter to reopen the bench.</p>
    </main>
  `,
  css: `
    .catalog-intro { display: grid; grid-template-columns: 1fr 1fr; min-height: 20rem }
    .catalog-intro h1 { font-family: var(--font-display); font-size: clamp(4rem, 9vw, 8rem); line-height: .8; text-transform: uppercase }
    .catalog-intro img { height: 20rem; object-fit: cover; width: 100% }
    .filters { display: flex; gap: .5rem; overflow-x: auto; padding: 1rem }
    .filters button { background: transparent; border: 1px solid var(--rule); padding: .75rem 1rem }
    .catalog-grid img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }
    .catalog-grid h2 { font-family: var(--font-display); text-transform: uppercase }
    .empty-state { border: 1px dashed var(--rule); padding: 2rem; text-align: center }
    @media (max-width: 760px) { .catalog-intro { grid-template-columns: 1fr } .catalog-intro img { height: 14rem } }
  `,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "collection" as const,
};

const product = {
  html: `
    <main class="work-order">
      <section id="gallery" class="product-gallery"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><div data-cd-repeat="product.images"><figure data-cd-key="product.primaryImage"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"></figure></div></section>
      <section class="purchase-sheet"><small>Workshop work order</small><h1 data-cd-text="product.title"></h1><p data-cd-money="product.price"></p><b data-cd-text="product.availability"></b><p class="recipe-copy" data-cd-text="product.description"></p><p>Sold out pieces remain visible with their workshop notes, but cannot be added.</p>
        <div class="variant-ledger" data-cd-repeat="product.variants"><span data-cd-key="variant.id" data-cd-text="variant.title"></span></div>
        <div id="variant-ledger" data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink cobalt paper"></div>
        <div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink signal paper"></div>
      </section>
      <section class="related" data-cd-repeat="related.products"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><a data-cd-route="product" data-cd-param-handle="product.handle">Continue the collection</a></article></section>
    </main>
  `,
  css: `
    .product-gallery img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }
    .product-gallery button { background: transparent; border: 1px solid var(--rule); padding: .25rem }
    .purchase-sheet h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 7vw, 7rem); line-height: .82; text-transform: uppercase }
    .purchase-sheet p { max-width: 42rem }
    .variant-ledger span { background: transparent; border: 1px solid var(--rule); display:inline-block; padding: .75rem }
    .related img { aspect-ratio: 1 / 1; object-fit: cover; width: 100% }
  `,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "product" as const,
};

const search = {
  html: `
    <main class="search-bench">
      <header><small>Search the workshop</small><h1>Find an object to mark.</h1><p data-cd-text="search.query"></p></header>
      <div class="query-controls" role="search"><span>Workshop query</span><input aria-label="Workshop query" type="search" name="q" value="" placeholder="Object, material, or occasion" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div>
      <section class="ranked-results" data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><p data-cd-money="product.price"></p><a data-cd-route="product" data-cd-param-handle="product.handle">Open result</a></article></section>
      <p class="empty-state">No workshop results yet. Try an object, material, or occasion.</p>
    </main>
  `,
  css: `
    .search-bench h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 8vw, 7rem); text-transform: uppercase }
    .query-controls { display: flex; gap: .5rem }
    .query-controls input, .query-controls button { background: transparent; border: 1px solid var(--rule); padding: .8rem 1rem }
    .ranked-results { display: grid; grid-template-columns: repeat(3, 1fr) }
    .ranked-results img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }
    @media (max-width: 760px) { .ranked-results { grid-template-columns: 1fr } }
  `,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "search" as const,
};

const cart = {
  html: `
    <main class="commission-cart"><header><small>Workshop queue</small><h1>Your commission</h1><p><span data-cd-text="cart.count"></span> objects awaiting approval</p></header>
      <section class="cart-ledger" data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><p data-cd-text="cartLine.quantity"></p><p data-cd-money="cartLine.unitPrice"></p><p data-cd-money="cartLine.total"></p><div data-cd-slot="cartLineControls" data-cd-host-size="inline" data-cd-theme-tokens="ink cobalt paper"></div></article></section>
      <p class="empty-state">Your commission is empty. Choose an object to begin a proof.</p>
      <aside data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="ink signal paper"></aside>
    </main>
  `,
  css: `
    .commission-cart h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 8vw, 7rem); text-transform: uppercase }
    .cart-ledger h2 { font-family: var(--font-display); text-transform: uppercase }
    .cart-ledger p { font-family: var(--font-body) }
    .empty-state { border: 1px dashed var(--rule); padding: 2rem }
  `,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "cart" as const,
};

const checkout = {
  html: `<header class="checkout-mark"><small>Secure workshop checkout</small><h1 data-cd-text="store.name"></h1><p>Your approved choices continue into the trusted contact, delivery, payment, and order summary flow.</p></header><aside class="checkout-note"><b>Proof included</b><p>Production starts only after proof approval.</p></aside><footer data-cd-policy-links></footer>`,
  css: `.checkout-mark { padding: 48px; background-color: var(--paper); color: var(--ink) } .checkout-mark h1 { font-family: var(--font-display); font-size: 56px; line-height: .9 } .checkout-note { margin: 24px 48px; padding: 18px; border-width: 1px; border-style: solid; border-color: var(--rule) }`,
  layout: {
    columnMode: "summaryAside" as const,
    sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
    spacingTokenId: "space-workshop",
    surfaceTokenIds: ["paper", "ink", "cobalt", "signal"],
  },
} satisfies RecipeConfig<"custom-bench">["surfaces"]["checkout"]["source"];

export const CUSTOM_BENCH_RECIPE = defineRecipe({
  templateId: "custom-bench",
  templateVersion: 1,
  concept: {
    name: "Custom Bench",
    rationale: "A workshop interface turns personalization into a legible proofing sequence.",
    noveltySignature: ["step configurator", "material specimen index", "work-order cart ledger"],
  },
  designSystem: {
    displayFontId: "space-grotesk",
    bodyFontId: "ibm-plex-mono",
    tokens: { paper: "#eee9dd", ink: "#11100e", cobalt: "#2148ff", signal: "#b83a29", rule: "#746f65" },
    breakpoints: { mobile: 760, wide: 1180 },
    iconStyle: "square workshop glyphs and dimension-line indicators",
    motionStyle: "guided proof steps with restrained horizontal specimen rails",
    globalCss: `.recipe-copy { overflow-wrap: anywhere }`,
  },
  archetype: {
    composition: "workshop-configurator",
    hero: "configurator-workbench",
    scroll: "guided-steps",
    cards: "material-specimen-grid",
    iconography: ["square workshop glyphs", "dimension-line indicators"],
  },
  surfaces: {
    shell: { signature: "three-part workshop masthead with trusted cart drawer", source: shell },
    home: { signature: "split proofing workbench followed by guided personalization steps", source: home },
    collection: { signature: "material filter rail beside an object specimen matrix", source: collection },
    product: { signature: "image proof board paired with variant and personalization work order", source: product },
    search: { signature: "large workshop query header above ranked object sheets", source: search },
    cart: { signature: "commission queue ledger with line controls and approval summary", source: cart },
    checkout: { signature: "workshop assurance notes framing a summary-aside trusted checkout", source: checkout },
  },
  assets: CUSTOM_BENCH_ASSETS,
} satisfies RecipeConfig<"custom-bench">);

export const CUSTOM_BENCH_BUNDLE = CUSTOM_BENCH_RECIPE.bundle;
