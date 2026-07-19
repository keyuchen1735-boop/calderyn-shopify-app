import { defineRecipe, type RecipeConfig } from "../factory";
import { SOFT_CHEMISTRY_ASSETS } from "./assets";

const shell = {
  html: `<header class="head"><span class="niche-icon visually-hidden" aria-hidden="true">○</span><span class="visually-hidden" data-cd-text="store.name"></span><a class="brand" data-cd-route="home">Soft Chemistry</a><nav class="nav"><a class="quiet" data-cd-route="collection">Skin</a><a class="quiet" data-cd-route="collection">Body</a><a class="quiet" data-cd-route="search">Ingredients</a><a class="quiet" data-cd-route="home">Our standard</a></nav><div class="tools"><a class="quiet" data-cd-route="search">Search</a><a class="visually-hidden" data-cd-route="account" tabindex="-1" aria-hidden="true">Account</a><a class="quiet bag-link" data-cd-route="cart">Bag (<span data-cd-text="cart.count"></span>)</a></div></header><aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="milk ink yellow"></aside><footer class="visually-hidden" data-cd-policy-links></footer>`,
  css: `.head{position:absolute;inset:0 0 auto;z-index:30;height:78px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 25px;color:#fff;border-bottom:1px solid #ffffff4d}.brand{color:inherit;font-family:Georgia,serif;font-size:31px;font-weight:500;letter-spacing:.02em;text-decoration:none}.nav,.tools{display:flex;gap:24px}.nav{justify-content:center}.tools{justify-content:flex-end}.quiet{padding:7px 0;border:0;background:none;color:inherit;font-size:10px;text-transform:uppercase;letter-spacing:.08em;text-decoration:none;white-space:nowrap}.visually-hidden,.visually-hidden a{color:inherit;text-decoration:none}footer.visually-hidden{display:flex;visibility:hidden}@media(max-width:780px){.head{height:64px;padding:0 14px;grid-template-columns:1fr auto}.nav .quiet,.tools .quiet:not(.bag-link){display:none}.brand{font-size:26px}}`,
  requiredData: [],
  requiredCapabilities: [],
};

const home = {
  html: `<main><section class="hero"><img data-cd-asset="hero" alt="Glass skincare bottles in a luminous formulation studio"><div class="hero-copy"><span class="hero-eyebrow kicker">Formulation note 07 · barrier ritual</span><h1 class="hero-title">Skin, in its softer state.</h1><p class="hero-body">High-touch formulas for low-noise routines. Explore the live collection by concern, texture, or place in ritual.</p><a class="cta cta-label" data-cd-route="collection">Enter the formulation studio <b>→</b></a></div><div class="orbital" aria-hidden="true"><span class="molecule m1">Beta<br>glucan</span><span class="molecule m2">Oat<br>lipids</span><span class="molecule m3">PHA<br>3%</span></div></section><section class="ritual"><div class="ritual-copy"><span class="kicker">Build a quiet ritual</span><h2>Three steps. Nothing extra.</h2><a class="cta" data-cd-route="collection">Begin with your skin</a></div><div class="formula-stack" data-cd-repeat="featured.products"><a class="sheet" data-cd-key="product.id" data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><h3 data-cd-text="product.title"></h3><span class="visually-hidden" data-cd-text="product.description"></span><b><span data-cd-text="product.availability"></span> · <span data-cd-money="product.price"></span></b></a></div></section><p class="empty" data-cd-empty-state>No formulas.</p><section class="concerns"><a class="concern" data-cd-route="collection"><small>Concern 01</small><span>Dryness</span></a><a class="concern" data-cd-route="collection"><small>Concern 02</small><span>Barrier</span></a><a class="concern" data-cd-route="collection"><small>Concern 03</small><span>Texture</span></a><a class="concern" data-cd-route="collection"><small>Concern 04</small><span>Scalp</span></a></section><section class="products"><div class="section-head"><h2>The current formulas</h2></div><div class="rail" data-cd-repeat="featured.products"><article class="card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><div class="card-info"><h3 data-cd-text="product.title"></h3><span class="visually-hidden" data-cd-text="product.description"></span><b data-cd-money="product.price"></b></div></a></article></div></section></main>`,
  css: `.hero{position:relative;min-height:100svh;overflow:hidden;background:#4a3a50;color:#fff}.hero>img{position:absolute;inset:0;height:100%;width:100%;object-fit:cover;filter:saturate(.78)}.hero:after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,#281d2cab,transparent 66%),linear-gradient(0deg,#21172694,transparent 50%)}.hero-copy{position:absolute;z-index:2;left:5vw;bottom:8vh;max-width:880px}.kicker{text-transform:uppercase;font-size:10px;letter-spacing:.12em}.hero h1{max-width:8ch;margin:12px 0 20px;font-family:Georgia,serif;font-size:clamp(76px,12vw,174px);font-weight:500;line-height:.69;letter-spacing:-.06em}.hero p{max-width:48ch;line-height:1.65}.cta{display:inline-flex;gap:50px;align-items:center;margin-top:14px;padding:14px 17px;border:1px solid;background:var(--yellow);color:var(--ink);font-weight:700;text-transform:uppercase;font-size:10px;text-decoration:none}.orbital{position:absolute;right:7vw;top:20%;z-index:3;width:310px;height:310px;border:1px solid #ffffff7c;border-radius:50%;animation:spin 30s linear infinite}.orbital:before,.orbital:after{content:'';position:absolute;border:1px solid #ffffff55;border-radius:50%}.orbital:before{inset:42px}.orbital:after{inset:95px}.molecule{position:absolute;width:77px;height:77px;display:grid;place-items:center;border:1px solid #fff8;border-radius:50%;background:#33263988;backdrop-filter:blur(10px);font-family:Georgia,serif;font-size:17px;font-weight:500;text-align:center;animation:counter-spin 30s linear infinite}.m1{left:-25px;top:50px}.m2{right:-30px;top:130px}.m3{bottom:-10px;left:95px}@keyframes spin{to{transform:rotate(360deg)}}@keyframes counter-spin{to{transform:rotate(-360deg)}}.ritual{display:grid;grid-template-columns:34% 66%;min-height:640px;background:linear-gradient(135deg,#dacdf0,#e7eef0);border-bottom:1px solid #544b5c}.ritual-copy{padding:70px 4vw}.ritual-copy h2{max-width:8ch;margin:13px 0;font-family:Georgia,serif;font-size:clamp(60px,8vw,100px);font-weight:500;line-height:.8;letter-spacing:-.05em}.ritual-copy p{max-width:40ch;line-height:1.7}.formula-stack{position:relative;min-height:640px;overflow:hidden}.sheet{position:absolute;width:54%;min-width:310px;padding:22px;border:1px solid #ffffffb3;background:#ffffffa8;color:inherit;text-decoration:none;box-shadow:0 30px 70px #4b365e22;backdrop-filter:blur(20px);transition:transform .35s}.sheet:hover{transform:translateY(-8px)!important}.sheet:nth-child(3n+1){left:5%;top:8%;transform:rotate(-5deg)}.sheet:nth-child(3n+2){left:30%;top:18%;transform:rotate(4deg)}.sheet:nth-child(3n){left:17%;top:43%;transform:rotate(-1deg)}.sheet img{height:270px;width:100%;object-fit:cover}.sheet h3{margin:12px 0 4px;font-family:Georgia,serif;font-size:34px;font-weight:500}.sheet b{font-size:11px}.concerns{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid}.concern{min-height:230px;display:flex;flex-direction:column;justify-content:space-between;padding:22px;border-right:1px solid;background:none;color:inherit;text-align:left;text-decoration:none}.concern:hover{background:var(--yellow)}.concern span{font-family:Georgia,serif;font-size:42px;font-weight:500}.concern small{text-transform:uppercase}.products{padding:65px 0;background:#211b25;color:#fff}.section-head{display:flex;justify-content:space-between;align-items:end;padding:0 25px 22px}.section-head h2{margin:0;font-family:Georgia,serif;font-size:clamp(54px,7vw,94px);font-weight:500;line-height:.8}.section-head p{max-width:42ch;line-height:1.6}.rail{display:flex;overflow:auto;padding:0 25px;gap:14px;scroll-snap-type:x mandatory}.card{flex:0 0 29%;min-width:310px;scroll-snap-align:start}.card>a{display:block;color:inherit;text-decoration:none}.card img{height:430px;width:100%;object-fit:cover}.card-info{display:grid;grid-template-columns:1fr auto;gap:5px;padding:13px 3px}.card h3{margin:0;font-family:Georgia,serif;font-size:27px;font-weight:500}.card small{grid-column:1/-1;color:#cfc7d3;line-height:1.5}.empty{padding:55px 20px;text-align:center}.ritual-return{display:block;margin:10px;padding:8px 11px;border:1px solid #fff5;background:#231e27;color:#fff;font-size:10px}@media(max-width:780px){.hero{min-height:780px}.hero-copy{left:18px;right:18px;bottom:50px}.orbital{width:220px;height:220px;right:-35px;top:17%}.molecule{width:60px;height:60px;font-size:14px}.ritual{grid-template-columns:1fr}.ritual-copy{padding:55px 18px 20px}.formula-stack{min-height:610px}.sheet{width:78%}.sheet:nth-child(3n+1){left:2%}.sheet:nth-child(3n+2){left:20%}.sheet:nth-child(3n){left:8%}.concerns{grid-template-columns:1fr 1fr}.concern{min-height:170px}.section-head{display:block;padding-inline:18px}.card{min-width:78vw;flex-basis:78vw}}@media(prefers-reduced-motion:reduce){.orbital,.molecule{animation:none}.sheet{transition:none}}`,
  requiredData: [],
  requiredCapabilities: [],
};

home.html = home.html.replace(
  `<section class="hero"><img data-cd-asset="hero" alt="Glass skincare bottles in a luminous formulation studio"><div class="hero-copy">`,
  `<section class="hero"><figure class="hero-visual"><img data-cd-asset="hero" alt="Glass skincare bottles in a luminous formulation studio"></figure><div class="hero-copy">`,
);
home.css += `.hero-visual{position:absolute;inset:0;margin:0}.hero-visual>img{height:100%;width:100%;object-fit:cover;filter:saturate(.78)}`;

const collection = {
  html: `<main><section class="col-head"><img data-cd-asset="collection" alt="Minimal skincare formulations in a studio"><div class="col-copy"><span class="kicker">Concern / barrier + hydration</span><h1 data-cd-text="collection.title"></h1></div></section><div class="shop"><aside class="filters"><h3>Filter the ritual</h3><button value="all" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">All formulas</button><button value="cleanse" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Cleanse</button><button value="treat" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Treat</button><button value="moisturize" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Moisturize</button><button value="fragrance-free" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Fragrance free</button></aside><section><div class="catalog-head"><b><span data-cd-text="collection.productCount"></span> live formulas</b><button value="relevance" data-cd-on="click" data-cd-action="collection.sort">Ritual order</button></div><div class="grid" data-cd-repeat="collection.products"><article class="card" data-cd-key="product.id"><a data-cd-route="product" data-cd-param-handle="product.handle"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><div class="card-info"><h2 data-cd-text="product.title"></h2><span class="visually-hidden" data-cd-text="product.description"></span><b data-cd-money="product.price"></b><small data-cd-text="product.availability"></small></div></a></article></div><p class="empty" data-cd-empty-state>No formulas found.</p></section></div><section class="commerce-contract" data-cd-repeat="collection.products"><div data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="milk ink yellow"></div></section></main>`,
  css: `.col-head{position:relative;height:460px;color:#fff;overflow:hidden}.col-head img{height:100%;width:100%;object-fit:cover}.col-head:after{content:'';position:absolute;inset:0;background:#241a2d66}.col-copy{position:absolute;z-index:2;left:4vw;bottom:45px}.col-head h1{max-width:9ch;margin:8px 0;font-family:Georgia,serif;font-size:clamp(72px,10vw,130px);font-weight:500;line-height:.74}.shop{display:grid;grid-template-columns:250px 1fr}.filters{padding:24px;border-right:1px solid}.filters h3{font-family:Georgia,serif;font-size:28px;font-weight:500}.filters button{display:block;width:100%;padding:11px 0;border:0;border-bottom:1px solid #aaa;background:none;text-align:left;font-size:10px;text-transform:uppercase}.catalog-head{height:58px;display:flex;justify-content:space-between;align-items:center;padding:0 16px;border-bottom:1px solid}.catalog-head button{padding:8px;border:1px solid;background:none}.grid{display:grid;grid-template-columns:repeat(3,1fr)}.grid .card{min-width:0;padding-bottom:16px;border-right:1px solid;border-bottom:1px solid}.grid .card>a{color:inherit;text-decoration:none}.grid .card img{width:100%;aspect-ratio:4/5;object-fit:cover}.grid .card-info{display:grid;grid-template-columns:1fr auto;gap:5px;padding:13px}.grid h2{margin:0;font-family:Georgia,serif;font-size:27px;font-weight:500}.grid small{grid-column:1/-1;color:#675e6a;line-height:1.5}.empty{padding:55px 20px;text-align:center}@media(max-width:780px){.col-head{height:390px}.shop{grid-template-columns:1fr}.filters{display:flex;gap:18px;overflow:auto;border-right:0;border-bottom:1px solid}.filters h3{display:none}.filters button{min-width:max-content}.grid{grid-template-columns:1fr 1fr}.grid .card-info{grid-template-columns:1fr}}`,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "collection" as const,
};

const product = {
  html: `<main class="overlay open"><section class="panel wide"><div class="panel-head"><b>Formula dossier / PDP</b><a class="close" data-cd-route="collection" aria-label="Close">×</a></div><div class="pdp" tabindex="0" aria-label="Product details"><section class="gallery"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><span class="badge" data-cd-text="product.availability"></span><div class="thumbs"><img data-cd-asset="texture" alt="Formula texture detail"><div class="product-thumbs" data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title"></div></div></section><article class="detail"><span class="kicker">Formula</span><h1 data-cd-text="product.title"></h1><b data-cd-money="product.price"></b><p data-cd-text="product.description"></p></article></div></section></main><section><div data-cd-slot="variantPicker" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="milk ink yellow"></div><div data-cd-slot="addToCart" data-cd-product="product.id" data-cd-host-size="inline" data-cd-theme-tokens="milk ink yellow"></div></section>`,
  css: `.overlay{inset:0;z-index:70;background:#17111bba;backdrop-filter:blur(5px)}.panel{position:absolute;right:0;top:0;width:min(490px,100%);height:100%;overflow:auto;background:var(--milk)}.wide{left:50%;right:auto;top:50%;width:min(1090px,calc(100% - 26px));height:min(770px,calc(100% - 26px));transform:translate(-50%,-50%)}.panel-head{height:60px;display:flex;justify-content:space-between;align-items:center;padding:0 19px;border-bottom:1px solid;text-transform:uppercase;font-size:10px}.close{display:grid;width:34px;height:34px;place-items:center;border:1px solid;color:inherit;font-size:18px;text-decoration:none}.pdp{display:grid;grid-template-columns:1.05fr .95fr;height:calc(100% - 60px)}.gallery{position:relative;display:grid;grid-template-columns:1fr 82px;min-height:0;background:#ddd}.gallery>img{height:100%;width:100%;object-fit:cover}.thumbs{padding:7px;background:var(--milk)}.thumbs img{height:92px;width:100%;margin-bottom:7px;object-fit:cover}.badge{position:absolute;left:18px;top:18px;padding:7px 9px;background:var(--yellow);font-size:9px;text-transform:uppercase}.detail{padding:34px 34px 104px;overflow:auto}.detail h1{margin:8px 0;font-family:Georgia,serif;font-size:52px;font-weight:500;line-height:.82}.detail p{display:-webkit-box;max-width:42ch;overflow:hidden;line-height:1.65;-webkit-box-orient:vertical;-webkit-line-clamp:3}@media(max-width:780px){.wide{width:calc(100% - 12px);height:calc(100% - 12px)}.pdp{grid-template-columns:1fr;overflow:auto}.gallery{min-height:48vh}.detail{overflow:visible}.detail h1{font-size:48px}}`,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "product" as const,
};

const search = {
  html: `<main><div class="search"><header><span class="kicker">Search formulas</span><h1>Find a formula.</h1><span class="visually-hidden" data-cd-text="search.query"></span></header><div class="search-controls"><input aria-label="Formula search" type="search" name="q" placeholder="Try ‘barrier’" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Search</button><button class="visually-hidden" tabindex="-1" aria-hidden="true" value="clear" data-cd-on="click" data-cd-action="search.clear">Clear</button></div><section data-cd-repeat="search.results"><article class="result" data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><b data-cd-text="product.title"></b><span class="visually-hidden" data-cd-text="product.description"></span><strong data-cd-money="product.price"></strong><a data-cd-route="product" data-cd-param-handle="product.handle">Open dossier</a></article></section><p class="empty" data-cd-empty-state>No formulas found.</p></div></main>`,
  css: `.search{min-height:100svh;padding:120px 28px 28px}.search h1{margin:12px 0;font-family:Georgia,serif;font-size:clamp(58px,8vw,110px);font-weight:500;line-height:.82}.search-controls{display:flex;gap:9px}.search input{width:100%;padding:14px 0;border:0;border-bottom:1px solid;background:none;font-family:Georgia,serif;font-size:38px;outline:0}.search-controls button{min-width:88px;padding:10px 14px;border:1px solid;background:none;white-space:nowrap}.result{display:grid;grid-template-columns:75px minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid}.result img{height:86px;width:75px;object-fit:cover}.result b{font-family:Georgia,serif;font-size:19px}.result small{display:block}.result>a{grid-column:2;color:inherit;font-size:10px;text-transform:uppercase}.empty{padding:55px 20px;text-align:center}@media(max-width:780px){.search{padding-top:96px}.search-controls{flex-wrap:wrap}.result{grid-template-columns:75px 1fr}}`,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "search" as const,
};

const cart = {
  html: `<main><header class="ritual-cart"><span class="kicker">Your ritual</span><h1>Bag</h1><p><span data-cd-text="cart.count"></span> formulas</p></header><section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><div class="line"><b data-cd-text="cartLine.title"></b><span class="visually-hidden" data-cd-text="cartLine.quantity"></span><b data-cd-money="cartLine.total"></b></div><div data-cd-slot="cartLineControls" data-cd-host-size="inline" data-cd-theme-tokens="milk ink yellow"></div></article></section><p class="empty" data-cd-empty-state>Your ritual is empty.</p><div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="milk ink yellow"></div></main>`,
  css: `.ritual-cart{padding:120px 28px 24px}.ritual-cart h1{margin:12px 0;font-family:Georgia,serif;font-size:clamp(58px,8vw,110px);font-weight:500;line-height:.82}.line{display:grid;grid-template-columns:1fr auto;gap:13px;padding:15px 28px;border-bottom:1px solid}.line small{display:block}.cart-intro{padding:34px 28px;background:var(--lilac);border-top:1px solid var(--ink)}.cart-intro h2{font-family:Georgia,serif;font-size:40px;font-weight:500;line-height:.9}.empty{padding:55px 28px}@media(max-width:780px){.ritual-cart{padding-top:96px}}`,
  requiredData: [],
  requiredCapabilities: [],
  rootScopeKind: "cart" as const,
};

const checkout = {
  html: `<div class="checkout-frame"><span class="visually-hidden" data-cd-text="store.name"></span><div class="checkout-hero"><header class="checkout-head"><span class="kicker">Contact + shipping</span><h1>Checkout.</h1></header><aside class="summary"><b>Order summary</b></aside></div><footer data-cd-policy-links></footer></div>`,
  css: `.checkout-hero{display:grid;grid-template-columns:2fr 1fr;padding-top:78px}.checkout-head{min-height:360px;padding:48px;background-color:var(--milk);color:var(--ink)}.checkout-head h1{margin:12px 0;font-family:var(--font-display);font-size:54px;font-weight:500;line-height:.9}.summary{padding:34px;background-color:var(--lilac);border-width:1px;border-style:solid;border-color:var(--ink)}.summary p{line-height:1.6}.checkout-frame>footer{display:flex;justify-content:space-between;gap:18px;padding:18px;background-color:var(--ink);color:var(--milk)}.checkout-frame>footer a{color:var(--milk);text-decoration:none}@media(max-width:780px){.checkout-hero{grid-template-columns:1fr;padding-top:96px}}`,
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
    spacingTokenId: "space-clinical",
    surfaceTokenIds: ["milk", "ink", "lilac", "blue", "yellow"],
  },
} satisfies RecipeConfig<"soft-chemistry">["surfaces"]["checkout"]["source"];

export const SOFT_CHEMISTRY_RECIPE = defineRecipe({
  templateId: "soft-chemistry",
  templateVersion: 7,
  concept: {
    name: "Soft Chemistry",
    rationale:
      "A full-bleed formulation studio turns live skincare into a quiet ritual without changing the merchant's catalog facts.",
    noveltySignature: [
      "orbiting ingredient hero",
      "stacked formula sheets",
      "concern index",
      "horizontal formula rail",
    ],
  },
  designSystem: {
    displayFontId: "source-serif-4",
    bodyFontId: "inter",
    tokens: {
      milk: "#f4f0eb",
      ink: "#231e27",
      lilac: "#c8b6e9",
      blue: "#a7d7e7",
      yellow: "#ecff5b",
      "space-clinical": "24px",
    },
    breakpoints: { mobile: 780, wide: 1180 },
    iconStyle: "fine ingredient diagrams and quiet clinical symbols",
    motionStyle:
      "slow orbital ingredient motion, stacked formula lift, and horizontal snap rails",
    globalCss: `.clinical-copy{overflow-wrap:anywhere}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}`,
  },
  archetype: {
    composition: "clinical-editorial",
    hero: "ingredient-routine-hero",
    scroll: "soft-reveal",
    cards: "ingredient-dossiers",
    iconography: ["fine ingredient diagrams", "quiet clinical symbols"],
  },
  surfaces: {
    shell: {
      signature:
        "absolute glass-line masthead over the full-bleed formulation studio",
      source: shell,
    },
    home: {
      signature:
        "full-bleed ingredient orbit flowing through stacked formula sheets and a dark product rail",
      source: home,
    },
    collection: {
      signature:
        "photographic concern header above a filter rail and strict three-column formula catalog",
      source: collection,
    },
    product: {
      signature:
        "full-height formula gallery beside the live dossier and protected purchase controls",
      source: product,
    },
    search: {
      signature:
        "large ingredient query field above compact photographic formula results",
      source: search,
    },
    cart: {
      signature:
        "quiet ritual ledger with protected line controls and live summary",
      source: cart,
    },
    checkout: {
      signature: "two-column clinical checkout with a lilac-blue order summary",
      source: checkout,
    },
  },
  assets: SOFT_CHEMISTRY_ASSETS,
} satisfies RecipeConfig<"soft-chemistry">);

export const SOFT_CHEMISTRY_BUNDLE = SOFT_CHEMISTRY_RECIPE.bundle;
