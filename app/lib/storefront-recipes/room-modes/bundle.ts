import sourceTemplate from "../../../../docs/superpowers/prototypes/storefront-recipes/room-modes.html?raw";
import { defineRecipe, sourceTemplateCss, type RecipeConfig } from "../factory";
import { ROOM_MODES_ASSETS } from "./assets";

const config = {
  templateId: "room-modes",
  templateVersion: 10,
  concept: {
    name: "Room Modes",
    rationale: "A spatial storefront that begins with room scenes, then resolves into a precise object index.",
    noveltySignature: ["room-mode-scenes", "spatial-snap", "architectural-object-index"],
  },
  designSystem: {
    displayFontId: "syne",
    bodyFontId: "dm-mono",
    tokens: {
      chalk: "#eef0ed",
      ink: "#111412",
      smoke: "#303634",
      amber: "#f0a52b",
      blue: "#2d63d4",
      violet: "#7251a8",
      line: "#8b918d",
      "space-room": "28px",
    },
    breakpoints: { compact: 700, wide: 1180 },
    iconStyle: "architectural plan marks and protocol indicators",
    motionStyle: "vertical scene snap with reduced-motion linear fallback",
    globalCss: `
      .type-display { letter-spacing:-.055em; line-height:.88 }
      .protocol-copy { font-family:var(--font-body); letter-spacing:.08em; text-transform:uppercase }
    `,
  },
  archetype: {
    composition: "spatial-scenes",
    hero: "room-mode-scene",
    scroll: "spatial-snap",
    cards: "scene-panels",
    iconography: ["architectural plan symbols", "device protocol marks"],
  },
  surfaces: {
    shell: {
      signature: "fixed architectural masthead with object-index navigation and cart utility bay",
      source: {
        html: `
          <header class="site-nav">
            <a class="brand" data-cd-route="home">ROOM / MODES</a>
            <nav class="nav-center"><a data-cd-route="home">Scenes</a><a data-cd-route="collection">Objects</a><a data-cd-route="home">Compatibility</a></nav>
            <button class="mobile-menu" data-cd-route="collection">Menu</button>
            <div class="nav-tools"><button data-cd-route="search">Search ⌕</button><button data-cd-route="cart">Cart <b data-cd-text="cart.count"></b></button></div>
          </header>
          <aside data-cd-slot="cartDrawer" data-cd-host-size="panel" data-cd-theme-tokens="chalk ink amber"></aside>
          <footer data-cd-policy-links></footer>
        `,
        css: `
          .room-masthead{display:flex;align-items:center;gap:1rem;min-height:4rem;padding:.75rem 1rem;border-bottom:1px solid var(--line);background:var(--chalk)}.room-brand{color:var(--ink);font-size:1.4rem;font-weight:700;text-decoration:none}.room-nav{display:flex;gap:1.25rem;margin-left:auto}.room-nav a{color:var(--ink);font-size:.72rem;text-decoration:none;text-transform:uppercase}.room-masthead~footer{display:flex;flex-wrap:wrap;gap:1rem;padding:1rem;border-top:1px solid var(--line)}.room-masthead~footer a{color:var(--ink);text-decoration:none}@media(max-width:720px){.room-masthead{display:grid;gap:.7rem}.room-nav{display:flex;flex-wrap:wrap;gap:.35rem;margin-left:0}.room-nav a{background:var(--chalk);border:1px solid var(--line);padding:.45rem .6rem}}
        `,
        requiredData: [],
        requiredCapabilities: [],
      },
    },
    home: {
      signature: "viewport-height room scene with mode rail, owned hero image, and spatial product hotspots",
      source: {
        html: `
          <main>
            <div class="scene-view">
              <section class="room"><img class="room-bg" data-cd-asset="hero" alt="Modern living room with warm ambient lighting"><div class="room-copy"><span class="eyebrow">Scene 01 / living</span><h1>Light that reads the room.</h1><p>Connected objects with enough presence to shape a space—and enough restraint to disappear into it.</p><button class="cta" data-cd-route="collection">Shop the living room</button></div><span class="scene-index">01 / WELCOME MODE / 18:42</span><button class="hotspot" data-cd-route="collection" aria-label="View Halo Floor Light">+</button><button class="hotspot" data-cd-route="collection" aria-label="View Weave Speaker">+</button><button class="hotspot" data-cd-route="collection" aria-label="View Matter Home Hub">+</button><div class="scene-products"><button class="scene-product" data-cd-route="collection"><small>LIGHT / MATTER</small><b>Halo Floor Light</b><span>$289 · 8 in stock</span></button><button class="scene-product" data-cd-route="collection"><small>AUDIO / WI-FI</small><b>Weave Speaker</b><span>$219 · 5 in stock</span></button><button class="scene-product" data-cd-route="collection"><small>CONTROL / MATTER</small><b>Matter Home Hub</b><span>$149 · 14 in stock</span></button></div></section>
              <section class="room"><img class="room-bg" data-cd-asset="hero" alt="Architectural home workspace with daylight"><div class="room-copy"><span class="eyebrow">Scene 02 / studio</span><h2>Focus, held in space.</h2><p>Quiet monitoring, directional light, and tactile controls for the room where ideas become work.</p><button class="cta" data-cd-route="collection">Shop the studio</button></div><span class="scene-index">02 / FOCUS MODE / 09:16</span><button class="hotspot" data-cd-route="collection">+</button><button class="hotspot" data-cd-route="collection">+</button><div class="scene-products"><button class="scene-product" data-cd-route="collection"><small>LIGHT / DIRECTIONAL</small><b>Line Task Light</b><span>$179 · 11 in stock</span></button><button class="scene-product" data-cd-route="collection"><small>AIR / THREAD</small><b>Air Index Monitor</b><span>$129 · 3 in stock</span></button></div></section>
              <section class="room"><img class="room-bg" data-cd-asset="hero" alt="Minimal bedroom with soft low light"><div class="room-copy"><span class="eyebrow">Scene 03 / sleep</span><h2>Technology after dark.</h2><p>Low-glare, silent, and designed to make the room feel less connected when the day is done.</p><button class="cta" data-cd-route="collection">Shop the sleep room</button></div><span class="scene-index">03 / UNWIND MODE / 22:08</span><button class="hotspot" data-cd-route="collection">+</button><button class="hotspot" data-cd-route="collection">+</button><div class="scene-products"><button class="scene-product" data-cd-route="collection"><small>TIME / LOW GLARE</small><b>Quiet Bedside Clock</b><span>$98 · 20 in stock</span></button><button class="scene-product" data-cd-route="collection"><small>LIGHT / MATTER</small><b>Halo Floor Light</b><span>$289 · 8 in stock</span></button></div></section>
            </div>
            <section class="catalog-view"><div class="catalog-head"><div><span class="eyebrow">Live merchant collection</span><h1>Objects for living systems.</h1></div><p>Browse canonical products by room, protocol, finish, and real variant availability.</p></div><div class="catalog-tools"><div class="chips"><button class="chip" value="all" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">All objects</button><button class="chip" value="living" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Living</button><button class="chip" value="studio" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Studio</button><button class="chip" value="sleep" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Sleep</button><button class="chip" value="matter" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Matter</button></div><select aria-label="Sort products" value="relevance" data-cd-on="change" data-cd-action="collection.sort"><option value="featured">Architect's order</option><option value="low">Price low → high</option><option value="high">Price high → low</option></select></div><div class="product-grid" data-cd-repeat="featured.products"><article class="product" data-cd-key="product.id"><div class="product-media"><img data-cd-src="product.primaryImage" data-cd-alt="product.title"><span class="badge">LIVE OBJECT</span></div><div class="product-info"><h3 data-cd-text="product.title"></h3><b data-cd-money="product.price"></b><small class="stock" data-cd-text="product.availability"></small><p class="product-copy" data-cd-text="product.description"></p><a class="object-action" data-cd-route="product" data-cd-param-handle="product.handle">+</a></div></article></div><p class="home-empty resilient-copy" data-cd-empty-state>No objects match this room mode.</p></section>
          </main>
          <nav class="control-dock"><div class="room-controls"><button class="room-control" data-cd-route="home"><i>01</i><span><b>Living</b><small>WELCOME MODE</small></span></button><button class="room-control" data-cd-route="home"><i>02</i><span><b>Studio</b><small>FOCUS MODE</small></span></button><button class="room-control" data-cd-route="home"><i>03</i><span><b>Sleep</b><small>UNWIND MODE</small></span></button></div><div class="view-toggle"><button data-cd-route="home">Scene view</button><button data-cd-route="collection">Object index</button></div></nav>
          <section data-cd-repeat="featured.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></aside></section>
        `,
        css: `
          .scene-hero{position:relative;display:grid;min-height:100dvh;overflow:hidden;background:var(--smoke);color:var(--chalk)}.scene-hero:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(17,20,18,.72),transparent 70%)}
          .scene-image{position:absolute;inset:0;margin:0}.scene-image img{display:block;width:100%;height:100%;object-fit:cover}.scene-copy{position:relative;z-index:1;align-self:center;padding:clamp(1.5rem,5vw,5rem)}.scene-copy a{color:var(--chalk)}
          .scene-copy h1{font-size:clamp(3.7rem,8vw,8.5rem);max-width:7ch}.mode-rail{position:sticky;z-index:2;bottom:0;display:flex;gap:.5rem;padding:1rem;overflow:auto;background:var(--chalk)}
          .mode-rail button{border:1px solid var(--line);background:transparent;padding:.75rem 1.1rem}.mode-rail span{padding:.75rem;color:var(--smoke)}
          .room-state[data-cd-class-token="living"] .scene-copy{border-right:6px solid var(--amber)}.room-state[data-cd-class-token="studio"] .scene-copy{border-right:6px solid var(--blue)}.room-state[data-cd-class-token="sleep"] .scene-copy{border-right:6px solid var(--violet)}
          .home-empty,.resilient-copy{overflow-wrap:anywhere}.home-empty{padding:1.25rem;border-top:1px solid var(--line)}
          @media(max-width:700px){.scene-copy h1{font-size:3.6rem}.mode-rail{scroll-snap-type:x mandatory}}
          @media(prefers-reduced-motion:reduce){.mode-rail{scroll-snap-type:none}}
        `,
        requiredData: [],
        requiredCapabilities: [],
      },
    },
    collection: {
      signature: "technical object index with sticky protocol facets and three-column scene-panel matrix",
      source: {
        html: `
          <main class="catalog-view">
            <header class="object-index catalog-head resilient-copy"><div class="object-index-copy"><small class="protocol-copy">Live merchant collection</small><h1 data-cd-text="collection.title"></h1><b data-cd-text="collection.productCount"></b></div><p data-cd-text="collection.description"></p></header>
            <nav class="facet-bench catalog-tools" aria-label="Collection filters">
              <div class="facet-chips"><button value="living" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Living</button>
              <button value="studio" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Studio</button>
              <button value="matter" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Matter</button></div>
              <button value="title_asc" data-cd-on="click" data-cd-action="collection.sort">Architect order</button>
            </nav>
            <div class="object-catalog"><section class="object-matrix product-grid" data-cd-repeat="collection.products">
              <article class="product" data-cd-key="product.id">
                <div class="product-media"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" loading="lazy" width="720" height="620"><span class="badge">LIVE OBJECT</span></div>
                <div class="product-info"><h3 data-cd-text="product.title"></h3><b data-cd-money="product.price"></b><small class="stock" data-cd-text="product.availability"></small><p class="product-copy" data-cd-text="product.description"></p><a class="object-action" data-cd-route="product" data-cd-param-handle="product.handle">+</a></div>
              </article>
            </section></div>
            <p class="collection-empty resilient-copy" data-cd-empty-state>No objects match this room mode. Clear a protocol filter to continue.</p>
          </main>
          <section data-cd-repeat="collection.products"><aside data-cd-key="product.id" data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></aside></section>
        `,
        css: `
          .catalog-view{min-height:100dvh;padding:115px 3.5vw 4rem}.catalog-head{display:grid;grid-template-columns:1.2fr .8fr;align-items:end;gap:30px;margin-bottom:46px}.catalog-head h1{max-width:9ch;margin:6px 0 0;font-size:clamp(55px,7vw,98px);line-height:.84;letter-spacing:-.075em}.catalog-head p{margin:0;max-width:42ch}.object-index-copy b{display:block;margin-top:1rem}
          .catalog-tools{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:12px 0;border-top:1px solid var(--ink);border-bottom:1px solid var(--ink)}.facet-chips{display:flex;gap:.5rem;overflow:auto}.facet-bench button{min-width:max-content;border:1px solid var(--ink);background:transparent;padding:.7rem}
          .object-catalog{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.object-matrix{display:contents}
          .product{border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:#f7f8f5;--commerce-surface:#f7f8f5;--commerce-foreground:var(--ink);--commerce-accent:var(--amber);--commerce-accent-foreground:var(--ink)}.product-media{position:relative;aspect-ratio:1.15/1;overflow:hidden}.product-media img{width:100%;height:100%;object-fit:cover}.badge{position:absolute;left:10px;top:10px;padding:5px 7px;background:var(--ink);color:#fff;font:8px var(--font-body)}.product-info{display:grid;grid-template-columns:1fr auto;gap:5px 14px;padding:14px}.product-info h3{margin:0;font-size:18px}.product-info small{font:9px var(--font-body);color:#68716c}.product-copy{grid-column:1/-1;margin:0}.object-action{grid-column:2;grid-row:1/3;display:grid;place-items:center;width:42px;background:var(--amber);color:var(--ink);font-size:20px}
          .collection-empty,.resilient-copy{overflow-wrap:anywhere}.collection-empty{padding:1rem}
          @media(max-width:700px){.object-index,.object-catalog{grid-template-columns:1fr}.catalog-view{padding:90px 14px 3rem}.catalog-tools{display:grid}.facet-bench{overflow:auto}}
        `,
        requiredData: [],
        requiredCapabilities: [],
      },
    },
    product: {
      signature: "room-scale image runway beside protocol dossier, variant station, and fixed purchase controls",
      source: {
        html: `
          <main>
            <section class="room-gallery" data-cd-repeat="product.images"><figure data-cd-key="product.primaryImage"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="900" height="900"></figure></section>
            <header class="object-dossier resilient-copy"><small class="protocol-copy">Object protocol</small><h1 data-cd-text="product.title"></h1><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><p>Sold out variants stay documented so a room plan remains useful.</p></header>
            <section data-cd-repeat="product.variants"><div data-cd-key="variant.id"><b data-cd-text="variant.title"></b><span data-cd-text="variant.availability"></span><strong data-cd-money="variant.price"></strong></div></section>
            <div data-cd-slot="variantPicker" data-cd-host-size="block" data-cd-theme-tokens="chalk ink amber"></div>
            <div data-cd-slot="addToCart" data-cd-host-size="block" data-cd-theme-tokens="chalk ink amber"></div>
            <a class="related-link" data-cd-route="collection">Return to room objects</a>
          </main>
        `,
        css: `
          .room-gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:2px;background:var(--smoke)}.room-gallery figure{margin:0}.room-gallery img{display:block;width:100%;height:min(72dvh,780px);object-fit:cover}
          .object-dossier{max-width:62rem;padding:clamp(1.5rem,5vw,5rem)}.object-dossier h1{font-size:clamp(3rem,7vw,7rem)}.object-dossier,.resilient-copy{overflow-wrap:anywhere}.related-link{display:inline-block;margin:2rem}
          @media(max-width:700px){.room-gallery{grid-template-columns:1fr}.room-gallery img{height:52dvh}}
        `,
        requiredData: [],
        requiredCapabilities: [],
        rootScopeKind: "product",
      },
    },
    search: {
      signature: "architectural query board with protocol language, ranked object strips, and explicit empty room",
      source: {
        html: `
          <main>
            <header class="query-board resilient-copy"><small class="protocol-copy">Search room, object, protocol, or finish</small><h1 data-cd-text="search.query">Object search</h1><input aria-label="Object search" type="search" name="q" value="" placeholder="Room, object, protocol, or finish" data-cd-on="input" data-cd-action="search.update"><button value="submit" data-cd-on="click" data-cd-action="search.submit">Run object query</button><button value="clear" data-cd-on="click" data-cd-action="search.clear">Clear room query</button></header>
            <section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="560" height="420"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span><a data-cd-route="product" data-cd-param-handle="product.handle">Open result</a></article></section>
            <p class="query-empty resilient-copy" data-cd-empty-state>No object or room found. Search a finish, protocol, or collection name.</p>
          </main>
        `,
        css: `
          .query-board{padding:clamp(2rem,8vw,7rem);border-bottom:1px solid var(--ink)}.query-board h1{font-size:clamp(3.4rem,8vw,8rem)}.query-board input,.query-board button{margin-right:.5rem;padding:.8rem;border:1px solid var(--ink);background:transparent}
          .query-board,.query-empty,.resilient-copy{overflow-wrap:anywhere}.query-empty{padding:2rem}
        `,
        requiredData: [],
        requiredCapabilities: [],
        rootScopeKind: "search",
      },
    },
    cart: {
      signature: "object selection ledger with image-led line records, synchronized controls, and room summary",
      source: {
        html: `
          <main>
            <header class="cart-room resilient-copy"><small class="protocol-copy">Objects selected</small><h1>Your room plan</h1><span data-cd-text="cart.count"></span></header>
            <section data-cd-repeat="cart.lines"><article data-cd-key="cartLine.id"><h2 data-cd-text="cartLine.title"></h2><span data-cd-text="cartLine.quantity"></span><b data-cd-money="cartLine.unitPrice"></b><strong data-cd-money="cartLine.total"></strong><div data-cd-slot="cartLineControls" data-cd-host-size="inline"></div></article></section>
            <aside class="cart-totals resilient-copy"><span>Subtotal</span><b data-cd-money="cart.subtotal"></b><span>Total</span><strong data-cd-money="cart.total"></strong></aside>
            <div data-cd-slot="cartSummary" data-cd-host-size="page" data-cd-theme-tokens="chalk ink amber"></div>
            <p class="cart-empty resilient-copy" data-cd-empty-state>No objects selected yet. Return to a room scene to begin.</p>
          </main>
        `,
        css: `
          .cart-room{padding:clamp(2rem,7vw,6rem)}.cart-room h1{font-size:clamp(3.5rem,8vw,7rem)}.cart-totals{display:grid;grid-template-columns:1fr auto;gap:1rem;max-width:34rem;margin:2rem 2rem 2rem auto}
          .cart-room,.cart-totals,.cart-empty,.resilient-copy{overflow-wrap:anywhere}.cart-empty{padding:2rem;border-top:1px solid var(--line)}
        `,
        requiredData: [],
        requiredCapabilities: [],
        rootScopeKind: "cart",
      },
    },
    checkout: {
      signature: "calm two-column room handoff with architectural trust rail and platform checkout summary",
      source: {
        html: `<header class="checkout-room resilient-copy"><small class="protocol-copy">Secure room handoff</small><h1 data-cd-text="store.name">Room Modes</h1><p>Your selected objects remain grouped by room while the platform completes contact, delivery, and payment.</p></header><aside class="trust-rail"><b>Tracked delivery</b><span>Compatibility notes retained</span><span>Encrypted payment</span></aside><footer data-cd-policy-links></footer>`,
        css: `.checkout-room{padding:48px;max-width:768px}.checkout-room h1{font-size:64px}.trust-rail{display:grid;gap:12px;padding:32px;border-left-width:1px;border-style:solid;border-color:var(--line)}`,
        layout: {
          columnMode: "summaryAside",
          sectionOrder: ["contact", "shipping", "delivery", "consent", "payment", "summary"],
          spacingTokenId: "space-room",
          surfaceTokenIds: ["chalk", "smoke", "amber"],
        },
      },
    },
  },
  assets: ROOM_MODES_ASSETS,
} satisfies RecipeConfig<"room-modes">;

config.surfaces.home.source.html = config.surfaces.home.source.html.replace(
  "<h1>Light that reads the room.</h1>",
  '<h1 id="heroTitle">Light that reads the room.</h1>',
)
  .replace('<span class="eyebrow">Scene 01 / living</span>', '<span id="heroEyebrow" class="eyebrow">Scene 01 / living</span>')
  .replace('<p>Connected objects with enough presence', '<p id="heroBody">Connected objects with enough presence');
config.surfaces.shell.source.css = sourceTemplateCss(
  sourceTemplate,
  config.surfaces.shell.source.html,
  { display: "Syne", body: "DM Mono" },
);
config.surfaces.home.source.css = sourceTemplateCss(
  sourceTemplate,
  config.surfaces.home.source.html,
  { display: "Syne", body: "DM Mono" },
);
config.surfaces.home.source.css += `.product{--commerce-surface:#f7f8f5;--commerce-foreground:var(--ink);--commerce-accent:var(--amber);--commerce-accent-foreground:var(--ink)}.object-action{grid-column:2;grid-row:1/3;display:grid;place-items:center;width:42px;background:var(--amber);color:var(--ink);font-size:20px}.product-copy{grid-column:1/-1;margin:0}`;

export const ROOM_MODES_RECIPE = defineRecipe(config);
export const ROOM_MODES_BUNDLE = ROOM_MODES_RECIPE.bundle;
