import { defineRecipe, type RecipeConfig } from "../factory";
import type { RouteSource } from "../../storefront-compiler/compile";
import { ATELIER_GRID_ASSETS } from "./assets";

const routeDefaults: Pick<RouteSource, "requiredData" | "requiredCapabilities"> = {
  requiredData: [],
  requiredCapabilities: [],
};

const globalCss = `
.atelier-shell { width:min(calc(100% - 32px),1540px); margin-inline:auto }
.announcement { display:flex; justify-content:space-between; padding:8px 16px; color:#fff; background:#d63821; font-size:11px; font-weight:700; text-transform:uppercase }
.atelier-site-header { position:sticky; top:0; z-index:20; background:#f4f1eb; border-bottom:1px solid #101010 }
.header-row { display:grid; grid-template-columns:minmax(0,250px) 1fr minmax(0,250px); align-items:center; min-height:67px }
.atelier-wordmark { color:#101010; font-family:var(--font-display); font-size:clamp(15px,2vw,22px); font-weight:900; line-height:1.05; padding-block:8px; text-transform:uppercase }
.atelier-nav-links,.atelier-utility { display:flex; align-items:center; gap:34px; font-family:var(--font-display); font-size:12px; text-transform:uppercase }
.atelier-nav-links { justify-content:center }
.atelier-utility { justify-content:flex-end; gap:22px }
.atelier-link { color:#101010; text-decoration:none }
.atelier-link:hover { color:#d63821 }
.atelier-heading { margin:0; color:#161615; font-family:var(--font-display); font-weight:800; letter-spacing:-.035em; line-height:.88; text-transform:uppercase }
.atelier-serif { color:#34322f; font-family:var(--font-body); line-height:1.45 }
.atelier-price { font-family:var(--font-display); font-size:.85rem; letter-spacing:.04em }
.atelier-media { display:block; width:100%; object-fit:cover }
.atelier-rule { border-bottom:1px solid #2a2927 }
.atelier-action { display:inline-flex; align-items:center; gap:.8rem; color:#d63821; font-family:var(--font-display); font-weight:700; letter-spacing:.08em; text-decoration:none; text-transform:uppercase }
.atelier-action:active { transform:translateY(1px) }
.atelier-footer { display:grid; grid-template-columns:1.2fr 1fr 1fr; gap:50px; padding:48px 0 72px }
.atelier-footer h3 { margin:0 0 16px; font-size:12px; text-transform:uppercase }
.atelier-footer p,.atelier-footer a { color:#6e6b66; font-size:12px; line-height:1.8 }
.newsletter { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #101010; color:#6e6b66 }
.shipping-bar { display:flex; justify-content:space-between; padding:11px 16px; color:#fff; background:#d63821; font-size:10px; text-transform:uppercase }
@media (max-width:760px) {
  .atelier-shell { width:min(calc(100% - 20px),1540px) }
  .atelier-footer { grid-template-columns:1fr; gap:28px; padding:40px 0 }
  .shipping-bar { display:block; text-align:center }
  .shipping-bar span:last-child { display:none }
}
`;

const globalFooterHtml = `<footer class="atelier-site-footer"><div class="atelier-shell atelier-footer"><div><h3 data-cd-text="store.name"></h3><p>A concise wardrobe for deliberate living.<br>Designed in Toronto. Made with specialist ateliers.</p></div><div><h3>Customer care</h3><div class="atelier-policy-links" data-cd-policy-links></div></div><div><h3>Private notes</h3><p>New editions, studio notes, and first access.</p><div class="newsletter"><span>Email address</span><span>&rarr;</span></div></div></div><div class="shipping-bar"><span>Complimentary shipping on all orders over $300</span><span>Shipping &nbsp; Returns &nbsp; Contact &nbsp; Terms &nbsp; Privacy</span></div></footer>`;

const homeHtml = `
<main id="top">
  <section class="atelier-shell hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <h1 class="hero-title" id="hero-title"><span>Summer</span><span>Assembly</span></h1>
      <div class="hero-lower">
        <div class="edition"><b>01</b><i></i><b>03</b></div>
        <div class="hero-intro"><p>Uncompromising pieces, considered in form and fabric.</p><a class="arrow-link" data-cd-route="collection">Shop collection <span>→</span></a></div>
      </div>
    </div>
    <div class="hero-media"><img data-cd-asset="hero" alt="Model wearing the black Assembly shirt dress" width="1800" height="1200"><div class="hero-note">The Assembly Dress<br>Japanese cotton poplin<br>Edition of 120</div></div>
  </section>
  <section class="atelier-shell catalog" aria-labelledby="catalog-title">
    <aside class="catalog-side" tabindex="0"><h2 id="catalog-title">Summer collection</h2><div class="category-list"><span>New arrivals <small>04</small></span><span>Dresses <small>01</small></span><span>Tops <small>02</small></span><span>Outerwear <small>01</small></span></div></aside>
    <div class="catalog-main">
      <div class="catalog-head"><h2>New arrivals</h2><span>Featured</span></div>
      <div class="product-grid">
        <article class="product" data-cd-repeat="featured.products">
          <a class="atelier-link" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle">
            <div class="product-media"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="800" height="1000" loading="lazy"><span class="product-badge">Edition</span></div>
            <div class="product-info"><span data-cd-text="product.title"></span><span class="atelier-price" data-cd-money="product.price"></span></div>
          </a>
        </article>
      </div>
    </div>
  </section>
  <section>
    <div data-cd-repeat="featured.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div></div>
  </section>
  <section class="atelier-shell manifesto">
    <div class="manifesto-copy"><span class="manifesto-kicker">The Atelier Standard</span><h2>Designed slowly. Worn without ceremony.</h2><p>Every piece begins with proportion: a shoulder line, a clean fall, a pocket placed exactly where the hand expects it. We use materials selected for movement, longevity, and a life beyond one season.</p><a class="arrow-link" data-cd-route="collection">Read our process <span>→</span></a></div>
    <div class="manifesto-index"><div><strong>09</strong><span>Pieces / one complete wardrobe</span></div></div>
  </section>
</main>`;

const homeCss = `
.hero { display:grid; grid-template-columns:49% 51%; min-height:680px; border-bottom:1px solid #101010 }
.hero-copy { display:grid; grid-template-columns:minmax(0,1fr); grid-template-rows:1fr auto; overflow:hidden; padding:30px 18px 18px 0 }
.hero-title { width:137%; margin:0; font-family:var(--font-display); font-size:144px; font-weight:900; line-height:.78; text-transform:uppercase; transform:scaleX(.73); transform-origin:top left }
.hero-title span { display:block }
.hero-lower { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,230px); gap:24px; align-items:end }
.edition { display:flex; align-items:center; gap:12px; font-size:11px }
.edition i { flex:1 1 40px; max-width:140px; height:1px; background:#101010 }
.hero-intro p { max-width:100%; margin:0 0 24px; font-family:var(--font-body); font-size:clamp(14px,1.5vw,18px); line-height:1.3 }
.arrow-link { display:inline-flex; align-items:center; gap:18px; padding-bottom:5px; color:#d63821; border-bottom:1px solid currentColor; font-weight:750; font-size:12px; text-decoration:none; text-transform:uppercase }
.hero-media { position:relative; min-height:680px; overflow:hidden }
.hero-media img { width:100%; height:100%; object-fit:cover; object-position:58% center }
.hero-note { position:absolute; right:18px; bottom:18px; width:166px; padding:10px; color:#fff; background:#101010; font-size:10px; line-height:1.45; text-transform:uppercase }
.catalog { display:grid; grid-template-columns:255px minmax(0,1fr); border-bottom:1px solid #101010 }
.catalog-side { position:sticky; top:67px; align-self:start; padding:18px 28px 28px 0; border-right:1px solid #101010 }
.catalog-side h2,.catalog-head h2 { margin:0; font-size:12px; text-transform:uppercase }
.catalog-side h2 { margin-bottom:28px }
.category-list { display:grid }
.category-list span { display:flex; justify-content:space-between; padding:12px 0; border-bottom:1px solid #aaa49b; font-size:12px; text-transform:uppercase }
.category-list span:first-child { color:#d63821; border-top:1px solid #aaa49b; font-weight:750 }
.category-list small { color:#6e6b66 }
.catalog-main { min-width:0 }
.catalog-head { display:flex; align-items:center; justify-content:space-between; height:58px; padding:0 16px; border-bottom:1px solid #101010; font-size:10px; text-transform:uppercase }
.product-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)) }
.product { min-width:0; border-right:1px solid #aaa49b }
.product-media { position:relative; width:100%; aspect-ratio:4 / 5; overflow:hidden; background:#ebe6de }
.product-media img { width:100%; height:100%; object-fit:cover }
.product-badge { position:absolute; top:10px; left:10px; padding:5px 7px; color:#fff; background:#101010; font-size:9px; text-transform:uppercase }
.product-info { display:grid; grid-template-columns:1fr auto; gap:7px 14px; padding:12px 10px 18px; font-size:11px; text-transform:uppercase }
.manifesto { display:grid; grid-template-columns:1.25fr .75fr; min-height:430px; border-bottom:1px solid #101010 }
.manifesto-copy { padding:56px 7vw 62px 0; border-right:1px solid #101010 }
.manifesto-kicker { color:#d63821; font-size:11px; text-transform:uppercase }
.manifesto h2 { max-width:10ch; margin:24px 0 32px; font-family:var(--font-body); font-size:44px; line-height:1.04; font-weight:400 }
.manifesto p { max-width:54ch; color:#6e6b66; line-height:1.7 }
.manifesto-index { display:grid; place-items:center; color:#fff; background:#d63821 }
.manifesto-index strong { font-family:var(--font-display); font-size:128px; line-height:1 }
.manifesto-index span { display:block; margin-top:10px; text-align:center; text-transform:uppercase; font-size:11px }
@media (max-width:1120px) { .hero-title{font-size:104px}.hero,.hero-media{min-height:600px}.product-grid{grid-template-columns:repeat(2,1fr)} }
@media (max-width:760px) {
  .hero { grid-template-columns:1fr; min-height:0 }
  .hero-copy { min-height:450px; padding:25px 0 18px }
  .hero-title { width:128%; font-size:66px; line-height:.82; transform:scaleX(.78) }
  .hero-lower { grid-template-columns:1fr }
  .hero-intro p { margin:0; font-size:15px }
  .hero-media { min-height:72vw }
  .catalog { grid-template-columns:1fr }
  .catalog-side { position:static; padding:18px 0; border-right:0; border-bottom:1px solid #101010; overflow-x:auto }
  .category-list { display:flex; width:max-content; gap:18px }
  .category-list span { gap:8px; border:0 }
  .catalog-head { padding-inline:0 }
  .product-grid { grid-template-columns:repeat(2,1fr) }
  .product-info { grid-template-columns:1fr }
  .manifesto { grid-template-columns:1fr }
  .manifesto-copy { padding:42px 0; border-right:0 }
  .manifesto h2 { font-size:34px }
  .manifesto-index { min-height:280px }
}
@media (prefers-reduced-motion:reduce) { .catalog-side { position:static } }
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
  <section>
    <div data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div></div>
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
  <section>
    <div data-cd-repeat="search.results"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div></div>
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
.atelier-checkout-policies { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:24px }
.atelier-checkout-policies a { color:#5c5953; font-size:12px; text-decoration:none }
@media (max-width:760px) {
  .atelier-checkout-head { display:block }
  .atelier-checkout-note { margin-top:16px; text-align:left }
  .atelier-checkout-story { display:block; padding:32px 0 }
  .atelier-checkout-title { margin-bottom:24px; font-size:48px; line-height:48px }
}
`;

const config = {
  templateId: "atelier-nine",
  templateVersion: 2,
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
      signature: "canonical announcement and masthead before the route composition",
      source: {
        ...routeDefaults,
        html: `<div class="announcement"><span>Complimentary shipping on all orders over $300</span><span>Edition 03 / Summer 2026</span></div><header class="atelier-site-header"><div class="atelier-shell header-row"><a class="atelier-wordmark atelier-link" data-cd-route="home"><span class="niche-icon niche-icon--atelier" aria-hidden="true">&#10022;</span><span data-cd-text="store.name"></span></a><nav class="atelier-nav-links" aria-label="Primary"><a class="atelier-link" data-cd-route="collection">Shop</a><a class="atelier-link" data-cd-route="collection">Collections</a><a class="atelier-link" data-cd-route="home">About</a><a class="atelier-link" data-cd-route="search">Journal</a></nav><div class="atelier-utility"><a class="atelier-link" data-cd-route="search">Search</a><a class="atelier-link" data-cd-route="account">Account</a><a class="atelier-link" data-cd-route="cart">Bag (<span data-cd-text="cart.count"></span>)</a></div></div></header><div data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="ink paper accent"></div>${globalFooterHtml}`,
        css: `.niche-icon--atelier{margin-right:.35em;color:var(--accent)}.atelier-policy-links{display:flex;flex-wrap:wrap;gap:1rem}.atelier-policy-links a{color:var(--ink);text-decoration:none}@media(max-width:1120px){.header-row{grid-template-columns:minmax(0,200px) 1fr minmax(0,200px)}.atelier-nav-links{gap:18px}.atelier-utility{gap:12px}}@media(max-width:760px){.announcement span:last-child{display:none}.header-row{display:flex;flex-wrap:wrap;width:calc(100vw - 20px);height:auto;min-height:58px;padding:8px 0}.atelier-wordmark{font-size:22px}.atelier-nav-links{order:3;width:100%;gap:18px;overflow-x:auto;padding:7px 0 2px}.atelier-utility{margin-left:auto}.atelier-utility .atelier-link:not(:last-child){display:none}}`,
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
