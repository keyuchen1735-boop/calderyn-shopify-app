# Storefront Custom Redesign Mode

**Date:** 2026-07-20

**Owner:** Eric

**Status:** Approved for implementation planning

**Source package:** [`Trystan-SA/claude-design-system-prompt`](https://github.com/Trystan-SA/claude-design-system-prompt/tree/3c3ddb07d7aa3fef051d83608596470c95cfd8fe/claude), MIT
**Supersedes:** the recipe-immutability and no-structural-generation decision implemented by the hidden-design Store Builder cutover. It does not supersede hidden templates, trusted commerce, compiler validation, live catalog binding, immutable versions, undo, or browser proof.

## 1. Decision

The first Store Builder prompt continues to select and install an approved hidden recipe. After a draft exists, the same chat command automatically chooses one of three internal execution modes:

1. `bounded_edit` for safe deterministic copy, merchandising, and visual-layer changes.
2. `structural_edit` for an LLM-authored change to the current or explicitly selected route.
3. `full_redesign` for an LLM-authored replacement of the complete storefront design system, shell, home, collection, product, search, cart, and decorative checkout source.

There is no merchant-visible mode toggle. The intent classifier performs the judgment call and deterministic server code owns routing, retries, status, validation, persistence, and failure handling.

The first structural or full-redesign operation converts the recipe draft to custom provenance while recording the originating recipe ID and version. Later edits remain custom; they never pretend to be the original recipe. `Start over` is the explicit path back to hidden recipe selection.

## 2. Required outcomes

- Initial builds remain fast, deterministic, hidden-recipe installs.
- Follow-up prompts such as “move products above the hero” invoke the custom LLM path instead of switching recipes.
- Follow-up prompts such as “redesign the entire site from scratch” regenerate every authored route while preserving live merchant data and platform commerce.
- Safe changes continue to use the existing low-latency deterministic path when they can be resolved without generation.
- Recipe source becomes the visual starting point for the first custom edit, but custom output may replace its structure completely.
- Custom source is persisted with every custom version so later edits never reverse-engineer compiled HTML.
- Model output is always untrusted compiler source. It never writes route files, executes JavaScript, calls the network, or bypasses the compiler.
- Compile, validation, browser-proof, quota, cancellation, timeout, or compare-and-swap failure installs nothing.
- Every successful edit creates an immutable version with Undo and retains the prior published version until Publish.

## 3. User-visible behavior

| Merchant prompt after an initial draft | Internal mode | Result |
|---|---|---|
| “Change the headline to Summer Objects” | `bounded_edit` on a recipe; `structural_edit` on custom source | Recipe slots remain deterministic. Custom copy changes regenerate the owning route from persisted source. |
| “Feature jackets first” | `bounded_edit` | Deterministic featured-product update. |
| “Use this shader” | `bounded_edit` | Existing bounded visual-layer validation and install. |
| “Move the product grid above the story” | `structural_edit` | Generate a replacement for the current/selected route, compile and prove it, then detach to custom provenance. |
| “Turn the product page into a split gallery and sticky purchase panel” | `structural_edit` | Regenerate only the product route; other authored routes remain byte-identical. |
| “Redesign the entire store as an industrial catalog” | `full_redesign` | Regenerate the design plan and all authored routes. |
| “Make everything completely different from scratch” | `full_redesign` | Ignore the recipe’s structure while retaining merchant identity, live catalog bindings, owned assets, and trusted commerce contracts. |
| “Add JavaScript that calls my API” | unsupported | No change; generated scripts and network calls remain forbidden. |
| “Start over” | recipe selection | Install another approved hidden recipe and reset custom source. |

Progress copy remains merchant-facing: `Understanding`, `Planning the redesign`, `Building pages`, `Checking the preview`, `Ready`. It never exposes recipes, compiler source, prompt modules, or model/provider internals.

## 4. Intent and mode routing

`StoreIntent` gains two existing-draft-only variants:

```ts
type StoreIntent =
  | ExistingBoundedIntents
  | { kind: "structural_edit"; scope: { routeId: StorefrontRouteId } }
  | { kind: "full_redesign" }
  | ExistingControlIntents;
```

The classifier receives the existing bounded input plus `currentRouteId` when the preview supplies it. Its schema and local parser enforce:

- A fresh store may return only `select_design` or `unsupported`.
- A request that changes one route’s hierarchy, regions, layout, interaction composition, or route CSS returns `structural_edit`.
- A request that explicitly addresses the whole store/site/design, says “from scratch,” or requests a new global design system returns `full_redesign`.
- Copy, featured products, and visual-layer changes retain their existing bounded intents.
- Compound requests still fail closed with “Please make one storefront change at a time.”
- Routing decisions are enums only. The classifier never emits markup, status, retries, or persistence instructions.

Ambiguous structural requests default to the active preview route when it is present. Without route context, an ambiguous request is unsupported rather than silently rewriting every route. Only explicit whole-site language may trigger `full_redesign`.

## 5. Authoring-source artifact and provenance

The immutable `bundle_json` artifact may contain both runtime output and server-only authoring source:

```ts
interface StorefrontVersionArtifactV1 {
  sourceKind: "recipe" | "custom";
  bundle: StorefrontBundleV1;
  authoring?: {
    version: 1;
    source: StorefrontBundleSourceV1;
    overrides: {
      featuredProductIds?: string[];
      visualLayer?: VisualLayerSpec;
    };
  };
}
```

Runtime renderers continue to read only `bundle`. The authoring object is server-only, hashed as part of the immutable artifact, and loaded only by the Store Builder command path.

For the first custom operation:

1. Load the current recipe by exact ID and version.
2. Convert its bound `RecipeConfig` to `StorefrontBundleSourceV1`.
3. Set source provenance to:

```ts
{
  kind: "custom",
  generationId,
  promptHash,
  derivedFromVersionId,
  derivedFromTemplateId,
  derivedFromTemplateVersion,
}
```

4. Apply the requested generation to that source.

For later custom operations, load the persisted authoring source. A custom version without valid authoring source is not structurally editable or redesignable; those prompts fail closed instead of reconstructing source from compiled output. Legacy custom artifacts remain renderable, publishable, undoable, and eligible for `Start over`.

No table migration is required: `storefront_bundle_version.bundle_json` already stores an arbitrary object and current bundle readers tolerate additional top-level fields. One additive SQL function performs custom-version creation, validation, audit insertion, and draft compare-and-swap in a single transaction so a failed install cannot leave an unattached version.

## 6. Design-guidance adaptation

The external Claude design package is guidance, not an executable agent inside the request. Its filesystem workflow, tool calls, question pauses, subagent instructions, and arbitrary HTML-delivery assumptions are incompatible with a single authenticated structured-output API call.

Runtime guidance is versioned in server-only TypeScript modules:

- `design-guidance-core.server.ts`: identity, context fidelity, content discipline, aesthetic discipline, hierarchy, rhythm, typography, color, accessibility, interaction feedback, simplicity, system thinking, responsive design, quality, IP boundaries.
- `design-guidance-generate.server.ts`: storefront-specific generation procedure and compiler/commerce constraints.
- `design-guidance-review.server.ts`: accessibility, AI-slop, hierarchy/rhythm, interaction-state, and polish checks used by the judge/repair call.

The source package maps as follows:

| Source Markdown | Runtime treatment |
|---|---|
| `system-prompt.md` | Adapt applicable design principles into core guidance. Remove environment/tool secrecy, filesystem delivery, user-question pauses, and arbitrary JS instructions. |
| `frontend-aesthetic-direction.md` | Include in redesign planning when brand context is insufficient. |
| `design-system-extract.md` | Replace filesystem extraction with deterministic extraction from recipe source, merchant brand data, and reference images. |
| `component-extract.md` | Require repeated authored patterns and route consistency in the design plan. |
| `accessibility-audit.md` | Include as a review rubric and browser-proof acceptance criteria. |
| `ai-slop-check.md` | Include as a review rubric; reject generic gradients, filler, arbitrary fonts, and default AI house styles. |
| `hierarchy-rhythm-review.md` | Include as a review rubric. |
| `interaction-states-pass.md` | Adapt to the closed declarative interaction vocabulary. |
| `polish-pass.md` | Final judge rubric before installation. |
| `discovery-questions.md` | Do not pause a command. Missing material context becomes an unsupported/clarification result before generation. |
| `wireframe.md`, `generate-variations.md` | Use internally only for the full-redesign design-plan call; do not produce merchant-visible alternatives in v1. |
| `make-a-prototype.md` | Adapt only the screen/state coverage checklist; the compiler output is the prototype. |
| `make-tweakable.md` | Exclude; no hidden tweak panel or host protocol may ship. |
| `make-a-deck.md` | Exclude as unrelated to storefront generation. |

The prompt composition is deterministic code. The model does not choose or load “skills.” Every request receives core constraints; the server adds the generation and review modules required for its fixed operation.

## 7. Structural-edit pipeline

`structural_edit` performs one scoped generation operation:

1. Load the exact current authoring source, or seed it from the exact recipe version.
2. Assemble bounded merchant context and owned reference images.
3. Send the target route source, shared design system, shell summary, route contract, prompt, and optional selected compiler ID to the structured provider.
4. Require one complete `RouteSource` object for the target route; checkout returns `CheckoutRouteSource`.
5. Replace only that route in a cloned authoring source.
6. Compile the complete bundle, reapply deterministic overrides, and validate it.
7. Browser-prove all routes, emphasizing the changed route at mobile and desktop widths.
8. Permit one route-scoped repair call using bounded static/browser diagnostics.
9. Atomically create, validate, audit, and install one custom version in one database transaction.

Untargeted authoring routes must remain deeply equal before and after the generation step. A provider response that changes another route, source provenance, assets, or deterministic overrides is rejected locally.

## 8. Full-redesign pipeline

One giant model response is not accepted because it is prone to truncation and incoherent repairs. Full redesign uses a bounded staged pipeline:

1. **Plan call:** produce one structured design plan containing concept, design tokens, curated font IDs, responsive strategy, component vocabulary, per-route composition, interaction plan, and accessibility commitments.
2. **Shell/home call:** produce the complete shell and home source using the frozen plan.
3. **Catalog call:** produce collection, product, and search sources using the same plan.
4. **Commerce call:** produce cart and decorative checkout source. Checkout contains no payment or order controls.
5. Assemble one `StorefrontBundleSourceV1`, compile, validate, and browser-prove the complete store.
6. Permit at most one scoped repair call for each failing route and no more than two repair calls total.
7. Install only the final fully proven artifact.

The frozen design-plan result contains the final `concept` and `designSystem` objects plus route briefs. Calls may execute route groups concurrently only after that result is frozen. Their outputs are merged deterministically by route ID. Partial success is discarded.

Generated markup may reference only logical keys already present in the base recipe/custom asset manifest. After generation, deterministic code scans compiler-source asset references, rejects unknown keys, and builds the next manifest from the referenced allowlisted subset. This permits a redesign to drop an old hero without forcing it to retain an unused asset and without allowing the model to invent storage objects.

The redesign may replace typography, tokens, route structure, section order, authored interaction composition, and scoped CSS. It may not replace public-data bindings with invented data, remove required commerce slots, add arbitrary actions, alter checkout authority, use remote assets/fonts, or add executable JavaScript.

## 9. Model and output boundaries

- Provider: the existing configured Anthropic client and model selection.
- Output: Anthropic structured outputs with explicit local parsing and exact-key checks.
- Maximum prompt: existing 4,000 Unicode code points.
- Maximum model calls: four generation calls plus two repair calls for a full redesign; one generation plus one repair for a structural edit.
- Maximum provider output: 24,000 tokens per generation call and 12,000 per repair call.
- Maximum wall time: 10 minutes, inside the existing 800-second route duration.
- Maximum browser-proof time: 180 seconds.
- Abort is forwarded to every provider, compiler-adjacent async operation, proof, and write.
- Generated source caps remain the compiler’s existing route/CSS caps; the server rejects oversized structured output before compilation.

No retry is driven by prose or provider status interpretation from a model. Server code retries only the single schema/diagnostic repair cases specified above.

## 10. Trusted commerce and data

Full redesign means complete presentation freedom inside the compiler, not authority over commerce:

- Product, collection, search, store, policy, price, availability, and cart data use the closed binding vocabulary.
- Variant picker, add-to-cart, quick view, cart-line controls, cart summary, cart drawer, checkout fields, payment, and submit remain trusted platform slots.
- Checkout generation is decorative source plus the existing allowlisted layout manifest.
- Catalog strings and merchant prompts are untrusted data and never become system instructions.
- Images must resolve to owned asset keys or live public catalog bindings. Remote URLs, data URLs, imports, and model-invented asset keys fail compilation.
- Curated self-hosted font IDs remain mandatory.

## 11. Persistence, auditing, and failure behavior

Every successful custom operation records:

- base and result version IDs and hashes;
- mode (`structural_edit` or `full_redesign`);
- route scope when applicable;
- prompt hash and prompt version;
- source package commit and adapted guidance version;
- provider/model and token usage per call;
- compiler diagnostics, repairs, browser proof, and changed-route summary;
- recipe ancestry on first detachment.

The expected-draft compare-and-swap remains the final write boundary inside the atomic custom-install function. That transaction creates and validates the immutable version, records the edit audit, and moves the draft pointer together; any failure rolls all four operations back. The old version is the Undo target. Published state never changes until the merchant publishes the proven draft.

All failures return a bounded merchant message and preserve the current draft. Raw model output, provider payloads, catalog snapshots, source, and diagnostics remain server-side.

## 12. Flags and rollout

Add one server-only kill switch: `STOREFRONT_CUSTOM_REDESIGN`. When disabled, the classifier may still identify redesign intent, but the command returns unchanged with a temporary-unavailability message before provider spend.

Rollout order:

1. Ship flag off with unit and integration coverage.
2. Enable Preview for a controlled tenant and run recipe-to-custom structural edit, full redesign, follow-up custom edit, Undo, Publish, and public storefront smoke.
3. Inspect usage, timeouts, proof failures, and artifact sizes.
4. Enable Production only after the exact deployment is `READY` and the full live flow passes.
5. Retain immediate rollback by disabling `STOREFRONT_CUSTOM_REDESIGN`; existing custom storefronts remain readable and publishable.

## 13. Non-goals

- Exposing internal modes, templates, prompt modules, or source code to merchants.
- Restoring deleted legacy frontend routes or dual command paths.
- Letting a model route requests, retry providers, install versions, or decide whether validation passed.
- Generating or executing JavaScript, React, route modules, payment forms, database queries, or network requests.
- Shipping every external design skill verbatim when it conflicts with the storefront runtime.
- Producing multiple merchant-visible design variations in v1.
- Generating new editorial imagery in the redesign transaction; existing owned/catalog assets and placeholders are sufficient for v1.

## 14. Acceptance criteria

- A fresh prompt still installs a hidden recipe without a custom-generation call.
- Existing recipe copy, merchandising, and shader edits retain the deterministic path.
- A structural prompt invokes a model call, changes only the scoped route, and creates a custom version with recipe ancestry.
- A full-redesign prompt invokes the staged model pipeline and may change every authored route.
- A second structural prompt reads persisted custom source and does not require recipe source or compiled-source reconstruction.
- Recipe and custom storefronts remain renderable, undoable, publishable, and compatible with live catalog changes.
- Compiler rejection, malformed output, unsupported binding/action, missing trusted slot, failed proof, cancellation, timeout, or stale expected version installs nothing.
- Browser proof covers home, collection, product, search, cart, and checkout on mobile and desktop.
- Tests prove the custom path cannot emit scripts, remote URLs, arbitrary commerce actions, or merchant-visible implementation terminology.
- Prompt snapshot tests prove every applicable external design principle/review module is present and excluded tool workflows are absent.

## 15. Expected behavior moving forward

Store Builder remains template-first only for the initial safe launch. Afterward it behaves like a mode-switching design collaborator: ordinary edits stay fast; structural instructions call the model and detach the draft into an editable custom design; explicit whole-site redesigns rebuild the complete presentation system. The merchant always sees one chat and one preview, while the backend preserves a strict line between generated presentation and platform-owned data, commerce, validation, and release control.
