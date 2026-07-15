import { defineRecipe, type RecipeConfig } from "../factory";
import { ROOM_MODES_ASSETS } from "./assets";

const config = {
  templateId: "room-modes",
  templateVersion: 1,
  concept: {
    name: "Room Modes",
    rationale: "A spatial storefront that begins with room scenes, then resolves into a precise object index.",
    noveltySignature: ["room-mode-scenes", "spatial-snap", "architectural-object-index"],
  },
  designSystem: {
    displayFontId: "space-grotesk",
    bodyFontId: "ibm-plex-mono",
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
          <header class="room-masthead">
            <span class="niche-icon niche-icon--room" aria-hidden="true">&#8962;</span>
            <a class="room-brand type-display" data-cd-route="home" data-cd-text="store.name">Room Modes</a>
            <nav class="room-nav" aria-label="Store navigation">
              <a data-cd-route="home">Scenes</a>
              <a data-cd-route="collection">Objects</a>
              <a data-cd-route="search">Search</a>
              <a data-cd-route="account">Account</a>
              <a data-cd-route="cart">Cart <span data-cd-text="cart.count"></span></a>
            </nav>
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
          <main class="room-state" data-cd-state-id="room-mode" data-cd-state-type="enum" data-cd-state-initial="living" data-cd-state-values="living studio sleep" data-cd-bind-state="room-mode" data-cd-bind-property="classToken">
            <section class="scene-hero">
              <figure class="scene-image"><img data-cd-asset="hero" alt="Connected living room arranged as a product scene" width="1600" height="1200"></figure>
              <div class="scene-copy resilient-copy">
                <small class="protocol-copy">Welcome mode</small>
                <h1 class="type-display">Light that reads the room.</h1>
                <p>Connected objects shape a space, then recede when the room settles.</p>
                <a data-cd-route="collection">Open the object index</a>
              </div>
            </section>
            <nav class="mode-rail" aria-label="Room modes">
              <button value="living" data-cd-on="click" data-cd-action="state.set" data-cd-state="room-mode">Living</button>
              <button value="studio" data-cd-on="click" data-cd-action="state.set" data-cd-state="room-mode">Studio</button>
              <button value="sleep" data-cd-on="click" data-cd-action="state.set" data-cd-state="room-mode">Sleep</button>
              <span>Scene view</span><span>Object index</span>
            </nav>
            <section aria-label="Objects in this room" data-cd-repeat="featured.products">
              <article data-cd-key="product.id">
                <img data-cd-src="product.primaryImage" data-cd-alt="product.title" loading="lazy" width="640" height="640">
                <h2 data-cd-text="product.title"></h2><b data-cd-money="product.price"></b>
                <span data-cd-text="product.availability"></span>
                <a data-cd-route="product" data-cd-param-handle="product.handle">Inspect object</a>
                <div data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></div>
              </article>
            </section>
            <p class="home-empty resilient-copy">No objects match this room mode. Try the complete object index.</p>
          </main>
        `,
        css: `
          .scene-hero{display:grid;grid-template-columns:1.25fr .75fr;min-height:78dvh;background:var(--smoke);color:var(--chalk)}
          .scene-image{margin:0;min-width:0}.scene-image img{display:block;width:100%;height:78dvh;object-fit:cover}.scene-copy{align-self:end;padding:clamp(1.5rem,5vw,5rem)}.scene-copy a{color:var(--chalk)}
          .scene-copy h1{font-size:clamp(3.7rem,8vw,8.5rem);max-width:7ch}.mode-rail{display:flex;gap:.5rem;padding:1rem;overflow:auto;background:var(--chalk)}
          .mode-rail button{border:1px solid var(--line);background:transparent;padding:.75rem 1.1rem}.mode-rail span{padding:.75rem;color:var(--smoke)}
          .room-state[data-cd-class-token="living"] .scene-copy{border-right:6px solid var(--amber)}.room-state[data-cd-class-token="studio"] .scene-copy{border-right:6px solid var(--blue)}.room-state[data-cd-class-token="sleep"] .scene-copy{border-right:6px solid var(--violet)}
          .home-empty,.resilient-copy{overflow-wrap:anywhere}.home-empty{padding:1.25rem;border-top:1px solid var(--line)}
          @media(max-width:700px){.scene-hero{grid-template-columns:1fr}.scene-image img{height:52dvh}.scene-copy h1{font-size:3.6rem}.mode-rail{scroll-snap-type:x mandatory}}
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
          <main>
            <header class="object-index resilient-copy"><small class="protocol-copy">Live merchant collection</small><h1 data-cd-text="collection.title"></h1><p data-cd-text="collection.description"></p><b data-cd-text="collection.productCount"></b></header>
            <nav class="facet-bench" aria-label="Collection filters">
              <button value="living" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Living</button>
              <button value="studio" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="category">Studio</button>
              <button value="matter" data-cd-on="click" data-cd-action="collection.filter" data-cd-facet="tag">Matter</button>
              <button value="title_asc" data-cd-on="click" data-cd-action="collection.sort">Architect order</button>
            </nav>
            <section class="object-matrix" data-cd-repeat="collection.products">
              <article data-cd-key="product.id">
                <img data-cd-src="product.primaryImage" data-cd-alt="product.title" loading="lazy" width="720" height="620">
                <h2 data-cd-text="product.title"></h2><b data-cd-money="product.price"></b><span data-cd-text="product.availability"></span>
                <a data-cd-route="product" data-cd-param-handle="product.handle">View object</a>
                <div data-cd-slot="quickViewCommerce" data-cd-product="product.id" data-cd-host-size="inline"></div>
              </article>
            </section>
            <p class="collection-empty resilient-copy">No objects match this room mode. Clear a protocol filter to continue.</p><p class="sold-key">Sold out objects remain visible for compatibility planning.</p>
          </main>
        `,
        css: `
          .object-index{display:grid;grid-template-columns:1.2fr .8fr;gap:2rem;padding:clamp(2rem,6vw,6rem)}.object-index h1{font-size:clamp(3.5rem,8vw,8rem)}
          .facet-bench{position:sticky;top:0;display:flex;gap:.5rem;padding:1rem;background:var(--chalk)}.facet-bench button{border:1px solid var(--ink);background:transparent;padding:.7rem}
          .collection-empty,.resilient-copy{overflow-wrap:anywhere}.collection-empty,.sold-key{padding:1rem}
          @media(max-width:700px){.object-index{grid-template-columns:1fr}.facet-bench{overflow:auto}}
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
            <section data-cd-repeat="search.results"><article data-cd-key="product.id"><img data-cd-src="product.primaryImage" data-cd-alt="product.title" width="560" height="420"><h2 data-cd-text="product.title"></h2><p data-cd-text="product.description"></p><b data-cd-money="product.price"></b><a data-cd-route="product" data-cd-param-handle="product.handle">Open result</a></article></section>
            <p class="query-empty resilient-copy">No object or room found. Search a finish, protocol, or collection name.</p>
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
            <p class="cart-empty resilient-copy">No objects selected yet. Return to a room scene to begin.</p>
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

export const ROOM_MODES_RECIPE = defineRecipe(config);
export const ROOM_MODES_BUNDLE = ROOM_MODES_RECIPE.bundle;
