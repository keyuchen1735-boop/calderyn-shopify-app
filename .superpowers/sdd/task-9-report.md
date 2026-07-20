# Task 9 report — Forge

## Outcome

Implemented the isolated `forge@1` storefront recipe and static prototype without changing registries or shared runtime code. Forge compiles a nine-route jobsite blueprint using the approved `jobsite-blueprint`, `exploded-tool-hero`, `blueprint-flow`, and `tool-diagrams` archetypes.

## Commerce and evidence boundaries

- Product images, titles, descriptions, prices, availability, variants, collection copy, cart lines, and totals use public live merchant bindings.
- Project filters invoke `collection.filter` against merchant-supplied `tag` values; sorting invokes `collection.sort`.
- The project loadout lists live featured products and tells shoppers to verify and add each item individually. It does not claim a hidden kit or synthetic multi-add.
- Product purchase uses trusted `variantPicker` and `addToCart` hosts. Home/collection quick views, cart line controls, cart summary, and shell cart drawer use trusted hosts outside recipe-styled ancestors.
- No specification link is rendered because no merchant-owned file binding exists. The recipe contains no PDF URL or download control.
- No compatibility standard, certification, torque, pressure, speed, or protection rating is invented. Compatibility evidence remains merchant-authored description, option, and availability data.

## Visual system

- Steel `#24313a`, safety orange `#c94f18`, and parchment `#efe4ce` define a drawing-office/jobsite palette.
- Oswald display type, DM Mono body type, numbered callouts, drawing labels, dimensional grids, and exploded-tool compositions distinguish Forge from the Custom Bench workshop configurator.
- The prototype is self-contained and uses labeled live-image regions instead of fake product photography.

## Media

Exactly three briefs were written: `hero`, `hero-alt`, and `pdp-detail`.

One permitted generation attempt was made at the Vertex/Veo authentication gate:

```text
gcloud auth print-access-token
ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.
```

No second attempt was made. `FORGE_ASSETS` remains empty, proof records remain empty, and the compilation report intentionally fails closed with nine missing poster/WebM/MP4 references and their nine expected media-type mismatch diagnostics.

## TDD evidence

RED:

```text
npm test -- app/lib/storefront-recipes/forge/bundle.test.ts
3 failed — recipe source, media declarations, and prototype absent
```

GREEN:

```text
npm test -- app/lib/storefront-recipes/forge/bundle.test.ts app/lib/storefront-recipes/factory.test.ts app/lib/storefront-recipes/interactive-contract.test.ts app/lib/storefront-recipes/route-matrix.test.ts
4 files passed, 32 tests passed
```

## Verification

- `npm run typecheck` — passed.
- `npm run lint` — passed with 14 pre-existing warnings and zero errors.
- `npm run build` — passed, including `verify:client-bundle` across 2,577 client files.
- `git diff --check` — passed.
- Self-review confirmed Task 9 owns only the Forge recipe, tests, media metadata/briefs, prototype, and this report. No registry, shared compiler/runtime, or secret files changed.

## Integration note

Forge remains intentionally unregistered. Task 12 is responsible for registry and runtime exposure after media approval and cross-recipe integration review.
