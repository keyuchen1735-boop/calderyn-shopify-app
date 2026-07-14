import { defineRecipe, type RecipeConfig } from "../factory";
import type { RouteSource } from "../../storefront-compiler/compile";
import { ATELIER_GRID_ASSETS } from "./assets";

const routeDefaults: Pick<RouteSource, "requiredData" | "requiredCapabilities"> = {
  requiredData: [],
  requiredCapabilities: [],
};

const globalCss = `
.atelier-wordmark { color:#161615; font-family:var(--font-display); font-size:1.8rem; font-weight:800; letter-spacing:-.025em; text-transform:uppercase }
.atelier-nav { display:flex; align-items:center; gap:1.75rem; min-height:4.25rem; border-bottom:1px solid #161615 }
.atelier-nav-links { display:flex; align-items:center; gap:1.35rem; margin-left:auto; font-family:var(--font-display); font-size:.78rem; letter-spacing:.08em; text-transform:uppercase }
.atelier-link { color:#161615; text-decoration:none }
.atelier-link:hover { color:#d63821 }
.atelier-heading { margin:0; color:#161615; font-family:var(--font-display); font-weight:800; letter-spacing:-.035em; line-height:.88; text-transform:uppercase }
.atelier-serif { color:#34322f; font-family:var(--font-body); line-height:1.45 }
.atelier-price { font-family:var(--font-display); font-size:.85rem; letter-spacing:.04em }
.atelier-media { display:block; width:100%; object-fit:cover }
.atelier-rule { border-bottom:1px solid #2a2927 }
.atelier-action { display:inline-flex; align-items:center; gap:.8rem; color:#d63821; font-family:var(--font-display); font-weight:700; letter-spacing:.08em; text-decoration:none; text-transform:uppercase }
.atelier-action:active { transform:translateY(1px) }
@media (max-width:760px) {
  .atelier-nav { flex-wrap:wrap; min-height:3.75rem; padding:.65rem 0 }
  .atelier-nav-links { width:100%; gap:1rem; margin-left:0; overflow-x:auto }
}
`;

const homeHtml = `
<main>
  <section class="atelier-home-hero">
    <div class="atelier-home-copy">
      <p class="atelier-home-store" data-cd-text="store.name"></p>
      <h1 class="atelier-heading atelier-home-title">Summer Assembly</h1>
      <p class="atelier-serif atelier-home-intro">Uncompromising pieces, considered in form and fabric.</p>
      <a class="atelier-action" data-cd-route="collection">Shop the collection <span>→</span></a>
    </div>
    <figure class="atelier-home-figure">
      <img class="atelier-media atelier-home-image" data-cd-asset="hero" alt="A monochrome tailored look from the summer assembly" width="1800" height="1200" decoding="async">
      <figcaption class="atelier-home-caption">Cut with clarity. Built for repeat wear.</figcaption>
    </figure>
  </section>
  <section class="atelier-home-index">
    <h2 class="atelier-heading atelier-home-index-title">The current edit</h2>
    <article class="atelier-home-card" data-cd-repeat="featured.products">
      <a class="atelier-link" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">
        <img class="atelier-media atelier-home-card-image" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="800" height="1000" loading="lazy">
        <span class="atelier-home-card-title" data-cd-text="product.title"></span>
        <span class="atelier-price" data-cd-money="product.price"></span>
      </a>
    </article>
  </section>
  <section data-cd-repeat="featured.products">
    <div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div>
  </section>
  <section class="atelier-home-manifesto">
    <h2 class="atelier-serif atelier-home-manifesto-title">Designed slowly. Worn without ceremony.</h2>
    <p class="atelier-home-manifesto-copy">A concise wardrobe begins with proportion, movement, and materials selected for a life beyond one season.</p>
  </section>
</main>`;

const homeCss = `
.atelier-home-hero { display:grid; grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr); min-height:42rem; border-bottom:1px solid #161615 }
.atelier-home-copy { display:flex; flex-direction:column; justify-content:space-between; padding:2rem 2.5rem 2rem 0 }
.atelier-home-store { margin:0; color:#d63821; font-family:var(--font-display); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase }
.atelier-home-title { max-width:6ch; font-size:clamp(4.5rem,9vw,9rem) }
.atelier-home-intro { max-width:21ch; margin:0; font-size:1.18rem }
.atelier-home-figure { position:relative; min-height:42rem; margin:0; overflow:hidden }
.atelier-home-image { height:100%; min-height:42rem }
.atelier-home-caption { position:absolute; right:0; bottom:0; max-width:13rem; padding:.8rem; color:#f5f1e9; background:#161615; font-family:var(--font-display); font-size:.68rem; letter-spacing:.08em; text-transform:uppercase }
.atelier-home-index { display:grid; grid-template-columns:minmax(11rem,.55fr) minmax(0,2.45fr); border-bottom:1px solid #161615 }
.atelier-home-index-title { padding:1.25rem 1.5rem 1.25rem 0; font-size:1.1rem }
.atelier-home-card { display:inline-block; width:min(24%,22rem); vertical-align:top; border-left:1px solid #aaa49b }
.atelier-home-index { overflow-x:auto; scroll-snap-type:x proximity }
.atelier-home-card { scroll-snap-align:start }
.atelier-home-card-title { display:block; padding:.8rem .8rem .2rem; font-family:var(--font-display); font-size:.82rem; text-transform:uppercase }
.atelier-home-card-image { aspect-ratio:4 / 5 }
.atelier-home-card .atelier-price { display:block; padding:0 .8rem 1rem }
.atelier-home-manifesto { display:grid; grid-template-columns:1.35fr .65fr; min-height:24rem; background:#d63821 }
.atelier-home-manifesto-title { max-width:11ch; margin:0; padding:3rem; color:#f5f1e9; font-size:clamp(2.5rem,5vw,4.5rem); font-weight:400 }
.atelier-home-manifesto-copy { align-self:end; margin:0; padding:3rem; color:#f5f1e9; font-family:var(--font-display); line-height:1.5 }
@media (max-width:760px) {
  .atelier-home-hero, .atelier-home-index, .atelier-home-manifesto { grid-template-columns:1fr }
  .atelier-home-copy { min-height:28rem; padding:1.5rem 0 }
  .atelier-home-title { font-size:4.5rem }
  .atelier-home-figure, .atelier-home-image { min-height:65vw }
  .atelier-home-card { width:50% }
}
@media (prefers-reduced-motion:reduce) { .atelier-home-index { scroll-snap-type:none } }
`;

const collectionHtml = `
<main>
  <header class="atelier-collection-head">
    <p class="atelier-collection-count"><span data-cd-text="collection.productCount"></span> pieces</p>
    <h1 class="atelier-heading atelier-collection-title" data-cd-text="collection.title"></h1>
    <p class="atelier-serif atelier-collection-description" data-cd-text="collection.description"></p>
    <a class="atelier-action" data-cd-route="home">← Return to the cover</a>
  </header>
  <nav class="atelier-collection-filters" aria-label="Collection filters">
    <button class="atelier-filter" value="all" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">All pieces</button>
    <button class="atelier-filter" value="tailoring" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Tailoring</button>
    <button class="atelier-filter" value="dresses" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Dresses</button>
    <button class="atelier-filter" value="price_asc" data-cd-on="click" data-cd-action="collection.sort">Price ascending</button>
  </nav>
  <section class="atelier-collection-grid">
    <article class="atelier-collection-card" data-cd-repeat="collection.products">
      <a class="atelier-link" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">
        <img class="atelier-media atelier-collection-image" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="900" height="1125" loading="lazy">
        <span class="atelier-collection-name" data-cd-text="product.title"></span>
        <span class="atelier-price" data-cd-money="product.price"></span>
        <span class="atelier-collection-availability" data-cd-text="product.availability"></span>
      </a>
    </article>
  </section>
  <section data-cd-repeat="collection.products">
    <div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div>
  </section>
</main>`;

const collectionCss = `
.atelier-collection-head { display:grid; grid-template-columns:12rem minmax(0,1fr) minmax(14rem,.55fr); gap:2rem; padding:3rem 0 2rem; border-bottom:1px solid #161615 }
.atelier-collection-count { margin:0; color:#d63821; font-family:var(--font-display); font-size:.75rem; letter-spacing:.1em; text-transform:uppercase }
.atelier-collection-title { font-size:clamp(4rem,9vw,8rem) }
.atelier-collection-description { max-width:32ch; margin:0; font-size:1.15rem }
.atelier-collection-filters { position:sticky; top:0; display:flex; gap:1.5rem; padding:1rem 0; background:#f5f1e9; border-bottom:1px solid #161615 }
.atelier-filter { padding:.2rem 0; color:#161615; background:transparent; border:0; font-family:var(--font-display); font-size:.72rem; letter-spacing:.08em; text-transform:uppercase }
.atelier-filter:hover { color:#d63821 }
.atelier-collection-grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)) }
.atelier-collection-card { grid-column:span 4; border-right:1px solid #aaa49b; border-bottom:1px solid #aaa49b }
.atelier-collection-card:nth-child(4n+1) { grid-column:span 5 }
.atelier-collection-card:nth-child(4n+2) { grid-column:span 3 }
.atelier-collection-name, .atelier-collection-card .atelier-price, .atelier-collection-availability { display:block; padding:.7rem .8rem 0 }
.atelier-collection-card .atelier-price { padding-top:.2rem }
.atelier-collection-availability { padding:.2rem .8rem 1rem; color:#706c65; font-family:var(--font-body); font-size:.76rem }
.atelier-collection-image { aspect-ratio:4 / 5 }
@media (max-width:760px) {
  .atelier-collection-head { grid-template-columns:1fr; gap:1rem }
  .atelier-collection-filters { overflow-x:auto }
  .atelier-collection-card, .atelier-collection-card:nth-child(4n+1), .atelier-collection-card:nth-child(4n+2) { grid-column:span 6 }
}
`;

const productHtml = `
<main>
  <a class="atelier-action atelier-product-back" data-cd-route="collection">← Back to the edit</a>
  <section class="atelier-product-media">
    <img class="atelier-media atelier-product-image" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="1200" height="1500">
  </section>
  <section class="atelier-product-copy">
    <p class="atelier-product-availability" data-cd-text="product.availability"></p>
    <h1 class="atelier-heading atelier-product-title" data-cd-text="product.title"></h1>
    <p class="atelier-price atelier-product-price" data-cd-money="product.price"></p>
    <p class="atelier-serif atelier-product-description" data-cd-text="product.description"></p>
  </section>
  <div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink paper accent"></div>
  <div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="ink paper accent"></div>
  <section class="atelier-product-related">
    <h2 class="atelier-heading atelier-product-related-title">Continue the story</h2>
    <article class="atelier-product-related-card" data-cd-repeat="related.products">
      <a class="atelier-link" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">
        <img class="atelier-media" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="720" height="900" loading="lazy">
        <span data-cd-text="product.title"></span>
        <span class="atelier-price" data-cd-money="product.price"></span>
      </a>
    </article>
  </section>
</main>`;

const productCss = `
.atelier-product-back { display:flex; padding:1.25rem 0; border-bottom:1px solid #161615 }
.atelier-product-media { display:inline-block; width:61%; vertical-align:top }
.atelier-product-copy { display:inline-block; width:37%; padding:4rem 2rem 2rem 4rem; vertical-align:top }
.atelier-product-image { max-height:78rem; object-fit:cover }
.atelier-product-availability { margin:0 0 1rem; color:#d63821; font-family:var(--font-display); font-size:.72rem; letter-spacing:.1em; text-transform:uppercase }
.atelier-product-title { font-size:clamp(3.5rem,6vw,6.8rem) }
.atelier-product-price { margin:1.5rem 0 3rem; font-size:1rem }
.atelier-product-description { max-width:38ch; margin:0; font-size:1.15rem }
.atelier-product-related { padding:5rem 0; border-top:1px solid #161615 }
.atelier-product-related-title { margin-bottom:2rem; font-size:2rem }
.atelier-product-related-card { display:inline-block; width:25%; padding-right:1rem; vertical-align:top }
.atelier-product-related-card span { display:block; padding-top:.55rem }
@media (max-width:760px) {
  .atelier-product-media, .atelier-product-copy { display:block; width:100%; padding:1.5rem 0 }
  .atelier-product-related-card { width:50% }
}
`;

const searchHtml = `
<main>
  <header class="atelier-search-head">
    <p class="atelier-search-label">Search the archive</p>
    <h1 class="atelier-heading atelier-search-title">Results for <span data-cd-text="search.query"></span></h1>
    <a class="atelier-action" data-cd-route="home">← Return home</a>
  </header>
  <nav class="atelier-search-tools" aria-label="Search suggestions">
    <input class="atelier-search-input" aria-label="Search the archive" type="search" name="q" value="" placeholder="Piece, fabric, or cut" data-cd-on="input" data-cd-action="search.update">
    <button class="atelier-search-chip" value="submit" data-cd-on="click" data-cd-action="search.submit">Search archive</button>
    <button class="atelier-search-chip" value="clear" data-cd-on="click" data-cd-action="search.clear">Clear query</button>
  </nav>
  <section class="atelier-search-list">
    <article class="atelier-search-result" data-cd-repeat="search.results">
      <a class="atelier-link" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">
        <img class="atelier-media atelier-search-image" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="680" height="850" loading="lazy">
        <span class="atelier-search-name" data-cd-text="product.title"></span>
        <span class="atelier-price" data-cd-money="product.price"></span>
      </a>
    </article>
  </section>
  <section data-cd-repeat="search.results">
    <div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div>
  </section>
</main>`;

const searchCss = `
.atelier-search-head { min-height:22rem; padding:3rem 0; border-bottom:1px solid #161615 }
.atelier-search-label { margin:0 0 2rem; color:#d63821; font-family:var(--font-display); font-size:.72rem; letter-spacing:.1em; text-transform:uppercase }
.atelier-search-title { max-width:10ch; margin-bottom:2.5rem; font-size:clamp(3.5rem,8vw,7rem) }
.atelier-search-tools { display:flex; gap:.75rem; padding:1rem 0; border-bottom:1px solid #161615 }
.atelier-search-chip { padding:.7rem 1rem; color:#161615; background:transparent; border:1px solid #161615; border-radius:0; font-family:var(--font-display); text-transform:uppercase }
.atelier-search-input { min-width:min(28rem,60vw); padding:.7rem 1rem; color:#161615; background:#f5f1e9; border:1px solid #161615; font-family:var(--font-body) }
.atelier-search-chip:hover { color:#f5f1e9; background:#d63821; border-color:#d63821 }
.atelier-search-list { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)) }
.atelier-search-result { border-right:1px solid #aaa49b; border-bottom:1px solid #aaa49b }
.atelier-search-name, .atelier-search-result .atelier-price { display:block; padding:.7rem .8rem 0 }
.atelier-search-result .atelier-price { padding:.2rem .8rem 1rem }
.atelier-search-image { aspect-ratio:4 / 5 }
@media (max-width:760px) {
  .atelier-search-tools { overflow-x:auto }
  .atelier-search-list { grid-template-columns:repeat(2,minmax(0,1fr)) }
}
`;

const cartHtml = `
<main>
  <header class="atelier-cart-head">
    <p class="atelier-cart-count"><span data-cd-text="cart.count"></span> pieces selected</p>
    <h1 class="atelier-heading atelier-cart-title">Your order folio</h1>
    <a class="atelier-action" data-cd-route="collection">Continue shopping →</a>
  </header>
  <section class="atelier-cart-lines">
    <article class="atelier-cart-line" data-cd-repeat="cart.lines">
      <h2 class="atelier-cart-line-title" data-cd-key="cartLine.id" data-cd-text="cartLine.title"></h2>
      <span class="atelier-cart-line-quantity" data-cd-text="cartLine.quantity"></span>
      <span class="atelier-price" data-cd-money="cartLine.total"></span>
      <div data-cd-slot="cartLineControls" data-cd-host-size="block" data-cd-theme-tokens="ink paper accent"></div>
    </article>
  </section>
  <section class="atelier-cart-totals">
    <p>Subtotal <strong data-cd-money="cart.subtotal"></strong></p>
    <p>Discounts <strong data-cd-money="cart.discounts"></strong></p>
    <p class="atelier-cart-total">Total <strong data-cd-money="cart.total"></strong></p>
  </section>
  <div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="ink paper accent"></div>
  <a class="atelier-action atelier-cart-checkout" data-cd-route="checkout">Continue to secure checkout →</a>
</main>`;

const cartCss = `
.atelier-cart-head { display:grid; grid-template-columns:12rem minmax(0,1fr) auto; align-items:end; gap:2rem; padding:4rem 0 2rem; border-bottom:1px solid #161615 }
.atelier-cart-count { color:#d63821; font-family:var(--font-display); font-size:.72rem; letter-spacing:.08em; text-transform:uppercase }
.atelier-cart-title { font-size:clamp(3.5rem,7vw,7rem) }
.atelier-cart-line-title { margin:0; font-family:var(--font-body); font-size:1.45rem; font-weight:400 }
.atelier-cart-line-quantity { color:#706c65; font-family:var(--font-display); font-size:.78rem }
.atelier-cart-totals { width:min(30rem,100%); margin:2rem 0 2rem auto; padding:2rem 0; border-top:1px solid #161615 }
.atelier-cart-totals p { display:flex; justify-content:space-between; font-family:var(--font-display); text-transform:uppercase }
.atelier-cart-total { color:#d63821; font-size:1.15rem }
.atelier-cart-checkout { justify-content:flex-end; width:100%; padding:1.25rem 0; border-top:1px solid #161615 }
@media (max-width:760px) {
  .atelier-cart-head { grid-template-columns:1fr; align-items:start }
}
`;

const checkoutHtml = `
<header class="atelier-checkout-head">
  <a class="atelier-checkout-brand" data-cd-route="home" data-cd-text="store.name"></a>
  <p class="atelier-checkout-note">Secure checkout. Clear totals. Protected payment.</p>
</header>
<section class="atelier-checkout-story">
  <h1 class="atelier-checkout-title">Complete the assembly</h1>
  <p class="atelier-checkout-copy">Your contact, delivery, payment, consent, and order summary remain protected by the Calderyn checkout.</p>
  <div class="atelier-checkout-policies" data-cd-policy-links></div>
</section>`;

const checkoutCss = `
.atelier-checkout-head { display:flex; align-items:center; justify-content:space-between; padding:20px 0; border-bottom-width:1px; border-style:solid; border-color:#161615 }
.atelier-checkout-brand { color:#161615; font-family:var(--font-display); font-size:28px; font-weight:800; text-decoration:none }
.atelier-checkout-note { max-width:320px; margin:0; color:#5c5953; font-family:var(--font-display); font-size:12px; line-height:18px; text-align:right }
.atelier-checkout-story { display:grid; grid-template-columns:2fr 1fr; gap:32px; padding:48px 0; border-bottom-width:1px; border-style:solid; border-color:#aaa49b }
.atelier-checkout-title { margin:0; color:#161615; font-family:var(--font-display); font-size:64px; font-weight:800; line-height:48px }
.atelier-checkout-copy { margin:0; color:#5c5953; font-family:var(--font-body); font-size:18px; line-height:28px }
.atelier-checkout-policies { margin-top:24px }
@media (max-width:760px) {
  .atelier-checkout-head { display:block }
  .atelier-checkout-note { margin-top:16px; text-align:left }
  .atelier-checkout-story { display:block; padding:32px 0 }
  .atelier-checkout-title { margin-bottom:24px; font-size:48px; line-height:48px }
}
`;

const config = {
  templateId: "atelier-nine",
  templateVersion: 1,
  concept: {
    name: "Atelier Grid",
    rationale: "A complete commerce journal that treats products as an edited fashion issue without obscuring purchase paths.",
    noveltySignature: [
      "offset cover-story hero",
      "uneven twelve-column merchandising",
      "order folio cart",
      "vermilion editorial index",
    ],
  },
  designSystem: {
    displayFontId: "archivo-narrow",
    bodyFontId: "source-serif-4",
    tokens: {
      accent: "#d63821",
      ink: "#161615",
      line: "#aaa49b",
      muted: "#706c65",
      paper: "#f5f1e9",
      "space-4": "24px",
      surface: "#f5f1e9",
    },
    breakpoints: { mobile: 760, wide: 1280 },
    iconStyle: "Thin editorial arrows and restrained one-pixel utility marks",
    motionStyle: "Restrained opacity and image-focus transitions with reduced-motion parity",
    globalCss,
  },
  archetype: {
    composition: "asymmetric-magazine",
    hero: "editorial-grid-hero",
    scroll: "restrained-editorial",
    cards: "magazine-grid",
    iconography: ["thin editorial arrows", "restrained utility marks"],
  },
  surfaces: {
    shell: {
      signature: "single-line issue masthead above a separate trusted cart surface",
      source: {
        ...routeDefaults,
        html: `<header class="atelier-nav"><span class="niche-icon niche-icon--atelier" aria-hidden="true">&#8599;</span><a class="atelier-wordmark atelier-link" data-cd-route="home" data-cd-text="store.name"></a><nav class="atelier-nav-links" aria-label="Primary"><a class="atelier-link" data-cd-route="collection">Collection</a><a class="atelier-link" data-cd-route="search">Search</a><a class="atelier-link" data-cd-route="account">Account</a><a class="atelier-link" data-cd-route="cart">Bag <span data-cd-text="cart.count"></span></a></nav></header><div data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div><footer class="atelier-nav-links"><a class="atelier-link" data-cd-route="policy" data-cd-param-policy-id="shipping">Shipping</a><a class="atelier-link" data-cd-route="policy" data-cd-param-policy-id="refund">Returns</a><div data-cd-policy-links></div></footer>`,
        css: `.atelier-nav, .atelier-nav-links { padding-left:max(1rem,calc((100% - 96rem)/2)); padding-right:max(1rem,calc((100% - 96rem)/2)) } @media(max-width:720px){.atelier-nav{align-items:start;display:grid;gap:.75rem}.atelier-nav-links{display:grid;grid-template-columns:repeat(2,1fr);gap:.5rem}.atelier-nav-links a{border-top:1px solid var(--line);padding-top:.45rem}}`,
      },
    },
    home: { signature: "offset cover story beside owned full-height fashion photography", source: { ...routeDefaults, html: homeHtml, css: homeCss } },
    collection: { signature: "sticky taxonomy over an uneven twelve-column editorial product index", source: { ...routeDefaults, html: collectionHtml, css: collectionCss } },
    product: { signature: "lookbook-scale product plate followed by an explicit trusted purchase folio", source: { ...routeDefaults, html: productHtml, css: productCss, rootScopeKind: "product" } },
    search: { signature: "archive query desk with tactile suggestions and compact ranked result plates", source: { ...routeDefaults, html: searchHtml, css: searchCss, rootScopeKind: "search" } },
    cart: { signature: "order folio pairing editorial line descriptions with protected quantity and totals controls", source: { ...routeDefaults, html: cartHtml, css: cartCss, rootScopeKind: "cart" } },
    checkout: {
      signature: "quiet trust frame and brand story beside the sibling platform checkout",
      source: {
        html: checkoutHtml,
        css: checkoutCss,
        layout: {
          columnMode: "summaryAside",
          sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
          spacingTokenId: "space-4",
          surfaceTokenIds: ["paper", "ink", "accent", "surface"],
        },
      },
    },
  },
  assets: ATELIER_GRID_ASSETS,
} satisfies RecipeConfig<"atelier-nine">;

export const ATELIER_GRID_RECIPE = defineRecipe(config);
export const ATELIER_GRID_BUNDLE = ATELIER_GRID_RECIPE.bundle;
