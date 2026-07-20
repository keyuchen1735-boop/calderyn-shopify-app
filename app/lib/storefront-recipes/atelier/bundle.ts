import type { RouteSource } from "../../storefront-compiler/compile";
import {
  cartProgressFragment,
  stickyPurchaseFragment,
} from "../library/commerce";
import { videoFragment } from "../library/media";
import type { RecipeConfig } from "../factory";
import { ATELIER_ASSETS } from "./assets";

const route = (
  html: string,
  css: string,
  rootScopeKind?: RouteSource["rootScopeKind"],
): RouteSource => ({
  html,
  css,
  requiredData: [],
  requiredCapabilities: [],
  ...(rootScopeKind ? { rootScopeKind } : {}),
});

const heroVideo = videoFragment({
  className: "atelier-hero-video",
  posterAssetKey: "hero-poster",
  webmAssetKey: "hero-webm",
  mp4AssetKey: "hero-mp4",
});
const contextVideo = videoFragment({
  className: "atelier-context-video",
  posterAssetKey: "hero-alt-poster",
  webmAssetKey: "hero-alt-webm",
  mp4AssetKey: "hero-alt-mp4",
});
const detailVideo = videoFragment({
  className: "atelier-detail-video",
  posterAssetKey: "pdp-detail-poster",
  webmAssetKey: "pdp-detail-webm",
  mp4AssetKey: "pdp-detail-mp4",
});
const stickyPurchase = stickyPurchaseFragment({
  desktopClassName: "atelier-purchase-desktop",
  mobileClassName: "atelier-purchase-mobile",
});
const cartProgress = cartProgressFragment({
  className: "atelier-cart-progress",
  copy: "Shipping progress is calculated from the live bag.",
  orderBumpCopy:
    "Complete the uniform only when an eligible piece is available.",
});

const shell = route(
  `<header class="atelier-header"><a class="atelier-mark" data-cd-route="home" data-cd-text="store.name"></a><nav aria-label="Primary"><a data-cd-route="collections">Garments</a><a data-cd-route="story">Fit method</a><a data-cd-route="search">Search</a></nav><div class="atelier-tools"><a data-cd-route="account">Account</a><a data-cd-route="cart">Bag <span data-cd-text="cart.count"></span></a></div></header><aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="stone oxblood ink"></aside><footer class="atelier-footer"><span data-cd-text="store.name"></span><nav data-cd-policy-links></nav></footer>`,
  `.atelier-header{position:sticky;top:0;z-index:20;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;min-height:72px;padding:0 28px;background:#ebe6dd;border-bottom:1px solid #27221f}.atelier-header nav,.atelier-tools{display:flex;gap:24px}.atelier-tools{justify-content:flex-end}.atelier-header a,.atelier-footer a{color:inherit;text-decoration:none}.atelier-mark{font-family:var(--font-display);font-size:20px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.atelier-header nav,.atelier-tools{font-size:11px;letter-spacing:.08em;text-transform:uppercase}.atelier-footer{display:flex;justify-content:space-between;gap:24px;padding:36px 28px;background:#27221f;color:#ebe6dd}.atelier-footer nav{display:flex;flex-wrap:wrap;gap:18px}@media(max-width:760px){.atelier-header{grid-template-columns:1fr auto;padding:0 16px}.atelier-header nav{display:none}.atelier-tools a:first-child{display:none}}`,
);

const home = route(
  `<main class="atelier-home"><section class="atelier-hero" aria-labelledby="atelier-title">${heroVideo.html}<div class="atelier-hero-copy"><p>Garment study / live collection</p><h1 id="atelier-title">Fit begins with the cloth.</h1><span>Measured garments, calm essentials, and a size path that states what it knows.</span><a data-cd-route="collection">Study the current collection</a></div></section><section class="atelier-study"><div class="atelier-study-copy"><p>Fabric study 01</p><h2>Movement before ornament.</h2><span>Soft stone surfaces and an oxblood datum line keep attention on proportion, drape, and repeat wear.</span></div>${contextVideo.html}</section><section class="atelier-garments"><header><p>Current garment records</p><h2>Live cuts, not sample copy.</h2></header><div class="atelier-garment-grid" data-cd-repeat="featured.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h3 data-cd-text="product.title"></h3><p data-cd-money="product.price"></p><span data-cd-text="product.availability"></span></a></article></div><p class="atelier-empty" data-cd-empty-state>No garments are available in this study.</p></section></main><section data-cd-repeat="featured.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="stone oxblood ink"></div></section>`,
  `.atelier-home{background:#ebe6dd;color:#27221f}.atelier-hero{position:relative;min-height:760px;overflow:hidden}.atelier-hero-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.atelier-hero:after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,#27221fa8,transparent 70%)}.atelier-hero-copy{position:absolute;z-index:2;left:6vw;bottom:9vh;max-width:650px;color:#fff}.atelier-hero-copy p,.atelier-study p,.atelier-garments header p{font-size:11px;letter-spacing:.12em;text-transform:uppercase}.atelier-hero h1{max-width:8ch;margin:14px 0;font-family:var(--font-display);font-size:clamp(62px,9vw,130px);font-weight:500;line-height:.82}.atelier-hero-copy span{display:block;max-width:44ch;line-height:1.6}.atelier-hero-copy a{display:inline-block;margin-top:24px;padding:14px 18px;background:#681f2b;color:#fff;text-decoration:none}.atelier-study{display:grid;grid-template-columns:1fr 1.25fr;min-height:620px;border-bottom:1px solid #7b716a}.atelier-study-copy{padding:8vw 6vw;background:#d7d0c6}.atelier-study h2,.atelier-garments h2{margin:18px 0;font-family:var(--font-display);font-size:clamp(48px,7vw,96px);font-weight:500;line-height:.86}.atelier-study-copy span{display:block;max-width:42ch;line-height:1.7}.atelier-context-video{width:100%;height:100%;object-fit:cover}.atelier-garments{padding:72px 28px}.atelier-garments header{display:flex;justify-content:space-between;align-items:end;gap:30px}.atelier-garment-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.atelier-garment-grid article{min-width:0;border-top:1px solid #27221f}.atelier-garment-grid a{color:inherit;text-decoration:none}.atelier-garment-grid img{width:100%;aspect-ratio:4/5;object-fit:cover}.atelier-garment-grid h3{margin:12px 0 4px;font-family:var(--font-display);font-size:24px;font-weight:500}.atelier-empty{padding:40px 0}@media(max-width:760px){.atelier-hero{min-height:680px}.atelier-study{grid-template-columns:1fr}.atelier-study-copy{padding:60px 20px}.atelier-context-video{min-height:440px}.atelier-garments{padding:55px 16px}.atelier-garments header{display:block}.atelier-garment-grid{grid-template-columns:repeat(2,1fr)}}@media(prefers-reduced-motion:reduce){.atelier-hero-video,.atelier-context-video{animation:none}}`,
);

const collections = route(
  `<main class="atelier-index"><header><p>Garment index</p><h1>Study every live garment.</h1></header><nav aria-label="Collection index"><a data-cd-route="collection">All products</a></nav><section data-cd-repeat="featured.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><span data-cd-money="product.price"></span></a></article></section><p class="atelier-empty" data-cd-empty-state>No garment studies are available.</p></main>`,
  `.atelier-index{min-height:80vh;padding:70px 28px;background:#d7d0c6}.atelier-index header{display:grid;grid-template-columns:1fr 2fr;gap:30px;border-bottom:1px solid}.atelier-index h1{max-width:12ch;margin:0 0 50px;font-family:var(--font-display);font-size:clamp(54px,8vw,110px);font-weight:500;line-height:.83}.atelier-index nav{display:flex;border-bottom:1px solid}.atelier-index nav a{padding:24px 12px;color:inherit;text-decoration:none}.atelier-index section{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding-top:50px}.atelier-index article img{width:100%;aspect-ratio:4/5;object-fit:cover}.atelier-index article a{color:inherit;text-decoration:none}@media(max-width:760px){.atelier-index{padding:48px 16px}.atelier-index header,.atelier-index section{grid-template-columns:1fr 1fr}}`,
);

const collection = route(
  `<main class="atelier-collection"><header><p><span data-cd-text="collection.productCount"></span> garment studies</p><h1 data-cd-text="collection.title"></h1><span data-cd-text="collection.description"></span></header><nav aria-label="Garment filters"><button value="" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">All products</button><button value="true" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="available">Available now</button><button value="price_asc" data-cd-on="click" data-cd-action="collection.sort">Price</button></nav><section class="atelier-collection-grid" data-cd-repeat="collection.products"><article data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span></a></article></section><p class="atelier-empty" data-cd-empty-state>No garments match this availability filter.</p></main><section data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="stone oxblood ink"></div></section>`,
  `.atelier-collection{padding:58px 28px;background:#ebe6dd}.atelier-collection>header{display:grid;grid-template-columns:1fr 2fr 1fr;gap:30px;align-items:end}.atelier-collection h1{margin:0;font-family:var(--font-display);font-size:clamp(58px,9vw,124px);font-weight:500;line-height:.82}.atelier-collection>nav{display:flex;gap:20px;margin-top:40px;padding:16px 0;border-top:1px solid;border-bottom:1px solid}.atelier-collection button{padding:8px 0;border:0;background:none}.atelier-collection-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding-top:28px}.atelier-collection-grid article a{color:inherit;text-decoration:none}.atelier-collection-grid article img{width:100%;aspect-ratio:4/5;object-fit:cover}.atelier-collection-grid article h2{font-family:var(--font-display);font-size:30px;font-weight:500}.atelier-collection-grid article p{line-height:1.55}@media(max-width:760px){.atelier-collection{padding:42px 16px}.atelier-collection>header{grid-template-columns:1fr}.atelier-collection>nav{overflow:auto}.atelier-collection-grid{grid-template-columns:1fr 1fr}}`,
  "collection",
);

const product = route(
  `<main class="atelier-product"><section class="atelier-product-media"><img data-cd-src="product.primaryImage" data-cd-alt="product.title">${detailVideo.html}<div class="atelier-product-thumbs" data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title"></div></section><article class="atelier-product-record"><p>Garment record / live variant</p><h1 data-cd-text="product.title"></h1><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><p data-cd-text="product.description"></p><section class="atelier-measurements"><h2>Live size options</h2><p>Variant names and availability come from the live catalog. The fit finder records a shopper preference only.</p><div class="atelier-variant-list" data-cd-repeat="product.variants"><div class="atelier-variant-row" data-cd-key="variant.id"><b data-cd-text="variant.title"></b><span data-cd-text="variant.availability"></span></div></div></section><section id="atelier-fit-finder" class="atelier-fit-finder" data-cd-state-id="fit-profile" data-cd-state-type="enum" data-cd-state-initial="regular" data-cd-state-values="close regular relaxed" data-cd-bind-state="fit-profile" data-cd-bind-property="classToken"><h2>Fit finder</h2><p>Choose how you prefer a garment to sit. This guidance does not measure your body or choose a size.</p><div class="atelier-fit-preferences"><button value="close" data-cd-on="click" data-cd-action="state.set" data-cd-state="fit-profile">Closer</button><button value="regular" data-cd-on="click" data-cd-action="state.set" data-cd-state="fit-profile">Regular</button><button value="relaxed" data-cd-on="click" data-cd-action="state.set" data-cd-state="fit-profile">Relaxed</button></div><div class="atelier-fit-steps" data-cd-state-id="fit-step" data-cd-state-type="index" data-cd-state-initial="0" data-cd-state-min="0" data-cd-state-max="2" data-cd-bind-state="fit-step" data-cd-bind-property="activeIndex"><section><h3>Silhouette preference</h3><p>Select closer, regular, or relaxed above.</p></section><section><h3>Layering preference</h3><p>Consider what you expect to wear underneath; this changes your preferred ease, not the live variant facts.</p></section><aside class="atelier-fit-result"><h3>Preference guidance</h3><p><b>Guidance confidence: preference only.</b></p><p><span class="atelier-result-close">You chose a closer silhouette.</span><span class="atelier-result-regular">You chose a regular silhouette.</span><span class="atelier-result-relaxed">You chose a relaxed silhouette.</span></p><p>Confirm the selected live variant and its availability in the variant picker before adding to bag.</p></aside></div><div class="atelier-fit-controls"><button value="back" data-cd-on="click" data-cd-action="state.decrement" data-cd-state="fit-step">Previous</button><button value="next" data-cd-on="click" data-cd-action="state.increment" data-cd-state="fit-step">Next</button></div></section></article></main><section><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="block" data-cd-theme-tokens="stone oxblood ink"></div>${stickyPurchase.html}</section>`,
  `.atelier-product{display:grid;grid-template-columns:1.2fr .8fr;min-height:100vh;background:#ebe6dd}.atelier-product-media{position:sticky;top:72px;align-self:start;display:grid;grid-template-columns:2fr 1fr;gap:8px;padding:16px}.atelier-product-media>img{grid-row:span 2;width:100%;height:78vh;object-fit:cover}.atelier-detail-video{width:100%;height:38vh;object-fit:cover}.atelier-product-thumbs{display:grid;gap:8px}.atelier-product-thumbs img{width:100%;height:19vh;object-fit:cover}.atelier-product-record{padding:70px 6vw 130px;background:#d7d0c6}.atelier-product-record>p:first-child{font-size:11px;letter-spacing:.12em;text-transform:uppercase}.atelier-product-record h1{margin:16px 0;font-family:var(--font-display);font-size:clamp(54px,7vw,104px);font-weight:500;line-height:.82}.atelier-product-record>p{line-height:1.65}.atelier-measurements,.atelier-fit-finder{margin-top:34px;padding-top:24px;border-top:1px solid}.atelier-measurements h2,.atelier-fit-finder h2{font-family:var(--font-display);font-size:32px;font-weight:500}.atelier-variant-row{display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid #7b716a}.atelier-fit-finder button{min-height:44px;margin:4px;padding:10px 14px;border:1px solid;background:transparent}.atelier-fit-finder button:hover{background:#681f2b;color:#fff}.atelier-fit-steps{min-height:170px;margin-top:20px;padding:18px;background:#ebe6dd;border-left:5px solid #681f2b}.atelier-fit-controls{display:flex;justify-content:space-between;margin-top:12px}.atelier-result-close,.atelier-result-regular,.atelier-result-relaxed{display:none}.atelier-fit-finder[data-cd-class-token="close"] .atelier-result-close,.atelier-fit-finder[data-cd-class-token="regular"] .atelier-result-regular,.atelier-fit-finder[data-cd-class-token="relaxed"] .atelier-result-relaxed{display:inline}@media(max-width:900px){.atelier-product{grid-template-columns:1fr}.atelier-product-media{position:static}.atelier-product-record{padding:48px 16px 100px}.atelier-detail-video{height:32vh}}@media(prefers-reduced-motion:reduce){.atelier-product-media{position:static}.atelier-detail-video{animation:none}}`,
  "product",
);

const search = route(
  `<main class="atelier-search"><header><p>Search garment records</p><h1>Find a cut, cloth, or layer.</h1><span data-cd-text="search.query"></span></header><div class="atelier-search-controls"><input type="search" name="q" value="" placeholder="Search garments" aria-label="Search garments" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div><section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><div><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open garment record</a></div></article></section><p class="atelier-empty" data-cd-empty-state>No garment records match this search.</p></main>`,
  `.atelier-search{min-height:80vh;padding:70px 28px;background:#ebe6dd}.atelier-search header{max-width:950px}.atelier-search h1{margin:16px 0;font-family:var(--font-display);font-size:clamp(58px,9vw,124px);font-weight:500;line-height:.82}.atelier-search-controls{display:flex;gap:8px;margin:40px 0}.atelier-search input{flex:1;padding:16px;border:0;border-bottom:1px solid;background:transparent;font-size:20px}.atelier-search button{padding:12px 18px;border:1px solid;background:transparent}.atelier-search article{display:grid;grid-template-columns:160px 1fr;gap:24px;padding:16px 0;border-top:1px solid}.atelier-search article img{width:160px;height:190px;object-fit:cover}.atelier-search article h2{font-family:var(--font-display);font-size:32px;font-weight:500}.atelier-search article a{display:block;margin-top:16px;color:#681f2b}@media(max-width:760px){.atelier-search{padding:48px 16px}.atelier-search-controls{flex-wrap:wrap}.atelier-search article{grid-template-columns:100px 1fr}.atelier-search article img{width:100px;height:130px}}`,
  "search",
);

const story = route(
  `<main class="atelier-story"><header><p>Fit method</p><h1>Start with preference. Confirm the variant.</h1></header><section><article><b>01</b><h2>Start with cloth</h2><p>Fabric weight, stretch, and recovery can change how a silhouette feels in motion.</p></article><article><b>02</b><h2>Name your preference</h2><p>Use closer, regular, or relaxed as guidance for the silhouette you want.</p></article><article><b>03</b><h2>Confirm live facts</h2><p>The selected variant and its availability remain the purchase authority.</p></article></section><a data-cd-route="collection">Open the garment laboratory</a></main>`,
  `.atelier-story{min-height:80vh;padding:80px 6vw;background:#681f2b;color:#f5f0e8}.atelier-story header{max-width:1000px}.atelier-story h1{max-width:11ch;margin:18px 0 70px;font-family:var(--font-display);font-size:clamp(62px,9vw,132px);font-weight:500;line-height:.82}.atelier-story section{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #f5f0e888}.atelier-story article{min-height:300px;padding:26px;border-right:1px solid #f5f0e888}.atelier-story article h2{font-family:var(--font-display);font-size:36px;font-weight:500}.atelier-story article p{line-height:1.65}.atelier-story>a{display:inline-block;margin-top:40px;padding:14px 18px;background:#ebe6dd;color:#27221f;text-decoration:none}@media(max-width:760px){.atelier-story{padding:60px 16px}.atelier-story section{grid-template-columns:1fr}.atelier-story article{min-height:0;border-right:0;border-bottom:1px solid #f5f0e888}}`,
);

const cart = route(
  `<main><header class="atelier-cart-head"><p>Live order ledger</p><h1>Your garments.</h1><span><span data-cd-text="cart.count"></span> pieces</span></header>${cartProgress.html}<section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><div class="atelier-cart-line"><h2 data-cd-text="cartLine.title"></h2><span>Quantity <b data-cd-text="cartLine.quantity"></b></span><strong data-cd-money="cartLine.total"></strong></div><div data-cd-slot="cartLineControls" data-cd-host-size="inline" data-cd-theme-tokens="stone oxblood ink"></div></article></section><p class="atelier-empty" data-cd-empty-state>Your garment ledger is empty.</p><aside class="atelier-cart-subtotal"><span>Subtotal</span><b data-cd-money="cart.subtotal"></b></aside><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="stone oxblood ink"></div></main>`,
  `.atelier-cart-head{display:flex;justify-content:space-between;align-items:end;gap:20px;padding:70px 6vw 20px;background:#ebe6dd}.atelier-cart-head h1{margin:0;font-family:var(--font-display);font-size:clamp(62px,9vw,124px);font-weight:500;line-height:.82}.atelier-cart-progress{display:flex;justify-content:space-between;gap:20px;margin:40px 6vw;padding:18px;background:#681f2b;color:#fff}.atelier-cart-line{display:grid;grid-template-columns:1fr auto auto;gap:24px;align-items:center;padding:20px 6vw;border-top:1px solid}.atelier-cart-line h2{margin:0;font-family:var(--font-display);font-size:30px;font-weight:500}.atelier-cart-subtotal{display:flex;justify-content:flex-end;gap:40px;padding:24px 6vw;border-top:1px solid}@media(max-width:760px){.atelier-cart-head{display:block;padding:50px 16px 20px}.atelier-cart-progress{display:grid;margin:30px 16px}.atelier-cart-line{grid-template-columns:1fr;padding:20px 16px}}`,
  "cart",
);

const checkout = {
  html: `<div class="atelier-checkout"><header><span data-cd-text="store.name"></span><p>Secure garment checkout</p><h1>Confirm the fit. Complete the order.</h1></header><aside><h2>Order summary</h2><p>Live price, delivery, tax, and payment remain platform-owned.</p></aside><footer data-cd-policy-links></footer></div>`,
  css: `.atelier-checkout{display:grid;grid-template-columns:2fr 1fr;min-height:480px;background-color:#ebe6dd;color:#27221f}.atelier-checkout header{padding:70px 48px}.atelier-checkout h1{max-width:640px;font-family:var(--font-display);font-size:64px;font-weight:500;line-height:.86}.atelier-checkout aside{padding:70px 34px;background-color:#681f2b;color:#fff}.atelier-checkout footer{display:flex;gap:18px;padding:20px;background-color:#27221f;color:#fff}.atelier-checkout footer a{color:#fff}@media(max-width:760px){.atelier-checkout{grid-template-columns:1fr}.atelier-checkout h1{font-size:48px}}`,
  layout: {
    columnMode: "summaryAside" as const,
    sectionOrder: [
      "contact",
      "shipping",
      "delivery",
      "consent",
      "payment",
      "summary",
    ],
    spacingTokenId: "space-fit",
    surfaceTokenIds: ["stone", "oxblood", "ink"],
  },
} satisfies RecipeConfig<"atelier">["surfaces"]["checkout"]["source"];

const notFound = route(
  `<main class="atelier-not-found"><p>Garment record / 404</p><h1>This study is not on the table.</h1><span>The live collection may have changed.</span><a data-cd-route="collections">Return to the garment index</a></main>`,
  `.atelier-not-found{display:grid;place-content:center;min-height:80vh;padding:40px;background:#d7d0c6;text-align:center}.atelier-not-found h1{max-width:10ch;margin:18px auto;font-family:var(--font-display);font-size:clamp(62px,9vw,120px);font-weight:500;line-height:.82}.atelier-not-found a{justify-self:center;margin-top:26px;padding:14px 18px;background:#681f2b;color:#fff;text-decoration:none}`,
);

export const ATELIER_RECIPE_CONFIG = {
  templateId: "atelier",
  templateVersion: 1,
  concept: {
    name: "Atelier Fit Laboratory",
    rationale:
      "A calm garment laboratory pairs shopper-entered silhouette preferences with live apparel variants without editorial-magazine theatrics.",
    noveltySignature: [
      "shopper-entered fit preference",
      "preference-only confidence record",
      "calm moving fabric studies",
      "protected live-variant purchase",
    ],
  },
  designSystem: {
    displayFontId: "space-grotesk",
    bodyFontId: "newsreader",
    tokens: {
      stone: "#ebe6dd",
      "stone-deep": "#d7d0c6",
      oxblood: "#681f2b",
      ink: "#27221f",
      "space-fit": "24px",
    },
    breakpoints: { mobile: 760, wide: 1280 },
    iconStyle: "measured garment marks and restrained fit notation",
    motionStyle:
      "calm fabric loops, measured reveals, and reduced-motion pinned posters",
    globalCss: `.atelier-empty{padding:40px 0;line-height:1.5}`,
  },
  archetype: {
    composition: "fit-laboratory",
    hero: "fabric-study-hero",
    scroll: "fit-study",
    cards: "garment-studies",
    iconography: ["measured garment marks", "restrained fit notation"],
  },
  surfaces: {
    shell: {
      signature:
        "measured stone masthead with compact garment navigation and protected bag drawer",
      source: shell,
    },
    home: {
      signature:
        "full-cloth film study flowing into a calm context diptych and live garment grid",
      source: home,
    },
    collections: {
      signature:
        "use-led garment index above a quiet four-column live product sample",
      source: collections,
    },
    collection: {
      signature:
        "availability-led laboratory header above an even live garment matrix",
      source: collection,
    },
    product: {
      signature:
        "sticky fabric bench beside preference guidance and protected live variant purchase",
      source: product,
    },
    search: {
      signature:
        "large cloth-and-cut query followed by compact horizontal garment records",
      source: search,
    },
    story: {
      signature:
        "oxblood three-stage method for cloth comparison and confidence disclosure",
      source: story,
    },
    cart: {
      signature:
        "live garment ledger with shipping progress and protected line controls",
      source: cart,
    },
    checkout: {
      signature:
        "stone checkout field with oxblood summary and platform-owned completion",
      source: checkout,
    },
    notFound: {
      signature:
        "centered missing-study notice returning shoppers to the garment index",
      source: notFound,
    },
  },
  assets: ATELIER_ASSETS,
} satisfies RecipeConfig<"atelier">;
