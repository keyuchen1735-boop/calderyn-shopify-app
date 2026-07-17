-- The command-only runtime has no experiment controls and no runtime-0
-- renderer. Close both legacy states in the same deployment that enforces the
-- runtime-1 release pointer guard.

create temporary table storefront_runtime1_cutover_shop_ids on commit drop as
select page.shop_id
from public.page_document page
where page.published_json is not null
  or page.draft_json is not null
union
select publication.shop_id
from public.designer_publications publication
union
select release.shop_id
from public.storefront_release release
where release.draft_version_id is not null
  or release.published_version_id is not null
union
select experiment.shop_id
from public.store_experiment experiment
where experiment.state = 'running';

select public.lock_storefront_design_shop(shop_id)
from storefront_runtime1_cutover_shop_ids
order by shop_id;

update public.store_experiment
set state = 'stopped',
    decision_note = coalesce(nullif(decision_note, ''), 'Stopped during the runtime-1 storefront cutover'),
    decided_at = coalesce(decided_at, now())
where state = 'running';

create temporary table storefront_runtime1_cutover_targets on commit drop as
with legacy_public as (
  select page.shop_id
  from public.page_document page
  where page.published_json is not null
  union
  select publication.shop_id
  from public.designer_publications publication
), legacy_draft as (
  select page.shop_id
  from public.page_document page
  where page.draft_json is not null
)
select
  candidate.shop_id,
  release.draft_version_id as previous_draft_version_id,
  release.published_version_id as previous_published_version_id,
  legacy_public.shop_id is not null
    or release.published_version_id is not null as requires_published_version
from storefront_runtime1_cutover_shop_ids candidate
left join legacy_public
  on legacy_public.shop_id = candidate.shop_id
left join legacy_draft
  on legacy_draft.shop_id = candidate.shop_id
left join public.storefront_release release
  on release.shop_id = candidate.shop_id
left join public.storefront_bundle_version draft
  on draft.shop_id = release.shop_id
  and draft.id = release.draft_version_id
left join public.storefront_bundle_version published
  on published.shop_id = release.shop_id
  and published.id = release.published_version_id
where (
    legacy_public.shop_id is not null
    and (
      published.id is null
      or published.status <> 'validated'
      or published.schema_version <> 1
      or published.runtime_version <> 1
      or published.validation_profile_version <> 1
      or published.source_kind not in ('recipe', 'custom')
    )
  )
  or (
    (legacy_draft.shop_id is not null or release.draft_version_id is not null)
    and (
      draft.id is null
      or draft.status <> 'validated'
      or draft.schema_version <> 1
      or draft.runtime_version <> 1
      or draft.validation_profile_version <> 1
      or draft.source_kind not in ('recipe', 'custom')
    )
  )
  or (
    release.published_version_id is not null
    and (
      published.id is null
      or published.status <> 'validated'
      or published.schema_version <> 1
      or published.runtime_version <> 1
      or published.validation_profile_version <> 1
      or published.source_kind not in ('recipe', 'custom')
    )
  );

-- Keep the immutable active recipe bytes in the migration itself: an all-legacy
-- database has no tenant recipe row to clone.
create temporary table storefront_runtime1_cutover_seed_payload on commit drop as
select
  'recipe'::text as source_kind,
  'custom-bench'::text as template_id,
  2::integer as template_version,
  1::integer as schema_version,
  1::integer as runtime_version,
  1::integer as validation_profile_version,
  'sha256:df3d9aa6a162ab14ed05879a5f79d1563598a936ea3d240a21a6a70acb9d7217'::text as artifact_hash,
  $storefront_runtime1_seed${"sourceKind":"recipe","bundle":{"schemaVersion":1,"runtimeVersion":1,"validationProfileVersion":1,"source":{"kind":"recipe","templateId":"custom-bench","templateVersion":2},"concept":{"name":"Custom Bench","rationale":"A workshop interface turns personalization into a legible proofing sequence.","noveltySignature":["step configurator","material specimen index","work-order cart ledger"]},"designSystem":{"displayFontId":"space-grotesk","bodyFontId":"ibm-plex-mono","tokens":{"cobalt":"#2148ff","ink":"#11100e","line":"#746f65","paper":"#eee9dd","rule":"#746f65","signal":"#b83a29","space-workshop":"20px"},"breakpoints":{"mobile":760,"wide":1180},"iconStyle":"square workshop glyphs and dimension-line indicators","motionStyle":"guided proof steps with restrained horizontal specimen rails","globalCss":"[data-cd-bundle=global] .recipe-copy { overflow-wrap: anywhere }"},"shell":{"html":"\n    <header class=\"workshop-shell\" id=\"cd-shell-n1\">\n      <a class=\"brand-mark\" data-cd-route-target=\"0\" id=\"cd-shell-n2\"><span aria-hidden=\"true\" class=\"niche-icon niche-icon--bench\" id=\"cd-shell-n3\">▦</span><span data-cd-bind-text=\"cd-shell-binding-1\" id=\"cd-shell-n4\"></span><b id=\"cd-shell-n5\">Custom Bench</b></a>\n      <nav aria-label=\"Primary navigation\" class=\"workshop-nav\" id=\"cd-shell-n6\">\n        <a data-cd-route-target=\"1\" id=\"cd-shell-n7\">Objects</a>\n        <a data-cd-route-target=\"2\" id=\"cd-shell-n8\">Search</a>\n        <a data-cd-route-target=\"3\" id=\"cd-shell-n9\">Account</a>\n        <a data-cd-route-target=\"4\" id=\"cd-shell-n10\">Cart <span data-cd-bind-text=\"cd-shell-binding-2\" id=\"cd-shell-n11\"></span></a>\n      </nav>\n      <div data-cd-trusted-slot-id=\"cd-shell-slot-1\" id=\"cd-shell-slot-1\"></div>\n    </header>\n    <footer class=\"workshop-footer\" id=\"cd-shell-n12\"><span data-cd-bind-text=\"cd-shell-binding-3\" id=\"cd-shell-n13\"></span><nav data-cd-platform-content=\"policyLinks\" id=\"cd-shell-n14\"></nav></footer>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-shell-n1","tag":"header","attributes":{"class":"workshop-shell"},"children":[{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-shell-n2","tag":"a","attributes":{"class":"brand-mark","data-cd-route-target":"0"},"children":[{"kind":"element","id":"cd-shell-n3","tag":"span","attributes":{"aria-hidden":"true","class":"niche-icon niche-icon--bench"},"children":[{"kind":"text","value":"▦"}]},{"kind":"element","id":"cd-shell-n4","tag":"span","attributes":{"data-cd-bind-text":"cd-shell-binding-1"},"children":[]},{"kind":"element","id":"cd-shell-n5","tag":"b","attributes":{},"children":[{"kind":"text","value":"Custom Bench"}]}],"routeTarget":{"routeId":"home","params":{}}},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-shell-n6","tag":"nav","attributes":{"aria-label":"Primary navigation","class":"workshop-nav"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-shell-n7","tag":"a","attributes":{"data-cd-route-target":"1"},"children":[{"kind":"text","value":"Objects"}],"routeTarget":{"routeId":"collection","params":{}}},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-shell-n8","tag":"a","attributes":{"data-cd-route-target":"2"},"children":[{"kind":"text","value":"Search"}],"routeTarget":{"routeId":"search","params":{}}},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-shell-n9","tag":"a","attributes":{"data-cd-route-target":"3"},"children":[{"kind":"text","value":"Account"}],"routeTarget":{"routeId":"account","params":{}}},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-shell-n10","tag":"a","attributes":{"data-cd-route-target":"4"},"children":[{"kind":"text","value":"Cart "},{"kind":"element","id":"cd-shell-n11","tag":"span","attributes":{"data-cd-bind-text":"cd-shell-binding-2"},"children":[]}],"routeTarget":{"routeId":"cart","params":{}}},{"kind":"text","value":"\n      "}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-shell-slot-1","tag":"div","attributes":{"data-cd-trusted-slot-id":"cd-shell-slot-1"},"children":[],"trustedSlotId":"cd-shell-slot-1"},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-shell-n12","tag":"footer","attributes":{"class":"workshop-footer"},"children":[{"kind":"element","id":"cd-shell-n13","tag":"span","attributes":{"data-cd-bind-text":"cd-shell-binding-3"},"children":[]},{"kind":"element","id":"cd-shell-n14","tag":"nav","attributes":{"data-cd-platform-content":"policyLinks"},"children":[]}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-shell-binding-1","targetId":"cd-shell-n4","kind":"text","ref":{"kind":"data","scopeId":"root","path":"store.name"}},{"id":"cd-shell-binding-2","targetId":"cd-shell-n11","kind":"text","ref":{"kind":"data","scopeId":"root","path":"cart.count"}},{"id":"cd-shell-binding-3","targetId":"cd-shell-n13","kind":"text","ref":{"kind":"data","scopeId":"root","path":"store.name"}}],"css":"\n    [data-cd-bundle=shell] .brand-mark:not([data-cd-bundle-route]):not([data-cd-bundle-route] *) { color: var(--ink); font-family: var(--font-display); font-size: 1.4rem; font-weight: 700; text-decoration: none }\n    [data-cd-bundle=shell] .brand-mark b:not([data-cd-bundle-route]):not([data-cd-bundle-route] *) { color: var(--signal); display: block; font-family: var(--font-body); font-size: .65rem; letter-spacing: .12em; text-transform: uppercase }\n    [data-cd-bundle=shell] .workshop-nav:not([data-cd-bundle-route]):not([data-cd-bundle-route] *) { display: flex; gap: 1.4rem; font-family: var(--font-body); font-size: .72rem; text-transform: uppercase }\n    [data-cd-bundle=shell] .workshop-nav a:not([data-cd-bundle-route]):not([data-cd-bundle-route] *) { color: var(--ink); text-decoration: none }\n    [data-cd-bundle=shell] .workshop-footer span:not([data-cd-bundle-route]):not([data-cd-bundle-route] *) { font-family: var(--font-display); font-weight: 700 }\n    @media(max-width:720px){[data-cd-bundle=shell] .workshop-nav:not([data-cd-bundle-route]):not([data-cd-bundle-route] *){max-width:100%;overflow-x:auto;padding-bottom:.45rem}[data-cd-bundle=shell] .workshop-nav a:not([data-cd-bundle-route]):not([data-cd-bundle-route] *){min-width:max-content}}\n  [data-cd-bundle=shell] .workshop-footer:not([data-cd-bundle-route]):not([data-cd-bundle-route] *){display:flex;justify-content:space-between;gap:1rem;padding:1rem;border-top:1px solid var(--line)}[data-cd-bundle=shell] .workshop-footer nav:not([data-cd-bundle-route]):not([data-cd-bundle-route] *){display:flex;flex-wrap:wrap;gap:1rem}[data-cd-bundle=shell] .workshop-footer a:not([data-cd-bundle-route]):not([data-cd-bundle-route] *){color:var(--ink);text-decoration:none}","requiredData":[{"kind":"storeIdentity"},{"kind":"policyLinks"},{"kind":"cart"}],"requiredCapabilities":["navigation","overlay","commerce"],"interactions":{"version":1,"state":[],"bindings":[],"transitions":[]},"trustedSlots":[{"id":"cd-shell-slot-1","kind":"cartDrawer","hostSize":"panel","themeTokenIds":["ink","cobalt","paper"]}]},"routes":{"home":{"html":"\n    <main class=\"bench-home\" id=\"cd-home-n1\">\n      <section class=\"bench-hero\" id=\"cd-home-n2\">\n        <div class=\"bench-copy\" id=\"cd-home-n3\">\n          <small id=\"cd-home-n4\">Made to order</small>\n          <h1 id=\"cd-home-n5\">Your mark, made real.</h1>\n          <p class=\"recipe-copy\" id=\"cd-home-n6\">Choose the object, set the material, place your mark, then approve the workshop proof.</p>\n          <a class=\"primary-action\" data-cd-route-target=\"0\" id=\"cd-home-n7\">Choose an object</a>\n        </div>\n        <figure class=\"proof-stage\" id=\"cd-home-n8\"><img alt=\"Personalized object on the Custom Bench worktable\" data-cd-asset-key=\"hero\" id=\"cd-home-n9\"><figcaption id=\"cd-home-n10\">Live workshop proof</figcaption></figure>\n      </section>\n      <section class=\"configurator\" id=\"cd-home-configurator\">\n        <h2 id=\"cd-home-n11\">Build the commission</h2>\n        <div class=\"step-rail\" id=\"cd-home-n12\">\n          <button id=\"cd-home-n13\" value=\"choose\">Choose the piece</button>\n          <button id=\"cd-home-n14\" value=\"personalize\">Set your mark</button>\n          <button id=\"cd-home-n15\" value=\"approve\">Approve your proof</button>\n        </div>\n      </section>\n      <section class=\"featured\" id=\"cd-home-n16\"><h2 id=\"cd-home-n17\">Objects on the bench</h2><div class=\"specimen-grid\" data-cd-repeat-id=\"cd-home-scope-1\" id=\"cd-home-n18\">\n        <article id=\"cd-home-n19\"><img data-cd-bind-alt=\"cd-home-binding-2\" data-cd-bind-src=\"cd-home-binding-1\" id=\"cd-home-n20\" loading=\"lazy\"><h3 data-cd-bind-text=\"cd-home-binding-3\" id=\"cd-home-n21\"></h3><p class=\"recipe-copy\" data-cd-bind-text=\"cd-home-binding-4\" id=\"cd-home-n22\"></p><p data-cd-bind-money=\"cd-home-binding-5\" id=\"cd-home-n23\"></p><a data-cd-route-target=\"1\" id=\"cd-home-n24\">Configure</a></article>\n      </div></section>\n      <p class=\"empty-state\" data-cd-empty-state=\"\" id=\"cd-home-n25\">No objects are on the bench yet. Open the catalog to begin.</p>\n      <section data-cd-repeat-id=\"cd-home-scope-2\" id=\"cd-home-n26\"><aside data-cd-trusted-slot-id=\"cd-home-slot-1\" id=\"cd-home-slot-1\"></aside></section>\n      <button id=\"cd-home-n27\">Return to configuration</button>\n    </main>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-home-n1","tag":"main","attributes":{"class":"bench-home"},"children":[{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-n2","tag":"section","attributes":{"class":"bench-hero"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-home-n3","tag":"div","attributes":{"class":"bench-copy"},"children":[{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n4","tag":"small","attributes":{},"children":[{"kind":"text","value":"Made to order"}]},{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n5","tag":"h1","attributes":{},"children":[{"kind":"text","value":"Your mark, made real."}]},{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n6","tag":"p","attributes":{"class":"recipe-copy"},"children":[{"kind":"text","value":"Choose the object, set the material, place your mark, then approve the workshop proof."}]},{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n7","tag":"a","attributes":{"class":"primary-action","data-cd-route-target":"0"},"children":[{"kind":"text","value":"Choose an object"}],"routeTarget":{"routeId":"collection","params":{}}},{"kind":"text","value":"\n        "}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-home-n8","tag":"figure","attributes":{"class":"proof-stage"},"children":[{"kind":"element","id":"cd-home-n9","tag":"img","attributes":{"alt":"Personalized object on the Custom Bench worktable","data-cd-asset-key":"hero"},"children":[]},{"kind":"element","id":"cd-home-n10","tag":"figcaption","attributes":{},"children":[{"kind":"text","value":"Live workshop proof"}]}]},{"kind":"text","value":"\n      "}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-configurator","tag":"section","attributes":{"class":"configurator"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-home-n11","tag":"h2","attributes":{},"children":[{"kind":"text","value":"Build the commission"}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-home-n12","tag":"div","attributes":{"class":"step-rail"},"children":[{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n13","tag":"button","attributes":{"value":"choose"},"children":[{"kind":"text","value":"Choose the piece"}]},{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n14","tag":"button","attributes":{"value":"personalize"},"children":[{"kind":"text","value":"Set your mark"}]},{"kind":"text","value":"\n          "},{"kind":"element","id":"cd-home-n15","tag":"button","attributes":{"value":"approve"},"children":[{"kind":"text","value":"Approve your proof"}]},{"kind":"text","value":"\n        "}]},{"kind":"text","value":"\n      "}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-n16","tag":"section","attributes":{"class":"featured"},"children":[{"kind":"element","id":"cd-home-n17","tag":"h2","attributes":{},"children":[{"kind":"text","value":"Objects on the bench"}]},{"kind":"element","id":"cd-home-n18","tag":"div","attributes":{"class":"specimen-grid","data-cd-repeat-id":"cd-home-scope-1"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-home-n19","tag":"article","attributes":{},"children":[{"kind":"element","id":"cd-home-n20","tag":"img","attributes":{"loading":"lazy","data-cd-bind-src":"cd-home-binding-1","data-cd-bind-alt":"cd-home-binding-2"},"children":[]},{"kind":"element","id":"cd-home-n21","tag":"h3","attributes":{"data-cd-bind-text":"cd-home-binding-3"},"children":[]},{"kind":"element","id":"cd-home-n22","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-home-binding-4"},"children":[]},{"kind":"element","id":"cd-home-n23","tag":"p","attributes":{"data-cd-bind-money":"cd-home-binding-5"},"children":[]},{"kind":"element","id":"cd-home-n24","tag":"a","attributes":{"data-cd-route-target":"1"},"children":[{"kind":"text","value":"Configure"}],"routeTarget":{"routeId":"product","params":{"handle":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.handle"}}}}]},{"kind":"text","value":"\n      "}],"repeat":{"scopeId":"cd-home-scope-1","source":"featured.products","itemKind":"product","keyPath":"product.id"}}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-n25","tag":"p","attributes":{"class":"empty-state","data-cd-empty-state":""},"children":[{"kind":"text","value":"No objects are on the bench yet. Open the catalog to begin."}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-n26","tag":"section","attributes":{"data-cd-repeat-id":"cd-home-scope-2"},"children":[{"kind":"element","id":"cd-home-slot-1","tag":"aside","attributes":{"data-cd-trusted-slot-id":"cd-home-slot-1"},"children":[],"trustedSlotId":"cd-home-slot-1"}],"repeat":{"scopeId":"cd-home-scope-2","source":"featured.products","itemKind":"product","keyPath":"product.id"}},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-home-n27","tag":"button","attributes":{},"children":[{"kind":"text","value":"Return to configuration"}]},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-home-binding-1","targetId":"cd-home-n20","kind":"src","ref":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.primaryImage"}},{"id":"cd-home-binding-2","targetId":"cd-home-n20","kind":"alt","ref":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.title"}},{"id":"cd-home-binding-3","targetId":"cd-home-n21","kind":"text","ref":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.title"}},{"id":"cd-home-binding-4","targetId":"cd-home-n22","kind":"text","ref":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.description"}},{"id":"cd-home-binding-5","targetId":"cd-home-n23","kind":"money","ref":{"kind":"data","scopeId":"cd-home-scope-1","path":"product.price"}}],"css":"\n    [data-cd-bundle=home] .bench-hero { display: grid; grid-template-columns: minmax(0, .82fr) minmax(0, 1.18fr); min-height: 42rem; border-bottom: 1px solid var(--rule) }\n    [data-cd-bundle=home] .bench-copy { align-content: center; display: grid; padding: clamp(2rem, 6vw, 6rem) }\n    [data-cd-bundle=home] .bench-copy h1 { font-family: var(--font-display); font-size: clamp(4rem, 9vw, 8.5rem); line-height: .78; margin: .5rem 0; overflow-wrap: anywhere; text-transform: uppercase }\n    [data-cd-bundle=home] .bench-copy p { max-width: 34rem }\n    [data-cd-bundle=home] .proof-stage img { aspect-ratio: 2 / 1; height: 100%; object-fit: cover }\n    [data-cd-bundle=home] .proof-stage figcaption { background: var(--cobalt); color: var(--paper); font-family: var(--font-body); padding: .7rem }\n    [data-cd-bundle=home] .configurator h2,[data-cd-bundle=home] .featured h2 { font-family: var(--font-display); font-size: clamp(2.5rem, 5vw, 5rem); text-transform: uppercase }\n    [data-cd-bundle=home] .step-rail { display: grid; grid-template-columns: repeat(3, 1fr) }\n    [data-cd-bundle=home] .step-rail button { background: var(--paper); border: 1px solid var(--rule); min-height: 5rem }\n    [data-cd-bundle=home] .configurator[data-cd-class-token=\"choose\"] { border-top: 5px solid var(--cobalt) }\n    [data-cd-bundle=home] .configurator[data-cd-class-token=\"personalize\"] { border-top: 5px solid var(--signal) }\n    [data-cd-bundle=home] .configurator[data-cd-class-token=\"approve\"] { border-top: 5px double var(--ink) }\n    [data-cd-bundle=home] .specimen-grid { display: grid; grid-template-columns: repeat(4, 1fr) }\n    [data-cd-bundle=home] .specimen-grid img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }\n    [data-cd-bundle=home] .configurator { scroll-margin-top:2rem }\n    @media(prefers-reduced-motion:reduce){[data-cd-bundle=home] .configurator{scroll-margin-top:0}}\n    [data-cd-bundle=home] .specimen-grid h3 { font-family: var(--font-display); text-transform: uppercase }\n    @media (max-width: 760px) { [data-cd-bundle=home] .bench-hero { grid-template-columns: 1fr; min-height: 0 } [data-cd-bundle=home] .step-rail { grid-template-columns: 1fr } [data-cd-bundle=home] .specimen-grid { grid-template-columns: 1fr 1fr } }\n  ","requiredData":[{"kind":"featuredProducts","limit":12}],"requiredCapabilities":["navigation","localState","overlay","commerce"],"interactions":{"version":1,"state":[{"id":"cd-home-state-bench-step","type":"enum","initial":"choose","allowedValues":["choose","personalize","approve"]}],"bindings":[{"targetId":"cd-home-configurator","stateId":"cd-home-state-bench-step","property":"classToken"}],"transitions":[{"on":"click","sourceId":"cd-home-n13","action":{"type":"state.set","stateId":"cd-home-state-bench-step","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-home-n14","action":{"type":"state.set","stateId":"cd-home-state-bench-step","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-home-n15","action":{"type":"state.set","stateId":"cd-home-state-bench-step","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-home-n27","action":{"type":"scroll.to","targetId":"cd-home-configurator"}}]},"trustedSlots":[{"id":"cd-home-slot-1","kind":"quickViewCommerce","scopeId":"cd-home-scope-2","hostSize":"panel","themeTokenIds":["ink","cobalt","paper"]}]},"collection":{"html":"\n    <main class=\"workshop-catalog\" id=\"cd-collection-n1\">\n      <header class=\"catalog-intro\" id=\"cd-collection-n2\"><small id=\"cd-collection-n3\">Material specimen index</small><h1 data-cd-bind-text=\"cd-collection-binding-1\" id=\"cd-collection-n4\"></h1><p class=\"recipe-copy\" data-cd-bind-text=\"cd-collection-binding-2\" id=\"cd-collection-n5\"></p><img data-cd-bind-alt=\"cd-collection-binding-4\" data-cd-bind-src=\"cd-collection-binding-3\" id=\"cd-collection-n6\"></header>\n      <aside aria-label=\"Workshop filters\" class=\"filters\" id=\"cd-collection-n7\">\n        <button id=\"cd-collection-n8\" value=\"leather\">Leather</button>\n        <button id=\"cd-collection-n9\" value=\"paper\">Paper</button>\n        <button id=\"cd-collection-n10\" value=\"true\">Ready soon</button>\n        <button id=\"cd-collection-n11\" value=\"price_asc\">Sort by price</button>\n      </aside>\n      <section class=\"catalog-grid\" data-cd-repeat-id=\"cd-collection-scope-1\" id=\"cd-collection-n12\">\n        <article id=\"cd-collection-n13\"><img data-cd-bind-alt=\"cd-collection-binding-6\" data-cd-bind-src=\"cd-collection-binding-5\" id=\"cd-collection-n14\" loading=\"lazy\"><h2 data-cd-bind-text=\"cd-collection-binding-7\" id=\"cd-collection-n15\"></h2><p class=\"recipe-copy\" data-cd-bind-text=\"cd-collection-binding-8\" id=\"cd-collection-n16\"></p><p data-cd-bind-money=\"cd-collection-binding-9\" id=\"cd-collection-n17\"></p><small data-cd-bind-text=\"cd-collection-binding-10\" id=\"cd-collection-n18\"></small><a data-cd-route-target=\"0\" id=\"cd-collection-n19\">Open work order</a><div data-cd-trusted-slot-id=\"cd-collection-slot-1\" id=\"cd-collection-slot-1\"></div></article>\n      </section>\n      <p class=\"empty-state\" data-cd-empty-state=\"\" id=\"cd-collection-n20\">No objects match these workshop filters. Clear a material filter to reopen the bench.</p>\n    </main>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-collection-n1","tag":"main","attributes":{"class":"workshop-catalog"},"children":[{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-collection-n2","tag":"header","attributes":{"class":"catalog-intro"},"children":[{"kind":"element","id":"cd-collection-n3","tag":"small","attributes":{},"children":[{"kind":"text","value":"Material specimen index"}]},{"kind":"element","id":"cd-collection-n4","tag":"h1","attributes":{"data-cd-bind-text":"cd-collection-binding-1"},"children":[]},{"kind":"element","id":"cd-collection-n5","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-collection-binding-2"},"children":[]},{"kind":"element","id":"cd-collection-n6","tag":"img","attributes":{"data-cd-bind-src":"cd-collection-binding-3","data-cd-bind-alt":"cd-collection-binding-4"},"children":[]}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-collection-n7","tag":"aside","attributes":{"aria-label":"Workshop filters","class":"filters"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-collection-n8","tag":"button","attributes":{"value":"leather"},"children":[{"kind":"text","value":"Leather"}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-collection-n9","tag":"button","attributes":{"value":"paper"},"children":[{"kind":"text","value":"Paper"}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-collection-n10","tag":"button","attributes":{"value":"true"},"children":[{"kind":"text","value":"Ready soon"}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-collection-n11","tag":"button","attributes":{"value":"price_asc"},"children":[{"kind":"text","value":"Sort by price"}]},{"kind":"text","value":"\n      "}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-collection-n12","tag":"section","attributes":{"class":"catalog-grid","data-cd-repeat-id":"cd-collection-scope-1"},"children":[{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-collection-n13","tag":"article","attributes":{},"children":[{"kind":"element","id":"cd-collection-n14","tag":"img","attributes":{"loading":"lazy","data-cd-bind-src":"cd-collection-binding-5","data-cd-bind-alt":"cd-collection-binding-6"},"children":[]},{"kind":"element","id":"cd-collection-n15","tag":"h2","attributes":{"data-cd-bind-text":"cd-collection-binding-7"},"children":[]},{"kind":"element","id":"cd-collection-n16","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-collection-binding-8"},"children":[]},{"kind":"element","id":"cd-collection-n17","tag":"p","attributes":{"data-cd-bind-money":"cd-collection-binding-9"},"children":[]},{"kind":"element","id":"cd-collection-n18","tag":"small","attributes":{"data-cd-bind-text":"cd-collection-binding-10"},"children":[]},{"kind":"element","id":"cd-collection-n19","tag":"a","attributes":{"data-cd-route-target":"0"},"children":[{"kind":"text","value":"Open work order"}],"routeTarget":{"routeId":"product","params":{"handle":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.handle"}}}},{"kind":"element","id":"cd-collection-slot-1","tag":"div","attributes":{"data-cd-trusted-slot-id":"cd-collection-slot-1"},"children":[],"trustedSlotId":"cd-collection-slot-1"}]},{"kind":"text","value":"\n      "}],"repeat":{"scopeId":"cd-collection-scope-1","source":"collection.products","itemKind":"product","keyPath":"product.id"}},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-collection-n20","tag":"p","attributes":{"class":"empty-state","data-cd-empty-state":""},"children":[{"kind":"text","value":"No objects match these workshop filters. Clear a material filter to reopen the bench."}]},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-collection-binding-1","targetId":"cd-collection-n4","kind":"text","ref":{"kind":"data","scopeId":"root","path":"collection.title"}},{"id":"cd-collection-binding-2","targetId":"cd-collection-n5","kind":"text","ref":{"kind":"data","scopeId":"root","path":"collection.description"}},{"id":"cd-collection-binding-3","targetId":"cd-collection-n6","kind":"src","ref":{"kind":"data","scopeId":"root","path":"collection.image"}},{"id":"cd-collection-binding-4","targetId":"cd-collection-n6","kind":"alt","ref":{"kind":"data","scopeId":"root","path":"collection.title"}},{"id":"cd-collection-binding-5","targetId":"cd-collection-n14","kind":"src","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.primaryImage"}},{"id":"cd-collection-binding-6","targetId":"cd-collection-n14","kind":"alt","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.title"}},{"id":"cd-collection-binding-7","targetId":"cd-collection-n15","kind":"text","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.title"}},{"id":"cd-collection-binding-8","targetId":"cd-collection-n16","kind":"text","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.description"}},{"id":"cd-collection-binding-9","targetId":"cd-collection-n17","kind":"money","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.price"}},{"id":"cd-collection-binding-10","targetId":"cd-collection-n18","kind":"text","ref":{"kind":"data","scopeId":"cd-collection-scope-1","path":"product.availability"}}],"css":"\n    [data-cd-bundle=collection] .catalog-intro { display: grid; grid-template-columns: 1fr 1fr; min-height: 20rem }\n    [data-cd-bundle=collection] .catalog-intro h1 { font-family: var(--font-display); font-size: clamp(4rem, 9vw, 8rem); line-height: .8; text-transform: uppercase }\n    [data-cd-bundle=collection] .catalog-intro img { height: 20rem; object-fit: cover; width: 100% }\n    [data-cd-bundle=collection] .filters { display: flex; gap: .5rem; overflow-x: auto; padding: 1rem }\n    [data-cd-bundle=collection] .filters button { background: transparent; border: 1px solid var(--rule); padding: .75rem 1rem }\n    [data-cd-bundle=collection] .catalog-grid img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }\n    [data-cd-bundle=collection] .catalog-grid h2 { font-family: var(--font-display); text-transform: uppercase }\n    [data-cd-bundle=collection] .empty-state { border: 1px dashed var(--rule); padding: 2rem; text-align: center }\n    @media (max-width: 760px) { [data-cd-bundle=collection] .catalog-intro { grid-template-columns: 1fr } [data-cd-bundle=collection] .catalog-intro img { height: 14rem } }\n  ","requiredData":[{"kind":"currentCollection"}],"requiredCapabilities":["navigation","localState","overlay","catalogFiltering","commerce"],"interactions":{"version":1,"state":[],"bindings":[],"transitions":[{"on":"click","sourceId":"cd-collection-n8","action":{"type":"collection.filter","facetId":"category","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-collection-n9","action":{"type":"collection.filter","facetId":"category","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-collection-n10","action":{"type":"collection.filter","facetId":"available","value":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-collection-n11","action":{"type":"collection.sort","value":{"kind":"event","field":"value"}}}]},"trustedSlots":[{"id":"cd-collection-slot-1","kind":"quickViewCommerce","scopeId":"cd-collection-scope-1","hostSize":"inline","themeTokenIds":["ink","cobalt","paper"]}]},"product":{"html":"\n    <main class=\"work-order\" id=\"cd-product-n1\">\n      <section class=\"product-gallery\" id=\"cd-product-gallery\"><img data-cd-bind-alt=\"cd-product-binding-2\" data-cd-bind-src=\"cd-product-binding-1\" id=\"cd-product-n2\"><div data-cd-repeat-id=\"cd-product-scope-1\" id=\"cd-product-n3\"><figure id=\"cd-product-n4\"><img data-cd-bind-alt=\"cd-product-binding-4\" data-cd-bind-src=\"cd-product-binding-3\" id=\"cd-product-n5\"></figure></div></section>\n      <section class=\"purchase-sheet\" id=\"cd-product-n6\"><small id=\"cd-product-n7\">Workshop work order</small><h1 data-cd-bind-text=\"cd-product-binding-5\" id=\"cd-product-n8\"></h1><p data-cd-bind-money=\"cd-product-binding-6\" id=\"cd-product-n9\"></p><b data-cd-bind-text=\"cd-product-binding-7\" id=\"cd-product-n10\"></b><p class=\"recipe-copy\" data-cd-bind-text=\"cd-product-binding-8\" id=\"cd-product-n11\"></p><p id=\"cd-product-n12\">Sold out pieces remain visible with their workshop notes, but cannot be added.</p>\n        <div class=\"variant-ledger\" data-cd-repeat-id=\"cd-product-scope-2\" id=\"cd-product-n13\"><span data-cd-bind-text=\"cd-product-binding-9\" id=\"cd-product-n14\"></span></div>\n        <div data-cd-trusted-slot-id=\"cd-product-slot-1\" id=\"cd-product-slot-1\"></div>\n        <div data-cd-trusted-slot-id=\"cd-product-slot-2\" id=\"cd-product-slot-2\"></div>\n      </section>\n      <section class=\"related\" data-cd-repeat-id=\"cd-product-scope-3\" id=\"cd-product-n15\"><article id=\"cd-product-n16\"><img data-cd-bind-alt=\"cd-product-binding-11\" data-cd-bind-src=\"cd-product-binding-10\" id=\"cd-product-n17\"><h2 data-cd-bind-text=\"cd-product-binding-12\" id=\"cd-product-n18\"></h2><p class=\"recipe-copy\" data-cd-bind-text=\"cd-product-binding-13\" id=\"cd-product-n19\"></p><a data-cd-route-target=\"0\" id=\"cd-product-n20\">Continue the collection</a></article></section>\n    </main>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-product-n1","tag":"main","attributes":{"class":"work-order"},"children":[{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-product-gallery","tag":"section","attributes":{"class":"product-gallery"},"children":[{"kind":"element","id":"cd-product-n2","tag":"img","attributes":{"data-cd-bind-src":"cd-product-binding-1","data-cd-bind-alt":"cd-product-binding-2"},"children":[]},{"kind":"element","id":"cd-product-n3","tag":"div","attributes":{"data-cd-repeat-id":"cd-product-scope-1"},"children":[{"kind":"element","id":"cd-product-n4","tag":"figure","attributes":{},"children":[{"kind":"element","id":"cd-product-n5","tag":"img","attributes":{"data-cd-bind-src":"cd-product-binding-3","data-cd-bind-alt":"cd-product-binding-4"},"children":[]}]}],"repeat":{"scopeId":"cd-product-scope-1","source":"product.images","itemKind":"image","keyPath":"product.primaryImage"}}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-product-n6","tag":"section","attributes":{"class":"purchase-sheet"},"children":[{"kind":"element","id":"cd-product-n7","tag":"small","attributes":{},"children":[{"kind":"text","value":"Workshop work order"}]},{"kind":"element","id":"cd-product-n8","tag":"h1","attributes":{"data-cd-bind-text":"cd-product-binding-5"},"children":[]},{"kind":"element","id":"cd-product-n9","tag":"p","attributes":{"data-cd-bind-money":"cd-product-binding-6"},"children":[]},{"kind":"element","id":"cd-product-n10","tag":"b","attributes":{"data-cd-bind-text":"cd-product-binding-7"},"children":[]},{"kind":"element","id":"cd-product-n11","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-product-binding-8"},"children":[]},{"kind":"element","id":"cd-product-n12","tag":"p","attributes":{},"children":[{"kind":"text","value":"Sold out pieces remain visible with their workshop notes, but cannot be added."}]},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-product-n13","tag":"div","attributes":{"class":"variant-ledger","data-cd-repeat-id":"cd-product-scope-2"},"children":[{"kind":"element","id":"cd-product-n14","tag":"span","attributes":{"data-cd-bind-text":"cd-product-binding-9"},"children":[]}],"repeat":{"scopeId":"cd-product-scope-2","source":"product.variants","itemKind":"variant","keyPath":"variant.id"}},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-product-slot-1","tag":"div","attributes":{"data-cd-trusted-slot-id":"cd-product-slot-1"},"children":[],"trustedSlotId":"cd-product-slot-1"},{"kind":"text","value":"\n        "},{"kind":"element","id":"cd-product-slot-2","tag":"div","attributes":{"data-cd-trusted-slot-id":"cd-product-slot-2"},"children":[],"trustedSlotId":"cd-product-slot-2"},{"kind":"text","value":"\n      "}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-product-n15","tag":"section","attributes":{"class":"related","data-cd-repeat-id":"cd-product-scope-3"},"children":[{"kind":"element","id":"cd-product-n16","tag":"article","attributes":{},"children":[{"kind":"element","id":"cd-product-n17","tag":"img","attributes":{"data-cd-bind-src":"cd-product-binding-10","data-cd-bind-alt":"cd-product-binding-11"},"children":[]},{"kind":"element","id":"cd-product-n18","tag":"h2","attributes":{"data-cd-bind-text":"cd-product-binding-12"},"children":[]},{"kind":"element","id":"cd-product-n19","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-product-binding-13"},"children":[]},{"kind":"element","id":"cd-product-n20","tag":"a","attributes":{"data-cd-route-target":"0"},"children":[{"kind":"text","value":"Continue the collection"}],"routeTarget":{"routeId":"product","params":{"handle":{"kind":"data","scopeId":"cd-product-scope-3","path":"product.handle"}}}}]}],"repeat":{"scopeId":"cd-product-scope-3","source":"related.products","itemKind":"product","keyPath":"product.id"}},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-product-binding-1","targetId":"cd-product-n2","kind":"src","ref":{"kind":"data","scopeId":"root","path":"product.primaryImage"}},{"id":"cd-product-binding-2","targetId":"cd-product-n2","kind":"alt","ref":{"kind":"data","scopeId":"root","path":"product.title"}},{"id":"cd-product-binding-3","targetId":"cd-product-n5","kind":"src","ref":{"kind":"data","scopeId":"cd-product-scope-1","path":"product.primaryImage"}},{"id":"cd-product-binding-4","targetId":"cd-product-n5","kind":"alt","ref":{"kind":"data","scopeId":"cd-product-scope-1","path":"product.title"}},{"id":"cd-product-binding-5","targetId":"cd-product-n8","kind":"text","ref":{"kind":"data","scopeId":"root","path":"product.title"}},{"id":"cd-product-binding-6","targetId":"cd-product-n9","kind":"money","ref":{"kind":"data","scopeId":"root","path":"product.price"}},{"id":"cd-product-binding-7","targetId":"cd-product-n10","kind":"text","ref":{"kind":"data","scopeId":"root","path":"product.availability"}},{"id":"cd-product-binding-8","targetId":"cd-product-n11","kind":"text","ref":{"kind":"data","scopeId":"root","path":"product.description"}},{"id":"cd-product-binding-9","targetId":"cd-product-n14","kind":"text","ref":{"kind":"data","scopeId":"cd-product-scope-2","path":"variant.title"}},{"id":"cd-product-binding-10","targetId":"cd-product-n17","kind":"src","ref":{"kind":"data","scopeId":"cd-product-scope-3","path":"product.primaryImage"}},{"id":"cd-product-binding-11","targetId":"cd-product-n17","kind":"alt","ref":{"kind":"data","scopeId":"cd-product-scope-3","path":"product.title"}},{"id":"cd-product-binding-12","targetId":"cd-product-n18","kind":"text","ref":{"kind":"data","scopeId":"cd-product-scope-3","path":"product.title"}},{"id":"cd-product-binding-13","targetId":"cd-product-n19","kind":"text","ref":{"kind":"data","scopeId":"cd-product-scope-3","path":"product.description"}}],"css":"\n    [data-cd-bundle=product] .product-gallery img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }\n    [data-cd-bundle=product] .product-gallery button { background: transparent; border: 1px solid var(--rule); padding: .25rem }\n    [data-cd-bundle=product] .purchase-sheet h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 7vw, 7rem); line-height: .82; text-transform: uppercase }\n    [data-cd-bundle=product] .purchase-sheet p { max-width: 42rem }\n    [data-cd-bundle=product] .variant-ledger span { background: transparent; border: 1px solid var(--rule); display:inline-block; padding: .75rem }\n    [data-cd-bundle=product] .related img { aspect-ratio: 1 / 1; object-fit: cover; width: 100% }\n  ","requiredData":[{"kind":"currentProduct"},{"kind":"relatedProducts","limit":8}],"requiredCapabilities":["navigation","commerce"],"interactions":{"version":1,"state":[],"bindings":[],"transitions":[]},"trustedSlots":[{"id":"cd-product-slot-1","kind":"variantPicker","hostSize":"block","themeTokenIds":["ink","cobalt","paper"]},{"id":"cd-product-slot-2","kind":"addToCart","hostSize":"block","themeTokenIds":["ink","signal","paper"]}]},"search":{"html":"\n    <main class=\"search-bench\" id=\"cd-search-n1\">\n      <header id=\"cd-search-n2\"><small id=\"cd-search-n3\">Search the workshop</small><h1 id=\"cd-search-n4\">Find an object to mark.</h1><p data-cd-bind-text=\"cd-search-binding-1\" id=\"cd-search-n5\"></p></header>\n      <div class=\"query-controls\" id=\"cd-search-n6\" role=\"search\"><span id=\"cd-search-n7\">Workshop query</span><input aria-label=\"Workshop query\" id=\"cd-search-n8\" name=\"q\" placeholder=\"Object, material, or occasion\" type=\"search\" value=\"\"><button id=\"cd-search-n9\" value=\"submit\">Search</button><button id=\"cd-search-n10\" value=\"clear\">Clear</button></div>\n      <section class=\"ranked-results\" data-cd-repeat-id=\"cd-search-scope-1\" id=\"cd-search-n11\"><article id=\"cd-search-n12\"><img data-cd-bind-alt=\"cd-search-binding-3\" data-cd-bind-src=\"cd-search-binding-2\" id=\"cd-search-n13\"><h2 data-cd-bind-text=\"cd-search-binding-4\" id=\"cd-search-n14\"></h2><p class=\"recipe-copy\" data-cd-bind-text=\"cd-search-binding-5\" id=\"cd-search-n15\"></p><p data-cd-bind-money=\"cd-search-binding-6\" id=\"cd-search-n16\"></p><a data-cd-route-target=\"0\" id=\"cd-search-n17\">Open result</a></article></section>\n      <p class=\"empty-state\" data-cd-empty-state=\"\" id=\"cd-search-n18\">No workshop results yet. Try an object, material, or occasion.</p>\n    </main>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-search-n1","tag":"main","attributes":{"class":"search-bench"},"children":[{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-search-n2","tag":"header","attributes":{},"children":[{"kind":"element","id":"cd-search-n3","tag":"small","attributes":{},"children":[{"kind":"text","value":"Search the workshop"}]},{"kind":"element","id":"cd-search-n4","tag":"h1","attributes":{},"children":[{"kind":"text","value":"Find an object to mark."}]},{"kind":"element","id":"cd-search-n5","tag":"p","attributes":{"data-cd-bind-text":"cd-search-binding-1"},"children":[]}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-search-n6","tag":"div","attributes":{"class":"query-controls","role":"search"},"children":[{"kind":"element","id":"cd-search-n7","tag":"span","attributes":{},"children":[{"kind":"text","value":"Workshop query"}]},{"kind":"element","id":"cd-search-n8","tag":"input","attributes":{"aria-label":"Workshop query","name":"q","placeholder":"Object, material, or occasion","type":"search","value":""},"children":[]},{"kind":"element","id":"cd-search-n9","tag":"button","attributes":{"value":"submit"},"children":[{"kind":"text","value":"Search"}]},{"kind":"element","id":"cd-search-n10","tag":"button","attributes":{"value":"clear"},"children":[{"kind":"text","value":"Clear"}]}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-search-n11","tag":"section","attributes":{"class":"ranked-results","data-cd-repeat-id":"cd-search-scope-1"},"children":[{"kind":"element","id":"cd-search-n12","tag":"article","attributes":{},"children":[{"kind":"element","id":"cd-search-n13","tag":"img","attributes":{"data-cd-bind-src":"cd-search-binding-2","data-cd-bind-alt":"cd-search-binding-3"},"children":[]},{"kind":"element","id":"cd-search-n14","tag":"h2","attributes":{"data-cd-bind-text":"cd-search-binding-4"},"children":[]},{"kind":"element","id":"cd-search-n15","tag":"p","attributes":{"class":"recipe-copy","data-cd-bind-text":"cd-search-binding-5"},"children":[]},{"kind":"element","id":"cd-search-n16","tag":"p","attributes":{"data-cd-bind-money":"cd-search-binding-6"},"children":[]},{"kind":"element","id":"cd-search-n17","tag":"a","attributes":{"data-cd-route-target":"0"},"children":[{"kind":"text","value":"Open result"}],"routeTarget":{"routeId":"product","params":{"handle":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.handle"}}}}]}],"repeat":{"scopeId":"cd-search-scope-1","source":"search.results","itemKind":"product","keyPath":"product.id"}},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-search-n18","tag":"p","attributes":{"class":"empty-state","data-cd-empty-state":""},"children":[{"kind":"text","value":"No workshop results yet. Try an object, material, or occasion."}]},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-search-binding-1","targetId":"cd-search-n5","kind":"text","ref":{"kind":"data","scopeId":"root","path":"search.query"}},{"id":"cd-search-binding-2","targetId":"cd-search-n13","kind":"src","ref":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.primaryImage"}},{"id":"cd-search-binding-3","targetId":"cd-search-n13","kind":"alt","ref":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.title"}},{"id":"cd-search-binding-4","targetId":"cd-search-n14","kind":"text","ref":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.title"}},{"id":"cd-search-binding-5","targetId":"cd-search-n15","kind":"text","ref":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.description"}},{"id":"cd-search-binding-6","targetId":"cd-search-n16","kind":"money","ref":{"kind":"data","scopeId":"cd-search-scope-1","path":"product.price"}}],"css":"\n    [data-cd-bundle=search] .search-bench h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 8vw, 7rem); text-transform: uppercase }\n    [data-cd-bundle=search] .query-controls { display: flex; flex-wrap: wrap; gap: .5rem }\n    [data-cd-bundle=search] .query-controls input { flex: 1 1 14rem; min-width: 0 }\n    [data-cd-bundle=search] .query-controls input,[data-cd-bundle=search] .query-controls button { background: transparent; border: 1px solid var(--rule); padding: .8rem 1rem }\n    [data-cd-bundle=search] .ranked-results { display: grid; grid-template-columns: repeat(3, 1fr) }\n    [data-cd-bundle=search] .ranked-results img { aspect-ratio: 4 / 5; object-fit: cover; width: 100% }\n    @media (max-width: 760px) { [data-cd-bundle=search] .ranked-results { grid-template-columns: 1fr } }\n  ","requiredData":[{"kind":"searchResults","limit":24}],"requiredCapabilities":["navigation","localState","catalogSearch"],"interactions":{"version":1,"state":[],"bindings":[],"transitions":[{"on":"input","sourceId":"cd-search-n8","action":{"type":"search.update","query":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-search-n9","action":{"type":"search.submit","query":{"kind":"event","field":"value"}}},{"on":"click","sourceId":"cd-search-n10","action":{"type":"search.clear"}}]},"trustedSlots":[]},"cart":{"html":"\n    <main class=\"commission-cart\" id=\"cd-cart-n1\"><header id=\"cd-cart-n2\"><small id=\"cd-cart-n3\">Workshop queue</small><h1 id=\"cd-cart-n4\">Your commission</h1><p id=\"cd-cart-n5\"><span data-cd-bind-text=\"cd-cart-binding-1\" id=\"cd-cart-n6\"></span> objects awaiting approval</p></header>\n      <section class=\"cart-ledger\" data-cd-repeat-id=\"cd-cart-scope-1\" id=\"cd-cart-n7\"><article id=\"cd-cart-n8\"><h2 data-cd-bind-text=\"cd-cart-binding-2\" id=\"cd-cart-n9\"></h2><p data-cd-bind-text=\"cd-cart-binding-3\" id=\"cd-cart-n10\"></p><p data-cd-bind-money=\"cd-cart-binding-4\" id=\"cd-cart-n11\"></p><p data-cd-bind-money=\"cd-cart-binding-5\" id=\"cd-cart-n12\"></p><div data-cd-trusted-slot-id=\"cd-cart-slot-1\" id=\"cd-cart-slot-1\"></div></article></section>\n      <p class=\"empty-state\" data-cd-empty-state=\"\" id=\"cd-cart-n13\">Your commission is empty. Choose an object to begin a proof.</p>\n      <aside data-cd-trusted-slot-id=\"cd-cart-slot-2\" id=\"cd-cart-slot-2\"></aside>\n    </main>\n  ","tree":[{"kind":"text","value":"\n    "},{"kind":"element","id":"cd-cart-n1","tag":"main","attributes":{"class":"commission-cart"},"children":[{"kind":"element","id":"cd-cart-n2","tag":"header","attributes":{},"children":[{"kind":"element","id":"cd-cart-n3","tag":"small","attributes":{},"children":[{"kind":"text","value":"Workshop queue"}]},{"kind":"element","id":"cd-cart-n4","tag":"h1","attributes":{},"children":[{"kind":"text","value":"Your commission"}]},{"kind":"element","id":"cd-cart-n5","tag":"p","attributes":{},"children":[{"kind":"element","id":"cd-cart-n6","tag":"span","attributes":{"data-cd-bind-text":"cd-cart-binding-1"},"children":[]},{"kind":"text","value":" objects awaiting approval"}]}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-cart-n7","tag":"section","attributes":{"class":"cart-ledger","data-cd-repeat-id":"cd-cart-scope-1"},"children":[{"kind":"element","id":"cd-cart-n8","tag":"article","attributes":{},"children":[{"kind":"element","id":"cd-cart-n9","tag":"h2","attributes":{"data-cd-bind-text":"cd-cart-binding-2"},"children":[]},{"kind":"element","id":"cd-cart-n10","tag":"p","attributes":{"data-cd-bind-text":"cd-cart-binding-3"},"children":[]},{"kind":"element","id":"cd-cart-n11","tag":"p","attributes":{"data-cd-bind-money":"cd-cart-binding-4"},"children":[]},{"kind":"element","id":"cd-cart-n12","tag":"p","attributes":{"data-cd-bind-money":"cd-cart-binding-5"},"children":[]},{"kind":"element","id":"cd-cart-slot-1","tag":"div","attributes":{"data-cd-trusted-slot-id":"cd-cart-slot-1"},"children":[],"trustedSlotId":"cd-cart-slot-1"}]}],"repeat":{"scopeId":"cd-cart-scope-1","source":"cart.lines","itemKind":"cartLine","keyPath":"cartLine.id"}},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-cart-n13","tag":"p","attributes":{"class":"empty-state","data-cd-empty-state":""},"children":[{"kind":"text","value":"Your commission is empty. Choose an object to begin a proof."}]},{"kind":"text","value":"\n      "},{"kind":"element","id":"cd-cart-slot-2","tag":"aside","attributes":{"data-cd-trusted-slot-id":"cd-cart-slot-2"},"children":[],"trustedSlotId":"cd-cart-slot-2"},{"kind":"text","value":"\n    "}]},{"kind":"text","value":"\n  "}],"bindings":[{"id":"cd-cart-binding-1","targetId":"cd-cart-n6","kind":"text","ref":{"kind":"data","scopeId":"root","path":"cart.count"}},{"id":"cd-cart-binding-2","targetId":"cd-cart-n9","kind":"text","ref":{"kind":"data","scopeId":"cd-cart-scope-1","path":"cartLine.title"}},{"id":"cd-cart-binding-3","targetId":"cd-cart-n10","kind":"text","ref":{"kind":"data","scopeId":"cd-cart-scope-1","path":"cartLine.quantity"}},{"id":"cd-cart-binding-4","targetId":"cd-cart-n11","kind":"money","ref":{"kind":"data","scopeId":"cd-cart-scope-1","path":"cartLine.unitPrice"}},{"id":"cd-cart-binding-5","targetId":"cd-cart-n12","kind":"money","ref":{"kind":"data","scopeId":"cd-cart-scope-1","path":"cartLine.total"}}],"css":"\n    [data-cd-bundle=cart] .commission-cart h1 { font-family: var(--font-display); font-size: clamp(3.5rem, 8vw, 7rem); text-transform: uppercase }\n    [data-cd-bundle=cart] .cart-ledger h2 { font-family: var(--font-display); text-transform: uppercase }\n    [data-cd-bundle=cart] .cart-ledger p { font-family: var(--font-body) }\n    [data-cd-bundle=cart] .empty-state { border: 1px dashed var(--rule); padding: 2rem }\n  ","requiredData":[{"kind":"cart"}],"requiredCapabilities":["commerce"],"interactions":{"version":1,"state":[],"bindings":[],"transitions":[]},"trustedSlots":[{"id":"cd-cart-slot-1","kind":"cartLineControls","scopeId":"cd-cart-scope-1","hostSize":"inline","themeTokenIds":["ink","cobalt","paper"]},{"id":"cd-cart-slot-2","kind":"cartSummary","hostSize":"page","themeTokenIds":["ink","signal","paper"]}]},"checkout":{"decorativeHtml":"<header class=\"checkout-mark\" id=\"cd-checkout-n1\"><small id=\"cd-checkout-n2\">Secure workshop checkout</small><h1 data-cd-bind-text=\"cd-checkout-binding-1\" id=\"cd-checkout-n3\"></h1><p id=\"cd-checkout-n4\">Your approved choices continue into the trusted contact, delivery, payment, and order summary flow.</p></header><aside class=\"checkout-note\" id=\"cd-checkout-n5\"><b id=\"cd-checkout-n6\">Proof included</b><p id=\"cd-checkout-n7\">Production starts only after proof approval.</p></aside><footer data-cd-platform-content=\"policyLinks\" id=\"cd-checkout-n8\"></footer>","decorativeTree":[{"kind":"element","id":"cd-checkout-n1","tag":"header","attributes":{"class":"checkout-mark"},"children":[{"kind":"element","id":"cd-checkout-n2","tag":"small","attributes":{},"children":[{"kind":"text","value":"Secure workshop checkout"}]},{"kind":"element","id":"cd-checkout-n3","tag":"h1","attributes":{"data-cd-bind-text":"cd-checkout-binding-1"},"children":[]},{"kind":"element","id":"cd-checkout-n4","tag":"p","attributes":{},"children":[{"kind":"text","value":"Your approved choices continue into the trusted contact, delivery, payment, and order summary flow."}]}]},{"kind":"element","id":"cd-checkout-n5","tag":"aside","attributes":{"class":"checkout-note"},"children":[{"kind":"element","id":"cd-checkout-n6","tag":"b","attributes":{},"children":[{"kind":"text","value":"Proof included"}]},{"kind":"element","id":"cd-checkout-n7","tag":"p","attributes":{},"children":[{"kind":"text","value":"Production starts only after proof approval."}]}]},{"kind":"element","id":"cd-checkout-n8","tag":"footer","attributes":{"data-cd-platform-content":"policyLinks"},"children":[]}],"bindings":[{"id":"cd-checkout-binding-1","targetId":"cd-checkout-n3","kind":"text","ref":{"kind":"data","scopeId":"root","path":"store.name"}}],"decorativeCss":"[data-cd-bundle=checkout] .checkout-mark { padding: 48px; background-color: var(--paper); color: var(--ink) } [data-cd-bundle=checkout] .checkout-mark h1 { font-family: var(--font-display); font-size: 56px; line-height: .9 } [data-cd-bundle=checkout] .checkout-note { margin: 24px 48px; padding: 18px; border-width: 1px; border-style: solid; border-color: var(--rule) }","layout":{"columnMode":"summaryAside","sectionOrder":["contact","shipping","delivery","consent","payment","summary"],"spacingTokenId":"space-workshop","surfaceTokenIds":["paper","ink","cobalt","signal"]},"requiredData":[{"kind":"storeIdentity"},{"kind":"policyLinks"}]}},"assets":{"entries":[{"key":"hero","contentHash":"f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9","mediaType":"image/webp","byteSize":132568}]}}}$storefront_runtime1_seed$::jsonb as bundle_json,
  $storefront_runtime1_seed${"entries":[{"key":"hero","contentHash":"f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9","mediaType":"image/webp","byteSize":132568}]}$storefront_runtime1_seed$::jsonb as asset_manifest;

do $$
begin
  if exists (
    select 1
    from storefront_runtime1_cutover_seed_payload seed
    where seed.artifact_hash <> public.storefront_artifact_hash(
      seed.schema_version,
      seed.runtime_version,
      seed.validation_profile_version,
      seed.bundle_json,
      seed.asset_manifest
    )
      or seed.bundle_json #>> '{bundle,source,kind}' <> 'recipe'
      or seed.bundle_json #>> '{bundle,source,templateId}' <> seed.template_id
      or (seed.bundle_json #>> '{bundle,source,templateVersion}')::integer <> seed.template_version
  ) then
    raise exception using
      errcode = '55000',
      message = 'runtime1_cutover_seed_invalid';
  end if;
end;
$$;

-- Publishing during cutover may reuse only a currently published runtime-1
-- pointer or a version proven by publish/rollback history. A merely validated
-- row can be an orphan left by a cancelled or conflicting command.
create temporary table storefront_runtime1_cutover_approved on commit drop as
select
  target.shop_id,
  coalesce(current_published.id, historic.version_id) as version_id
from storefront_runtime1_cutover_targets target
left join public.storefront_bundle_version current_published
  on current_published.shop_id = target.shop_id
  and current_published.id = target.previous_published_version_id
  and current_published.status = 'validated'
  and current_published.schema_version = 1
  and current_published.runtime_version = 1
  and current_published.validation_profile_version = 1
  and current_published.source_kind in ('recipe', 'custom')
left join lateral (
  select history.to_version_id as version_id
  from public.storefront_release_history history
  join public.storefront_bundle_version version
    on version.shop_id = history.shop_id
    and version.id = history.to_version_id
  where history.shop_id = target.shop_id
    and history.operation in ('publish', 'rollback')
    and version.status = 'validated'
    and version.schema_version = 1
    and version.runtime_version = 1
    and version.validation_profile_version = 1
    and version.source_kind in ('recipe', 'custom')
  order by history.created_at desc, history.id desc
  limit 1
) historic on true;

create temporary table storefront_runtime1_cutover_clones (
  shop_id uuid primary key,
  version_id uuid not null
) on commit drop;

with inserted as (
  insert into public.storefront_bundle_version (
    shop_id,
    source_kind,
    template_id,
    template_version,
    status,
    schema_version,
    runtime_version,
    validation_profile_version,
    artifact_hash,
    bundle_json,
    asset_manifest,
    validation_report,
    generation_prompt,
    resolution_json
  )
  select
    target.shop_id,
    seed.source_kind,
    seed.template_id,
    seed.template_version,
    'validated',
    seed.schema_version,
    seed.runtime_version,
    seed.validation_profile_version,
    seed.artifact_hash,
    seed.bundle_json,
    seed.asset_manifest,
    jsonb_build_object(
      'valid', true,
      'cutoverBackfill', jsonb_build_object(
        'reusedValidatedArtifact', true,
        'sourceArtifactHash', seed.artifact_hash
      )
    ),
    'Runtime-1 cutover backfill',
    jsonb_build_object(
      'operation', jsonb_build_object('kind', 'runtime1_cutover_backfill'),
      'sourceArtifactHash', seed.artifact_hash
    )
  from storefront_runtime1_cutover_targets target
  join storefront_runtime1_cutover_approved approved
    on approved.shop_id = target.shop_id
  left join public.storefront_bundle_version current_draft
    on current_draft.shop_id = target.shop_id
    and current_draft.id = target.previous_draft_version_id
    and current_draft.status = 'validated'
    and current_draft.schema_version = 1
    and current_draft.runtime_version = 1
    and current_draft.validation_profile_version = 1
    and current_draft.source_kind in ('recipe', 'custom')
  cross join storefront_runtime1_cutover_seed_payload seed
  where approved.version_id is null
    and (target.requires_published_version or current_draft.id is null)
  returning shop_id, id
)
insert into storefront_runtime1_cutover_clones (shop_id, version_id)
select shop_id, id from inserted;

create temporary table storefront_runtime1_cutover_versions on commit drop as
select
  target.shop_id,
  target.previous_draft_version_id,
  target.previous_published_version_id,
  target.requires_published_version,
  coalesce(current_draft.id, approved.version_id, clone.version_id) as draft_version_id,
  case
    when target.requires_published_version
      then coalesce(approved.version_id, clone.version_id)
    else null
  end as published_version_id
from storefront_runtime1_cutover_targets target
join storefront_runtime1_cutover_approved approved
  on approved.shop_id = target.shop_id
left join storefront_runtime1_cutover_clones clone
  on clone.shop_id = target.shop_id
left join public.storefront_bundle_version current_draft
  on current_draft.shop_id = target.shop_id
  and current_draft.id = target.previous_draft_version_id
  and current_draft.status = 'validated'
  and current_draft.schema_version = 1
  and current_draft.runtime_version = 1
  and current_draft.validation_profile_version = 1
  and current_draft.source_kind in ('recipe', 'custom');

do $$
begin
  if exists (
    select 1
    from storefront_runtime1_cutover_versions chosen
    where chosen.draft_version_id is null
      or (chosen.requires_published_version and chosen.published_version_id is null)
  ) then
    raise exception using
      errcode = '55000',
      message = 'runtime1_cutover_backfill_incomplete';
  end if;
end;
$$;

insert into public.storefront_release_history (
  shop_id,
  from_version_id,
  to_version_id,
  operation,
  actor_id
)
select
  chosen.shop_id,
  chosen.previous_draft_version_id,
  chosen.draft_version_id,
  'install_draft',
  null
from storefront_runtime1_cutover_versions chosen
where chosen.previous_draft_version_id is distinct from chosen.draft_version_id;

insert into public.storefront_release (
  shop_id,
  draft_version_id,
  published_version_id,
  updated_at
)
select chosen.shop_id, chosen.draft_version_id, chosen.published_version_id, now()
from storefront_runtime1_cutover_versions chosen
on conflict (shop_id) do update
set draft_version_id = excluded.draft_version_id,
    published_version_id = excluded.published_version_id,
    updated_at = excluded.updated_at;

insert into public.storefront_release_history (
  shop_id,
  from_version_id,
  to_version_id,
  operation,
  actor_id
)
select
  chosen.shop_id,
  chosen.previous_published_version_id,
  chosen.published_version_id,
  'publish',
  null
from storefront_runtime1_cutover_versions chosen
where chosen.published_version_id is not null
  and chosen.previous_published_version_id is distinct from chosen.published_version_id;

do $$
begin
  if exists (
    select 1
    from public.storefront_release release
    left join public.storefront_bundle_version draft
      on draft.shop_id = release.shop_id
      and draft.id = release.draft_version_id
    left join public.storefront_bundle_version published
      on published.shop_id = release.shop_id
      and published.id = release.published_version_id
    where (
        release.draft_version_id is not null
        and (
          draft.id is null
          or draft.status <> 'validated'
          or draft.schema_version <> 1
          or draft.runtime_version <> 1
          or draft.validation_profile_version <> 1
          or draft.source_kind not in ('recipe', 'custom')
        )
      )
      or (
        release.published_version_id is not null
        and (
          published.id is null
          or published.status <> 'validated'
          or published.schema_version <> 1
          or published.runtime_version <> 1
          or published.validation_profile_version <> 1
          or published.source_kind not in ('recipe', 'custom')
        )
      )
  ) or exists (
    with legacy_public as (
      select page.shop_id
      from public.page_document page
      where page.published_json is not null
      union
      select publication.shop_id
      from public.designer_publications publication
    )
    select 1
    from legacy_public
    left join public.storefront_release release
      on release.shop_id = legacy_public.shop_id
    left join public.storefront_bundle_version published
      on published.shop_id = release.shop_id
      and published.id = release.published_version_id
    where published.id is null
      or published.status <> 'validated'
      or published.schema_version <> 1
      or published.runtime_version <> 1
      or published.validation_profile_version <> 1
      or published.source_kind not in ('recipe', 'custom')
  ) or exists (
    select 1
    from public.page_document page
    left join public.storefront_release release
      on release.shop_id = page.shop_id
    left join public.storefront_bundle_version draft
      on draft.shop_id = release.shop_id
      and draft.id = release.draft_version_id
    where page.draft_json is not null
      and (
        draft.id is null
        or draft.status <> 'validated'
        or draft.schema_version <> 1
        or draft.runtime_version <> 1
        or draft.validation_profile_version <> 1
        or draft.source_kind not in ('recipe', 'custom')
      )
  ) then
    raise exception using
      errcode = '55000',
      message = 'runtime1_cutover_backfill_incomplete';
  end if;
end;
$$;
