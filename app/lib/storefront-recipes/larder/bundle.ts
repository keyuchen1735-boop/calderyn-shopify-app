import type { BindingScopeKind } from "~/lib/storefront-compiler/bindings";
import type { RouteSource } from "~/lib/storefront-compiler/compile";
import { videoFragment } from "../library/media";
import { motionAttributes } from "../library/motion";
import type { RecipeConfig } from "../factory";
import { LARDER_ASSETS, LARDER_MEDIA_ARTIFACTS } from "./assets";

function route(html: string, css: string, rootScopeKind?: BindingScopeKind): RouteSource {
  return { html, css, requiredData: [], requiredCapabilities: [], ...(rootScopeKind ? { rootScopeKind } : {}) };
}

const heroVideo = videoFragment({ className: "larder-film", posterAssetKey: "hero-poster", webmAssetKey: "hero-webm", mp4AssetKey: "hero-mp4" });
const kitchenVideo = videoFragment({ className: "larder-kitchen-film", posterAssetKey: "hero-alt-poster", webmAssetKey: "hero-alt-webm", mp4AssetKey: "hero-alt-mp4" });
const textureVideo = videoFragment({ className: "larder-texture-film", posterAssetKey: "pdp-detail-poster", webmAssetKey: "pdp-detail-webm", mp4AssetKey: "pdp-detail-mp4" });

const sharedCss = `
  .larder-page{min-height:70dvh;background:var(--paper);color:var(--ink);font-family:var(--font-body)}
  .larder-display{font-family:var(--font-display);font-weight:600;letter-spacing:-.045em;line-height:.92}
  .larder-kicker{font-size:.72rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
  .larder-button{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border:1px solid var(--ink);background:var(--tomato);color:var(--paper);padding:.75rem 1rem;text-decoration:none}
  .larder-empty{padding:2rem;overflow-wrap:anywhere}
  @media(max-width:720px){.larder-display{letter-spacing:-.03em}}
`;

export const LARDER_RECIPE_CONFIG = {
  templateId: "larder",
  templateVersion: 1,
  concept: {
    name: "Larder",
    rationale: "A working pantry that turns a live grocery catalog into tactile shelf browsing, box building, and clear replenishment rhythms.",
    noveltySignature: ["ingredient-cascade", "shelf-navigation", "six-place-pantry-box"],
  },
  designSystem: {
    displayFontId: "fraunces",
    bodyFontId: "manrope",
    tokens: {
      ink: "#29251f",
      paper: "#f4eddd",
      cream: "#fffaf0",
      tomato: "#c83e2d",
      olive: "#6f7437",
      wood: "#9a6742",
      line: "#b8a98d",
      "shelf-gap": "24px",
    },
    breakpoints: { compact: 720, wide: 1240 },
    iconStyle: "hand-cut shelf marks and tomato-olive pantry symbols",
    motionStyle: "tactile shelf reveals and measured replenishment steps",
    globalCss: "",
  },
  archetype: {
    composition: "working-pantry",
    hero: "pantry-table-hero",
    scroll: "pantry-rhythm",
    cards: "pantry-shelves",
    iconography: ["hand-cut shelf marks", "tomato and olive pantry symbols"],
  },
  surfaces: {
    shell: {
      signature: "paper pantry label masthead above olive shelf navigation and protected basket drawer",
      source: route(`
        <header class="larder-shell">
          <a class="larder-wordmark" data-cd-route="home"><span data-cd-text="store.name"></span></a>
          <nav aria-label="Pantry shelves"><a data-cd-route="collections">Shelves</a><a data-cd-route="collection">All provisions</a><a data-cd-route="story">The kitchen</a></nav>
          <div><a data-cd-route="search">Find</a><a data-cd-route="cart">Basket <span data-cd-text="cart.count"></span></a></div>
        </header>
        <aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="paper tomato olive"></aside>
        <footer class="larder-footer"><span data-cd-text="store.name"></span><nav data-cd-policy-links></nav></footer>
      `, `
        .larder-shell{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:1.5rem;min-height:68px;padding:.75rem 1.25rem;background:var(--paper);color:var(--ink);border-bottom:6px solid var(--olive)}
        .larder-shell nav,.larder-shell>div,.larder-footer{display:flex;gap:1.2rem}.larder-shell>div{justify-content:flex-end}.larder-shell a,.larder-footer a{color:inherit;text-decoration:none}.larder-wordmark{font-family:var(--font-display);font-size:1.55rem}.larder-footer{justify-content:space-between;padding:2rem;background:var(--olive);color:var(--cream)}
        @media(max-width:720px){.larder-shell{grid-template-columns:1fr auto}.larder-shell nav{grid-column:1/-1;overflow:auto}.larder-shell>div a:first-child{display:none}}
      `),
    },
    home: {
      signature: "ingredient cascade hero descending into live pantry shelves and a six-place replenishment bench",
      source: route(`
        <main class="larder-page larder-home">
          <section class="larder-hero" aria-label="Ingredients cascading into a working pantry">
            ${heroVideo.html}
            <div class="larder-hero-copy" ${motionAttributes("reveal")}><span class="larder-kicker">The working pantry / stocked by the merchant</span><h1 class="larder-display">Keep good things<br>within reach.</h1><p>Staples, small pleasures, and the next useful jar—drawn from this shop's live shelves.</p><a class="larder-button" data-cd-route="collection">Open the pantry</a></div>
          </section>
          <nav class="larder-shelf-tabs" aria-label="Shelf navigation"><a data-cd-route="collection">Cook</a><a data-cd-route="collection">Pour</a><a data-cd-route="collection">Nibble</a><a data-cd-route="collection">Restock</a></nav>
          <section class="larder-stock" ${motionAttributes("reveal")}><header><span class="larder-kicker">On the shelf now</span><h2 class="larder-display">Useful by the jar.</h2><p>Titles, prices, stock, and imagery below come directly from the current merchant catalog.</p></header><div class="larder-product-shelf" data-cd-repeat="featured.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="640" height="760"><h3 data-cd-text="product.title"></h3></a><p data-cd-text="product.description"></p><div><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></div></article></div><p class="larder-empty" data-cd-empty-state>No provisions are on this shelf yet.</p></section>
          <section id="larder-box" class="larder-box" data-cd-state-id="box-count" data-cd-state-type="index" data-cd-state-initial="0" data-cd-state-min="0" data-cd-state-max="6" data-cd-bind-state="box-count" data-cd-bind-property="activeIndex">
            <div><span class="larder-kicker">Build a pantry box</span><h2 class="larder-display">Six places.<br>Your staples.</h2><p>Use the bench to plan a six-item case, then choose real products and variants through the live shelf controls.</p><label>Reorder rhythm</label><div id="reorder-rhythm" data-cd-state-id="reorder-cycle" data-cd-state-type="enum" data-cd-state-initial="4-weeks" data-cd-state-values="2-weeks 4-weeks 6-weeks" data-cd-bind-state="reorder-cycle" data-cd-bind-property="selected"><button value="2-weeks" data-cd-on="click" data-cd-action="state.set" data-cd-state="reorder-cycle">2 weeks</button><button value="4-weeks" data-cd-on="click" data-cd-action="state.set" data-cd-state="reorder-cycle">4 weeks</button><button value="6-weeks" data-cd-on="click" data-cd-action="state.set" data-cd-state="reorder-cycle">6 weeks</button></div></div>
            <div class="larder-box-board" aria-label="Six-slot pantry box"><div class="larder-box-slot">1</div><div class="larder-box-slot">2</div><div class="larder-box-slot">3</div><div class="larder-box-slot">4</div><div class="larder-box-slot">5</div><div class="larder-box-slot">6</div><div class="larder-box-controls"><button value="remove" data-cd-on="click" data-cd-action="state.decrement" data-cd-state="box-count">Remove place</button><button value="add" data-cd-on="click" data-cd-action="state.increment" data-cd-state="box-count">Fill next place</button><a data-cd-route="cart">Review basket</a></div></div>
          </section>
        </main><section data-cd-repeat="featured.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="paper tomato olive"></aside></section>
      `, `${sharedCss}
        .larder-hero{position:relative;display:grid;min-height:min(800px,88dvh);align-items:end;overflow:hidden;background:var(--olive);color:var(--cream)}.larder-film{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.larder-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(41,37,31,.72),transparent 65%)}.larder-hero-copy{position:relative;z-index:1;max-width:48rem;padding:clamp(2rem,7vw,7rem)}.larder-hero h1{font-size:clamp(4.5rem,10vw,9rem);margin:.6rem 0}.larder-hero p{max-width:34rem;font-size:1.12rem;line-height:1.6}.larder-shelf-tabs{display:grid;grid-template-columns:repeat(4,1fr);border-block:1px solid var(--line);background:var(--olive)}.larder-shelf-tabs a{padding:1rem;color:var(--cream);text-align:center;text-decoration:none;border-right:1px solid var(--paper)}
        .larder-stock{padding:clamp(3rem,7vw,7rem) clamp(1rem,4vw,4rem)}.larder-stock header{max-width:60rem;margin-bottom:2rem}.larder-stock h2,.larder-box h2{font-size:clamp(3.5rem,7vw,7rem);margin:.5rem 0}.larder-product-shelf{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-bottom:16px solid var(--wood)}.larder-product-shelf article{display:grid;gap:.75rem;padding:1rem;background:var(--cream)}.larder-product-shelf img{width:100%;aspect-ratio:5/6;object-fit:cover}.larder-product-shelf a{color:inherit;text-decoration:none}.larder-product-shelf article>div{display:flex;justify-content:space-between;gap:1rem}
        .larder-box{display:grid;grid-template-columns:.8fr 1.2fr;gap:clamp(2rem,7vw,7rem);padding:clamp(3rem,7vw,7rem);background:var(--tomato);color:var(--cream)}.larder-box button,.larder-box a{min-height:44px;border:1px solid currentColor;background:transparent;color:inherit;padding:.7rem;text-decoration:none}.larder-box-board{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}.larder-box-slot{display:grid;aspect-ratio:1;place-items:center;border:2px dashed var(--cream);border-radius:50%;font-family:var(--font-display);font-size:2rem}.larder-box-controls{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.75rem}
        @media(max-width:720px){.larder-shelf-tabs{grid-template-columns:repeat(2,1fr)}.larder-product-shelf{grid-template-columns:1fr}.larder-box{grid-template-columns:1fr}.larder-box-board{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){.larder-film,.larder-hero-copy,.larder-stock{animation:none;transition:none}}
      `),
    },
    collections: {
      signature: "olive shelf directory leading into one honest all-provisions catalog doorway",
      source: route(`<main class="larder-page larder-directory"><header><span class="larder-kicker">Pantry directory</span><h1 class="larder-display">Every shelf,<br>one live pantry.</h1><p>Browse the store's current provisions without invented categories.</p><a class="larder-button" data-cd-route="collection">All provisions</a></header><section data-cd-repeat="featured.products"><article data-cd-key="product.id"><span>On shelf</span><h2 data-cd-text="product.title"></h2><b data-cd-money="product.price"></b><a data-cd-route="product" data-cd-param-handle="product.handle">Open jar</a></article></section><p class="larder-empty" data-cd-empty-state>The pantry is waiting for its first provision.</p></main>`, `${sharedCss}.larder-directory>header{padding:clamp(3rem,8vw,8rem);background:var(--olive);color:var(--cream)}.larder-directory h1{font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.larder-directory>section article{display:grid;grid-template-columns:auto 1fr auto auto;gap:1rem;align-items:center;padding:1.2rem;border-bottom:1px solid var(--line)}@media(max-width:720px){.larder-directory>section article{grid-template-columns:1fr auto}.larder-directory>section article span,.larder-directory>section article a{grid-column:1/-1}}`),
    },
    collection: {
      signature: "paper shelf ledger with tomato filters and live merchant provision cards",
      source: route(`<main class="larder-page larder-collection"><header><span class="larder-kicker">Live pantry shelf</span><h1 class="larder-display" data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p><b><span data-cd-text="collection.productCount"></span> provisions</b></header><nav aria-label="Pantry filters"><button value="all" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Everything</button><button value="staple" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Staples</button><button value="treat" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Little treats</button><button value="relevance" data-cd-on="click" data-cd-action="collection.sort">Shelf order</button></nav><section class="larder-collection-grid" data-cd-repeat="collection.products"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="640" height="760"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open provision</a></article></section><p class="larder-empty" data-cd-empty-state>No live provisions match this shelf.</p></main><section data-cd-repeat="collection.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="paper tomato olive"></aside></section>`, `${sharedCss}.larder-collection>header{padding:clamp(3rem,7vw,7rem);background:var(--olive);color:var(--cream)}.larder-collection h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.larder-collection>nav{display:flex;flex-wrap:wrap;gap:.5rem;padding:1rem;border-bottom:1px solid var(--line)}.larder-collection>nav button{min-height:44px;border:1px solid var(--ink);background:transparent;padding:.7rem}.larder-collection-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line)}.larder-collection article{display:grid;gap:.75rem;padding:1rem;background:var(--cream)}.larder-collection img{width:100%;aspect-ratio:5/6;object-fit:cover}.larder-collection a{color:inherit}@media(max-width:720px){.larder-collection-grid{grid-template-columns:1fr}}`, "collection"),
    },
    product: {
      signature: "live product pantry record beside honest plan eligibility and tactile package context",
      source: route(`<main class="larder-page larder-product"><section class="larder-gallery"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="900" height="1050"><div data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title" width="640" height="760"></div><div class="larder-texture" aria-label="Unlabelled pantry package materials">${textureVideo.html}</div></section><article><span class="larder-kicker">Pantry record / live product</span><h1 class="larder-display" data-cd-text="product.title"></h1><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><p data-cd-text="product.description"></p><div data-cd-repeat="product.variants"><div class="larder-variant-row" data-cd-key="variant.id"><span data-cd-text="variant.title"></span><b data-cd-money="variant.price"></b><span data-cd-text="variant.availability"></span></div></div><div id="subscribe-choice" class="larder-subscribe" data-cd-state-id="subscribe-on" data-cd-state-type="boolean" data-cd-state-initial="false" data-cd-bind-state="subscribe-on" data-cd-bind-property="selected"><label><input aria-label="Subscribe and replenish" type="checkbox" name="subscription" value="on" data-cd-on="change" data-cd-action="state.set" data-cd-state="subscribe-on" data-cd-value-field="checked"> Subscribe and replenish</label><p>Subscription choice only appears when this product has a merchant plan. One-time purchase stays the default.</p></div><nav data-cd-policy-links></nav></article></main><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="paper tomato olive"></div><div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="paper tomato olive"></div>`, `${sharedCss}.larder-product{display:grid;grid-template-columns:1.15fr .85fr}.larder-gallery{display:grid;gap:1px;background:var(--line)}.larder-gallery>img,.larder-gallery>div img{width:100%;aspect-ratio:5/6;object-fit:cover}.larder-texture{min-height:300px}.larder-texture-film{width:100%;height:100%;min-height:300px;object-fit:cover}.larder-product>article{position:sticky;top:0;align-self:start;display:grid;gap:1rem;min-height:100dvh;padding:clamp(1.5rem,4vw,4rem);background:var(--cream)}.larder-product h1{font-size:clamp(3.5rem,6vw,6.5rem);margin:.4rem 0}.larder-variant-row{display:flex;justify-content:space-between;gap:1rem;padding:.8rem 0;border-top:1px solid var(--line)}.larder-subscribe{padding:1rem;background:var(--paper);border-left:6px solid var(--olive)}@media(max-width:720px){.larder-product{grid-template-columns:1fr}.larder-product>article{position:static;min-height:auto}}@media(prefers-reduced-motion:reduce){.larder-texture-film{animation:none;transition:none}}`, "product"),
    },
    search: {
      signature: "tomato query label followed by ranked live provisions on a wood-edged shelf",
      source: route(`<main class="larder-page larder-search"><header><span class="larder-kicker">Find a provision</span><h1 class="larder-display">Search the shelves.</h1><p data-cd-text="search.query"></p><div role="search"><input aria-label="Search pantry" type="search" name="q" value="" placeholder="Jar, staple, or product" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div></header><section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="260" height="300"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open provision</a></article></section><p class="larder-empty" data-cd-empty-state>No provisions matched. Try a broader shelf word.</p></main>`, `${sharedCss}.larder-search>header{padding:clamp(3rem,8vw,8rem);background:var(--tomato);color:var(--cream)}.larder-search h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.larder-search input,.larder-search button{min-height:44px;border:1px solid currentColor;background:transparent;color:inherit;padding:.75rem}.larder-search>section article{display:grid;grid-template-columns:100px 1fr 2fr auto auto auto;gap:1rem;align-items:center;padding:1rem;border-bottom:8px solid var(--wood)}.larder-search img{width:100px;aspect-ratio:1;object-fit:cover}@media(max-width:720px){.larder-search>section article{grid-template-columns:80px 1fr}.larder-search>section article>*:not(img):not(h2){grid-column:2}}`, "search"),
    },
    story: {
      signature: "sunlit working-kitchen film framed by a three-step stock-use-replenish rhythm",
      source: route(`<main class="larder-page larder-story"><header>${kitchenVideo.html}<div><span class="larder-kicker">The working kitchen</span><h1 class="larder-display">Stock. Use.<br>Replenish.</h1><p><span data-cd-text="store.name"></span> keeps the live catalog close to the rhythm of a real pantry.</p></div></header><section><article><b>01 / Stock</b><h2>Choose what is available.</h2><p>Products, variants, and prices remain merchant-owned facts.</p></article><article><b>02 / Use</b><h2>Make the shelf useful.</h2><p>Build around the staples you actually reach for.</p></article><article><b>03 / Return</b><h2>Come back on your rhythm.</h2><p>Replenishment stays optional and plan-dependent.</p></article></section><a class="larder-button" data-cd-route="collection">Browse live provisions</a><nav data-cd-policy-links></nav></main>`, `${sharedCss}.larder-story{padding:clamp(2rem,6vw,6rem)}.larder-story>header{position:relative;min-height:65dvh;overflow:hidden;background:var(--olive);color:var(--cream)}.larder-kitchen-film{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.larder-story header>div{position:absolute;inset:auto 0 0;padding:clamp(2rem,6vw,6rem);background:linear-gradient(transparent,rgba(41,37,31,.8))}.larder-story h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.larder-story>section{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:3rem 0;background:var(--line)}.larder-story article{min-height:250px;padding:1.5rem;background:var(--paper)}@media(max-width:720px){.larder-story>section{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){.larder-kitchen-film{animation:none;transition:none}}`),
    },
    cart: {
      signature: "six-place pantry basket progress above live lines, trusted controls, and platform summary",
      source: route(`<main class="larder-page larder-cart"><header><span class="larder-kicker">Pantry basket / six-place case</span><h1 class="larder-display">Your working shelf.</h1><p><b data-cd-text="cart.count"></b> of 6 pantry places filled</p><span>Live subtotal <b data-cd-money="cart.subtotal"></b></span></header><section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><span>Quantity <b data-cd-text="cartLine.quantity"></b></span><span data-cd-money="cartLine.unitPrice"></span><strong data-cd-money="cartLine.total"></strong></article></section><aside><span>Subtotal</span><b data-cd-money="cart.subtotal"></b><span>Total</span><strong data-cd-money="cart.total"></strong></aside><p class="larder-empty" data-cd-empty-state>Your shelf is empty. Add a live provision to begin.</p></main><section data-cd-repeat="cart.lines"><div data-cd-key="cartLine.id" data-cd-slot="cartLineControls" data-cd-host-size="inline"></div></section><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="paper tomato olive"></div>`, `${sharedCss}.larder-cart>header{padding:clamp(3rem,7vw,7rem);background:var(--olive);color:var(--cream)}.larder-cart h1{font-size:clamp(4rem,9vw,8rem);margin:.5rem 0}.larder-cart>section article{display:grid;grid-template-columns:2fr 1fr 1fr 1fr auto;gap:1rem;align-items:center;padding:1.25rem;border-bottom:8px solid var(--wood)}.larder-cart>aside{display:grid;grid-template-columns:1fr auto;gap:1rem;max-width:32rem;margin:2rem 2rem 2rem auto}@media(max-width:720px){.larder-cart>section article{grid-template-columns:1fr 1fr}}`, "cart"),
    },
    checkout: {
      signature: "warm paper checkout note beside platform-owned delivery and payment summary",
      source: {
        html: `<header class="larder-checkout"><span>Final pantry check</span><h1 data-cd-text="store.name"></h1><p>Review live quantities, delivery, and any eligible replenishment plan before secure payment.</p></header><aside class="larder-checkout-note"><b>Packed from the live basket</b><span>Final totals shown by checkout</span><span>Merchant policies remain available</span></aside><footer data-cd-policy-links></footer>`,
        css: `.larder-checkout{padding:48px;max-width:760px;background-color:var(--paper)}.larder-checkout h1{font-family:var(--font-display);font-size:64px}.larder-checkout-note{display:grid;gap:12px;padding:30px;background-color:var(--olive);color:var(--cream)}`,
        layout: { columnMode: "summaryAside", sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"], spacingTokenId: "shelf-gap", surfaceTokenIds: ["paper", "cream", "olive", "tomato"] },
      },
    },
    notFound: {
      signature: "empty pantry shelf recovery label returning shoppers to catalog and search",
      source: route(`<main class="larder-page larder-lost"><span class="larder-kicker">404 / shelf not found</span><h1 class="larder-display">Nothing stored here.</h1><p>Return to the live pantry or search for a current provision.</p><nav><a class="larder-button" data-cd-route="collection">Browse provisions</a><a data-cd-route="search">Search the shelves</a></nav></main>`, `${sharedCss}.larder-lost{display:grid;align-content:center;min-height:72dvh;padding:clamp(2rem,8vw,8rem);background:var(--tomato);color:var(--cream)}.larder-lost h1{max-width:10ch;font-size:clamp(4rem,10vw,9rem);margin:.5rem 0}.larder-lost nav{display:flex;gap:1rem;align-items:center}.larder-lost nav a{color:inherit}`),
    },
  },
  assets: LARDER_ASSETS,
  mediaArtifacts: LARDER_MEDIA_ARTIFACTS,
} satisfies RecipeConfig<"larder">;
