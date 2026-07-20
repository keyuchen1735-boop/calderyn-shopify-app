import type { RecipeConfig } from "../factory";
import { proofBandFragment } from "../library/commerce";
import { GILT_ASSETS } from "./assets";

const baseCss = `
  .gilt-kicker{font-size:.72rem;letter-spacing:.18em;text-transform:uppercase}.gilt-title{font-family:var(--font-display);font-size:clamp(3.2rem,8vw,8rem);font-weight:400;line-height:.86;margin:.5rem 0}.gilt-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.gilt-card img{aspect-ratio:4/5;object-fit:cover;width:100%}.gilt-cta{display:inline-block;background:var(--black);color:var(--cream);min-height:44px;padding:.85rem 1.2rem;text-decoration:none}.gilt-proof{background:var(--black);color:var(--cream);font-size:.7rem;letter-spacing:.11em;padding:.7rem;text-transform:uppercase}.gilt-risk{border-left:3px solid var(--gold);font-size:.82rem;padding:.6rem .8rem}.gilt-empty{border:1px solid var(--gold);padding:2rem}@media(max-width:760px){.gilt-grid{grid-template-columns:1fr}.gilt-title{font-size:clamp(3rem,18vw,5.5rem)}}`;

const purchaseProof = proofBandFragment({
  className: "gilt-proof",
  copy: "Live product • current price • protected personalization",
});

const shell = {
  html: `<header class="gilt-shell"><a data-cd-route="home"><span data-cd-text="store.name"></span></a><nav aria-label="Primary"><a data-cd-route="collections">Objects</a><a data-cd-route="story">Our gold</a><a data-cd-route="search">Search</a></nav><button aria-label="Open bag" data-cd-on="click" data-cd-action="surface.open" data-cd-target="gilt-bag">Bag <span data-cd-text="cart.count"></span></button></header><aside id="gilt-bag" data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="cream black gold"></aside><footer><span data-cd-text="store.name"></span><span>Objects held close.</span><nav data-cd-policy-links></nav></footer>`,
  css: `.gilt-shell{align-items:center;background:var(--cream);border-bottom:1px solid var(--black);display:flex;justify-content:space-between;padding:1rem 2rem;position:sticky;top:0;z-index:2}.gilt-shell nav{display:flex;gap:1.25rem}.gilt-shell nav a{align-items:center;display:inline-flex;min-height:44px}.gilt-shell button{background:none;border:1px solid var(--gold);min-height:44px}@media(max-width:760px){.gilt-shell{align-items:flex-start;gap:.75rem;padding:.8rem 1rem}.gilt-shell nav{font-size:.78rem;gap:.7rem;overflow-x:auto;max-width:52vw}.gilt-shell button{flex:none}}`,
  requiredData: [], requiredCapabilities: [],
};

const home = {
  html: `<main class="gilt-home"><section class="gilt-hero"><div><p class="gilt-kicker">Object ceremony / live collection</p><h1 class="gilt-title">A small thing, held forever.</h1><p>Objects chosen slowly, presented with their current price and availability.</p><a class="gilt-cta" data-cd-route="collection">Enter the collection</a><aside class="gilt-risk"><p>Review the merchant's current return and shipping terms.</p><nav data-cd-policy-links></nav></aside></div><div class="gilt-orbit" data-cd-repeat="featured.products"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><span data-cd-text="product.title"></span><p data-cd-text="product.description"></p></article></div></section><section><p class="gilt-kicker">The current cabinet</p><div class="gilt-grid" data-cd-repeat="featured.products"><article class="gilt-card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><p data-cd-money="product.price"></p><small data-cd-text="product.availability"></small></a></article></div></section><p class="gilt-empty" data-cd-empty-state>The cabinet is being prepared.</p></main>`,
  css: `${baseCss}.gilt-home{background:var(--cream);color:var(--black)}.gilt-hero{display:grid;grid-template-columns:.9fr 1.1fr;min-height:48rem}.gilt-hero>div{align-self:start;display:flex;flex-direction:column;justify-content:center;min-height:42rem;padding:clamp(2rem,6vw,6rem);position:sticky;top:4rem}.gilt-orbit{background:var(--black);color:var(--cream);display:grid;grid-auto-flow:column;grid-auto-columns:100%;overflow-x:auto;scroll-snap-type:x mandatory}.gilt-orbit article{display:grid;min-height:48rem;place-items:center;scroll-snap-align:start}.gilt-orbit article p{max-width:32rem;padding:0 2rem 2rem}.gilt-orbit img{filter:saturate(.75) contrast(1.05);max-height:38rem;object-fit:contain;width:100%}.gilt-home>section:nth-child(2)>p{padding:3rem 2rem 1rem}@media(max-width:760px){.gilt-hero{grid-template-columns:1fr;min-height:auto}.gilt-hero>div{min-height:auto;position:static}.gilt-orbit,.gilt-orbit article{min-height:26rem}}@media(prefers-reduced-motion:reduce){.gilt-orbit{scroll-behavior:auto}.gilt-orbit img{transform:none}}`,
  requiredData: [], requiredCapabilities: [],
};

const collections = {
  html: `<main class="gilt-directory"><header><p class="gilt-kicker">Live catalog</p><h1 class="gilt-title">All products</h1><p>Browse the merchant's current catalog in one place.</p><a class="gilt-cta" data-cd-route="collection">Browse all products</a></header></main>`,
  css: `${baseCss}.gilt-directory>header{background:var(--black);color:var(--cream);padding:5rem 2rem}`,
  requiredData: [], requiredCapabilities: [],
};

const collection = {
  html: `<main class="gilt-collection"><header><p class="gilt-kicker">Live jewelry cabinet</p><h1 class="gilt-title" data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p></header><aside class="gilt-filters" aria-label="Collection controls"><button value="available" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="availability">Available</button><button value="price_asc" data-cd-on="click" data-cd-action="collection.sort">Price, low first</button></aside><section class="gilt-grid" data-cd-repeat="collection.products"><article class="gilt-card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><p data-cd-money="product.price"></p><small data-cd-text="product.availability"></small></a></article></section><section data-cd-repeat="collection.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="cream black gold"></aside></section><p class="gilt-empty" data-cd-empty-state>No objects match this cabinet.</p></main>`,
  css: `${baseCss}.gilt-collection>header{padding:4rem 2rem}.gilt-filters{border-block:1px solid var(--black);display:flex;gap:.5rem;padding:1rem 2rem}.gilt-filters button{background:none;border:1px solid var(--gold);min-height:44px}`,
  requiredData: [], requiredCapabilities: [], rootScopeKind: "collection" as const,
};

const product = {
  html: `<main class="gilt-object">
    <section class="gilt-gallery"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><div data-cd-repeat="product.images"><figure data-cd-key="product.primaryImage"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"></figure></div></section>
    <article class="gilt-purchase"><div class="gilt-purchase-copy"><p class="gilt-kicker">Object record</p><h1 class="gilt-title" data-cd-text="product.title"></h1><p data-cd-money="product.price"></p><b data-cd-text="product.availability"></b><p data-cd-text="product.description"></p><div class="gilt-variants" data-cd-repeat="product.variants"><span data-cd-key="variant.id"><b data-cd-text="variant.title"></b><small data-cd-money="variant.price"></small><small data-cd-text="variant.availability"></small></span></div><section class="gilt-gift-editorial" aria-label="Gifting options"><h2>A considered handoff.</h2><p>Add an optional engraving, gift note, gift wrap request, or recipient name with the selected live variant. The recipient's delivery destination is entered during secure checkout.</p></section>${purchaseProof.html}<aside class="gilt-risk"><p>Review the merchant's current return and shipping terms before adding this piece.</p><nav data-cd-policy-links></nav></aside></div><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="cream black gold"></div><div data-cd-slot="addToCart" data-cd-personalization="engraving giftNote giftWrap recipient" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="cream black gold"></div></article>
    <section class="gilt-grid" data-cd-repeat="related.products"><article class="gilt-card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><h2 data-cd-text="product.title"></h2><p data-cd-money="product.price"></p></a></article></section>
  </main>`,
  css: `${baseCss}.gilt-gallery{background:var(--black);display:grid;float:left;gap:1px;padding:2rem;position:sticky;top:4rem;width:55%}.gilt-gallery img{max-height:70vh;object-fit:contain;width:100%}.gilt-purchase-copy{display:grid;gap:1rem;margin-left:55%;padding:clamp(2rem,5vw,5rem)}.gilt-purchase .gilt-title{max-width:10ch}.gilt-variants{display:flex;flex-wrap:wrap;gap:.5rem}.gilt-variants span{display:grid;gap:.2rem}.gilt-variants span,.gilt-gift-editorial{border:1px solid var(--gold);padding:.75rem}.gilt-gift-editorial{margin:1rem 0}.gilt-object>.gilt-grid{clear:both}@media(max-width:760px){.gilt-gallery{float:none;position:static;width:auto}.gilt-purchase-copy{margin-left:0;padding:1.5rem}}`,
  requiredData: [], requiredCapabilities: [], rootScopeKind: "product" as const,
};

const search = {
  html: `<main class="gilt-search"><header><p class="gilt-kicker">Search the cabinet</p><h1 class="gilt-title">Find the object.</h1><p data-cd-text="search.query"></p></header><div role="search"><input aria-label="Search jewelry" type="search" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div><section class="gilt-grid" data-cd-repeat="search.results"><article class="gilt-card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><p data-cd-money="product.price"></p><small data-cd-text="product.availability"></small></a></article></section><p class="gilt-empty" data-cd-empty-state>No objects found.</p></main>`,
  css: `${baseCss}.gilt-search>header,.gilt-search>[role=search]{padding:2rem}.gilt-search input,.gilt-search button{min-height:44px;padding:.75rem}`,
  requiredData: [], requiredCapabilities: [], rootScopeKind: "search" as const,
};

const story = {
  html: `<main class="gilt-story"><section><p class="gilt-kicker">Our gold</p><h1 class="gilt-title">Restraint is the setting.</h1><p>Every object begins with the merchant's own material, care, and provenance record. Missing facts stay unspoken.</p></section><section class="gilt-grid" data-cd-repeat="featured.products"><article class="gilt-card" data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2></article></section><a class="gilt-cta" data-cd-route="collection">View the collection</a></main>`,
  css: `${baseCss}.gilt-story>section:first-child{background:var(--black);color:var(--cream);padding:7rem 2rem}.gilt-story>.gilt-cta{margin:2rem}`,
  requiredData: [], requiredCapabilities: [],
};

const cart = {
  html: `<main class="gilt-cart"><header><p class="gilt-kicker">Order review</p><h1 class="gilt-title">Objects held for you.</h1><p><span data-cd-text="cart.count"></span> pieces</p></header><section data-cd-repeat="cart.lines"><article class="gilt-card" data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><span data-cd-text="cartLine.quantity"></span><span data-cd-money="cartLine.total"></span><div data-cd-slot="cartLineControls" data-cd-host-size="inline" data-cd-theme-tokens="cream black gold"></div></article></section><p class="gilt-empty" data-cd-empty-state>Your case is empty.</p><aside data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="cream black gold"></aside></main>`,
  css: baseCss,
  requiredData: [], requiredCapabilities: [], rootScopeKind: "cart" as const,
};

const checkout = {
  html: `<header class="gilt-checkout"><p class="gilt-kicker">Secure handoff</p><h1 data-cd-text="store.name"></h1><p>Contact, delivery, payment, tax, and final totals remain protected by Calderyn.</p></header><aside class="gilt-risk">Only platform-confirmed products and options proceed to payment.</aside><footer data-cd-policy-links></footer>`,
  css: `.gilt-checkout{background-color:var(--black);color:var(--cream);padding:48px}.gilt-checkout h1{font-family:var(--font-display);font-size:56px}.gilt-risk{border-width:1px;border-style:solid;border-color:var(--gold);margin:24px;padding:18px}`,
  layout: { columnMode: "summaryAside" as const, sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"], spacingTokenId: "space-gilt", surfaceTokenIds: ["cream", "black", "gold"] },
} satisfies RecipeConfig<"gilt">["surfaces"]["checkout"]["source"];

const notFound = {
  html: `<main class="gilt-lost"><p class="gilt-kicker">404 / empty velvet</p><h1 class="gilt-title">This object is no longer here.</h1><p>Return to the live cabinet to continue.</p><a class="gilt-cta" data-cd-route="collections">Open collections</a></main>`,
  css: `${baseCss}.gilt-lost{align-content:center;background:var(--black);color:var(--cream);display:grid;min-height:70vh;padding:2rem}`,
  requiredData: [], requiredCapabilities: [],
};

export const GILT_RECIPE_CONFIG = {
  templateId: "gilt", templateVersion: 1,
  concept: { name: "Gilt", rationale: "An intimate object ceremony carries live jewelry and buyer-entered gifting details from cabinet to protected checkout.", noveltySignature: ["floating jewelry cabinet", "guided gifting handoff", "policy-adjacent purchase"] },
  designSystem: { displayFontId: "cormorant-garamond", bodyFontId: "manrope", tokens: { cream: "#f3ead8", black: "#0b0a08", gold: "#9a6b22", "space-gilt": "20px" }, breakpoints: { mobile: 760, wide: 1180 }, iconStyle: "fine gold hallmarks and circular object indices", motionStyle: "slow floating object reveals and restrained ceremony handoffs", globalCss: `.gilt-title{overflow-wrap:anywhere}` },
  archetype: { composition: "object-ceremony", hero: "jewelry-ceremony-hero", scroll: "intimate-ceremony", cards: "object-vignettes", iconography: ["fine gold hallmarks", "circular object indices"] },
  surfaces: {
    shell: { signature: "quiet hallmark masthead with a protected velvet bag drawer", source: shell },
    home: { signature: "floating live jewelry object followed by a restrained cabinet", source: home },
    collections: { signature: "dark catalog threshold with one honest all-products path", source: collections },
    collection: { signature: "ceremonial collection title above a live jewelry matrix", source: collection },
    product: { signature: "macro object stage beside live variants and protected gifting details", source: product },
    search: { signature: "spare cabinet query followed by ranked jewelry objects", source: search },
    story: { signature: "black field material story with live object evidence", source: story },
    cart: { signature: "object review ledger with protected line controls", source: cart },
    checkout: { signature: "gold rule assurance beside protected summary checkout", source: checkout },
    notFound: { signature: "empty velvet recovery surface returning to collections", source: notFound },
  },
  assets: GILT_ASSETS,
} satisfies RecipeConfig<"gilt">;
