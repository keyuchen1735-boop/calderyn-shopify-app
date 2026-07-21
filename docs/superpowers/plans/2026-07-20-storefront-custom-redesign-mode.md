# Storefront Custom Redesign Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep initial Store Builder creation recipe-first while automatically routing follow-up structural and full-site redesign prompts through a safe, source-preserving custom LLM pipeline.

**Architecture:** Extend the existing structured intent classifier with `structural_edit` and `full_redesign`, then route those intents from the single `runStoreCommand` boundary into a new server-only redesign engine. The engine seeds authoring source from the exact recipe or loads persisted custom source, composes an adapted design-guidance prompt, requests bounded structured route source, compiles and browser-proves the complete bundle, and atomically creates, validates, audits, and installs one immutable custom version through a single compare-and-swap database function.

**Tech Stack:** TypeScript, Remix, Anthropic SDK structured outputs, existing storefront compiler/runtime, Vitest, Supabase JSONB release artifacts, Chromium browser proof.

## Global Constraints

- The first storefront prompt may install only an approved hidden recipe; custom redesign requires an existing draft.
- There is one merchant-facing chat and one authenticated Store Builder API route; internal modes remain hidden.
- Model output is untrusted `StorefrontBundleSourceV1` data. Model-authored JavaScript, React, route files, network calls, and commerce logic never execute.
- Product data, pricing, availability, cart, checkout, payment, policies, tenant isolation, and owned assets remain platform-controlled.
- New custom versions persist valid authoring source; missing or malformed authoring fails closed only for structural/redesign generation, while legacy custom drafts remain renderable, publishable, undoable, and eligible for Start over.
- Every compile, validation, browser-proof, quota, cancellation, timeout, and compare-and-swap failure leaves the draft unchanged.
- Existing deterministic copy, merchandising, and visual-layer paths stay in place when they can safely resolve the request.
- `STOREFRONT_CUSTOM_REDESIGN` is server-only and defaults off.
- No new top-level dependency is allowed.
- Implementation is test-first: witness each focused test fail for the missing behavior before production code.
- Before each major commit, complete the repository `/code-review` equivalent with the task reviewer, resolve blockers, then run patch sanity, typecheck, lint, and build in the required order.

---

### Task 1: Add redesign intent contracts and fail-closed classification

**Files:**
- Modify: `app/lib/storefront-command/types.ts`
- Modify: `app/lib/storefront-command/intent.server.ts`
- Modify: `app/lib/storefront-command/intent.server.test.ts`
- Modify: `app/lib/storefront-command/types.test.ts`

**Interfaces:**
- Consumes: existing `StoreIntent`, `ClassifyStoreIntentInput`, `STORE_INTENT_SCHEMA`, and `PreviewSlotContext`.
- Produces: `StoreRedesignScope`, `structural_edit`, and `full_redesign` intents consumed by Task 5.

- [ ] **Step 1: Write failing classification tests**

Add cases that force the provider result and assert local parsing/routing:

```ts
it("classifies one-route structure work without replacing the hidden recipe", async () => {
  const provider: StoreIntentProvider = async () => classified(
    '{"kind":"structural_edit","scope":{"routeId":"product"}}',
  );
  await expect(classifyStoreIntent({ ...input, currentRouteId: "product" }, { provider })).resolves.toEqual({
    kind: "structural_edit",
    scope: { routeId: "product" },
  });
});

it("allows full redesign only when a draft exists", async () => {
  const provider: StoreIntentProvider = async () => classified('{"kind":"full_redesign"}');
  await expect(classifyStoreIntent(input, { provider })).resolves.toEqual({ kind: "full_redesign" });
  await expect(classifyStoreIntent({ prompt: "Redesign everything", productCandidates: [] }, { provider }))
    .rejects.toMatchObject({ code: "invalid_store_intent" });
});
```

- [ ] **Step 2: Run the tests and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-command/intent.server.test.ts
```

Expected: FAIL because the intent union/schema/parser do not support `structural_edit` or `full_redesign`.

- [ ] **Step 3: Add the minimal types and schema branches**

Add exact route scope and intents:

```ts
export interface StoreRedesignScope {
  routeId: StorefrontRouteId;
}

export type StoreIntent =
  | { kind: "select_design"; prompt: string; excludedTemplateIds: StoreTemplateId[] }
  | { kind: "update_text"; slot: string; value: string }
  | { kind: "update_merchandising"; productIds: string[] }
  | { kind: "update_visual_layer"; visualLayer: VisualLayerSpec }
  | { kind: "structural_edit"; scope: StoreRedesignScope }
  | { kind: "full_redesign" }
  | { kind: "start_over"; prompt: string }
  | { kind: "unsupported"; message: string };
```

Extend `STORE_OPERATION_KINDS`, `STORE_INTENT_VALUE_SCHEMA`, exact-key parsing, and the classifier prompt. Replace the slot-only command context with an exact-key `PreviewContext` containing required `routeId` and optional `slot`; pass `currentRouteId?: StorefrontRouteId` into `ClassifyStoreIntentInput`. Reject either redesign intent when `bundle` is absent. Permit `update_text` on custom bundles only when route context identifies its owning route; otherwise return `unsupported`. Do not add markup fields to the classifier schema.

- [ ] **Step 4: Verify GREEN and existing classifier behavior**

Run:

```bash
npx vitest run app/lib/storefront-command/intent.server.test.ts app/lib/storefront-command/types.test.ts
```

Expected: PASS with existing compound-request, malformed-output, exact-command, and trust-boundary tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/lib/storefront-command/types.ts app/lib/storefront-command/intent.server.ts app/lib/storefront-command/intent.server.test.ts
git commit -m "storefront/intent: classify custom redesign modes"
```

---

### Task 2: Adapt and version the design-guidance prompt package

**Files:**
- Create: `app/lib/storefront-ai/design-guidance-core.server.ts`
- Create: `app/lib/storefront-ai/design-guidance-generate.server.ts`
- Create: `app/lib/storefront-ai/design-guidance-review.server.ts`
- Create: `app/lib/storefront-ai/design-guidance.server.test.ts`
- Create: `docs/vendor/claude-design-system-prompt-3c3ddb.md`

**Interfaces:**
- Consumes: the approved source package at commit `3c3ddb07d7aa3fef051d83608596470c95cfd8fe`.
- Produces: `STOREFRONT_DESIGN_GUIDANCE_VERSION`, `storefrontGenerationSystemPrompt()`, and `storefrontReviewSystemPrompt()` consumed by Task 4.

- [ ] **Step 1: Write prompt snapshot/constraint tests**

```ts
it("includes applicable design and review disciplines without agent-tool workflow", () => {
  const generation = storefrontGenerationSystemPrompt();
  const review = storefrontReviewSystemPrompt();
  for (const phrase of [
    "Every element must earn its place",
    "visual hierarchy",
    "WCAG",
    "prefers-reduced-motion",
    "trusted commerce slots",
  ]) expect(`${generation}\n${review}`).toContain(phrase);
  for (const forbidden of ["launch four review agents", "filesystem-based project", "speaker notes", "tweak panel"])
    expect(`${generation}\n${review}`).not.toContain(forbidden);
});
```

Also assert the prompt forbids script, remote assets/fonts, arbitrary actions, invented catalog values, and removing trusted slots.

- [ ] **Step 2: Run the prompt test and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-ai/design-guidance.server.test.ts
```

Expected: FAIL because the prompt modules do not exist.

- [ ] **Step 3: Implement three static server-only modules**

Use one exported version and deterministic composition:

```ts
export const STOREFRONT_DESIGN_GUIDANCE_VERSION = "claude-design-3c3ddb-calderyn-1" as const;

export function storefrontGenerationSystemPrompt(): string {
  return [DESIGN_GUIDANCE_CORE, STOREFRONT_GENERATION_GUIDANCE].join("\n\n");
}

export function storefrontReviewSystemPrompt(): string {
  return [DESIGN_GUIDANCE_CORE, STOREFRONT_REVIEW_GUIDANCE].join("\n\n");
}
```

Adapt the source package according to the design spec mapping. Keep the runtime text about storefront design judgment, content, aesthetics, hierarchy, typography, color, responsive behavior, accessibility, interaction states, simplicity, consistency, IP, and polish. Replace agent/tool procedures with compiler-source and structured-output instructions. Do not import `.md` at runtime.

- [ ] **Step 4: Document source and exclusions**

`docs/vendor/claude-design-system-prompt-3c3ddb.md` must record the source URL, commit, MIT license, every source Markdown file, its runtime mapping, and the deliberate exclusions (`make-a-deck`, `make-tweakable`, question pauses, subagents, filesystem delivery).

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run app/lib/storefront-ai/design-guidance.server.test.ts
```

Expected: PASS with no browser-bundle import of the server-only files.

- [ ] **Step 6: Commit**

```bash
git add app/lib/storefront-ai/design-guidance-*.server.ts app/lib/storefront-ai/design-guidance.server.test.ts docs/vendor/claude-design-system-prompt-3c3ddb.md
git commit -m "storefront/ai: adapt redesign guidance"
```

---

### Task 3: Persist compiler authoring source with custom versions

**Files:**
- Create: `app/lib/storefront-ai/authoring.server.ts`
- Create: `app/lib/storefront-ai/authoring.server.test.ts`
- Modify: `app/lib/storefront-recipes/factory.ts`
- Modify: `app/lib/storefront-command/command.server.ts`
- Modify: `app/lib/storefront-command/command.server.test.ts`

**Interfaces:**
- Consumes: `DefinedRecipe`, `StorefrontBundleSourceV1`, `StorefrontBundleV1`, `VisualLayerSpec`, and existing `bundle_json` artifacts.
- Produces: `StorefrontVersionArtifactV1`, `StorefrontAuthoringV1`, `authoringFromRecipe()`, `parseStorefrontVersionArtifact()`, and `compileAuthoring()` consumed by Tasks 4 and 5.

- [ ] **Step 1: Write failing authoring artifact tests**

```ts
it("seeds custom source from the exact bound recipe and preserves ancestry", () => {
  const artifact = authoringFromRecipe(CUSTOM_BENCH_RECIPE, {
    generationId: "gen-1",
    promptHash: "sha256:prompt",
    derivedFromVersionId: VERSION_ID,
  });
  expect(artifact.authoring.source.source).toMatchObject({
    kind: "custom",
    derivedFromVersionId: VERSION_ID,
    derivedFromTemplateId: "custom-bench",
    derivedFromTemplateVersion: CUSTOM_BENCH_RECIPE.config.templateVersion,
  });
  expect(compileAuthoring(artifact.authoring).bundle.source.kind).toBe("custom");
});

it("rejects structural source access for legacy custom artifacts", () => {
  const artifact = parseStorefrontVersionArtifact({ sourceKind: "custom", bundle: CUSTOM_BUNDLE });
  expect(() => requireStorefrontAuthoring(artifact))
    .toThrow(/authoring source/i);
});
```

- [ ] **Step 2: Run and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-ai/authoring.server.test.ts
```

Expected: FAIL because the authoring module and recipe-source export do not exist.

- [ ] **Step 3: Add exact artifact contracts and recipe conversion**

```ts
export interface StorefrontAuthoringV1 {
  version: 1;
  source: StorefrontBundleSourceV1;
  overrides: {
    featuredProductIds?: string[];
    visualLayer?: VisualLayerSpec;
  };
}

export interface StorefrontVersionArtifactV1 {
  sourceKind: "recipe" | "custom";
  bundle: StorefrontBundleV1;
  authoring?: StorefrontAuthoringV1;
}
```

Export `recipeCompilerSource(recipe: DefinedRecipe): StorefrontBundleSourceV1` from `factory.ts` using the already-bound `recipe.config`. `authoringFromRecipe()` clones that source, changes only provenance, and copies current featured-product/visual-layer overrides. `compileAuthoring()` compiles source, applies overrides, then runs `validateCompiledBundle`.

- [ ] **Step 4: Load the complete artifact in command state**

Change `LoadedStoreCommandVersion` to retain parsed `artifact` alongside `bundle`. Recipe and legacy custom artifacts may omit `authoring`; `requireStorefrontAuthoring()` fails closed only when generation needs source. Keep `extractBundle()` compatibility for existing rows and public rendering.

- [ ] **Step 5: Verify GREEN and serialization compatibility**

Run:

```bash
npx vitest run app/lib/storefront-ai/authoring.server.test.ts app/lib/storefront-command/command.server.test.ts app/lib/storefront-bundle/release.server.test.ts
```

Expected: PASS; current recipe rows still load, custom authoring round-trips through JSON, and invalid custom rows fail closed.

- [ ] **Step 6: Commit**

```bash
git add app/lib/storefront-ai/authoring.server.ts app/lib/storefront-ai/authoring.server.test.ts app/lib/storefront-recipes/factory.ts app/lib/storefront-command/command.server.ts app/lib/storefront-command/command.server.test.ts
git commit -m "storefront/ai: persist custom authoring source"
```

---

### Task 4: Build the structured custom redesign engine

**Files:**
- Create: `app/lib/storefront-ai/redesign-schema.server.ts`
- Create: `app/lib/storefront-ai/redesign-prompts.server.ts`
- Create: `app/lib/storefront-ai/redesign-provider.server.ts`
- Create: `app/lib/storefront-ai/redesign.server.ts`
- Create: `app/lib/storefront-ai/redesign.server.test.ts`

**Interfaces:**
- Consumes: Task 2 prompt functions, Task 3 authoring source, `assembleStorefrontContextWithReferences`, `compileBundle`, `validateCompiledBundle`, and `storefrontAiBrowserProof`.
- Produces: `runStorefrontRedesign(input, dependencies?)` returning one proven custom artifact and audit for Task 5.

```ts
export interface RunStorefrontRedesignInput {
  shopId: string;
  prompt: string;
  mode: "structural_edit" | "full_redesign";
  scope?: { routeId: StorefrontRouteId };
  baseVersionId: string;
  baseArtifact: StorefrontVersionArtifactV1;
  recipe?: DefinedRecipe;
  context: StorefrontContextAssembly;
  referenceImages: Array<{ url: string; mediaType: StorefrontReferenceMediaType }>;
  signal?: AbortSignal;
}

export interface StorefrontRedesignResult {
  artifact: StorefrontVersionArtifactV1;
  validation: BundleValidationReport;
  browserProof: BrowserProofReport;
  audit: StorefrontRedesignAudit;
}
```

- [ ] **Step 1: Write failing engine tests with a deterministic fake provider**

Cover:

```ts
it("changes only the scoped route for structural edits", async () => {
  const result = await runStorefrontRedesign(structuralInput("product"), depsWithRoute(productRoute));
  expect(result.artifact.authoring!.source.routes.product).toEqual(productRoute);
  expect(result.artifact.authoring!.source.routes.home).toEqual(baseSource.routes.home);
  expect(result.artifact.bundle.source).toMatchObject({ kind: "custom", derivedFromTemplateId: "custom-bench" });
});

it("discards every partial output when full redesign proof fails", async () => {
  const deps = fullRedesignDeps({ proof: { ok: false, diagnostics: [diagnostic] } });
  await expect(runStorefrontRedesign(fullInput(), deps)).rejects.toMatchObject({ code: "storefront_redesign_proof_failed" });
  expect(deps.install).toBeUndefined();
});
```

Also test malformed schemas, non-curated fonts, script/remote URL compiler rejection, missing trusted commerce slots, output caps, abort propagation, the 10-minute operation timeout, the 180-second proof timeout, maximum two repairs, owned proof-context resolution, and source immutability.

- [ ] **Step 2: Run and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-ai/redesign.server.test.ts
```

Expected: FAIL because the redesign engine does not exist.

- [ ] **Step 3: Implement the minimal Anthropic structured provider**

Use the existing client and schema helper:

```ts
const response = await getAnthropic().messages.create({
  model: assistantModel(),
  max_tokens: request.maxTokens,
  system: request.system,
  output_config: { format: jsonSchemaOutputFormat(request.schema) },
  messages: [{ role: "user", content: request.content }],
}, { signal: request.signal });
```

Return text plus model/token audit. Require exactly one text block and locally parse every response with exact keys and byte/code-point caps. Do not add provider retries.

- [ ] **Step 4: Implement structural route generation**

Compose the generation prompt with current design system, target route source, other-route summaries, compiler syntax contract, merchant context, and selected compiler ID. Accept exactly one complete route object. Clone the source and replace only `scope.routeId`; reject any other mutation before compilation.

- [ ] **Step 5: Implement staged full redesign**

Freeze one structured `StorefrontDesignPlan` containing final `concept`, final `designSystem`, and per-route briefs, then request exact groups:

```ts
type RedesignGroup =
  | { group: "shell_home"; shell: RouteSource; home: RouteSource }
  | { group: "catalog"; collection: RouteSource; product: RouteSource; search: RouteSource }
  | { group: "commerce"; cart: RouteSource; checkout: CheckoutRouteSource };
```

Run the three group calls after the plan returns, assemble by explicit keys, set custom provenance, use the current owned manifest as the asset allowlist, and reject missing/extra routes.

Scan every generated `data-cd-asset` reference, reject logical keys absent from the base artifact, and construct the next asset manifest from the referenced allowlisted subset before compilation. Catalog-image bindings are live data and do not enter this manifest.

- [ ] **Step 6: Compile, prove, and repair with fixed limits**

Compile the entire authoring source, apply overrides, run static validation, resolve opaque context product IDs through the existing owned-reference map, then browser proof. Bound the full operation to 10 minutes and each proof attempt to 180 seconds with composed abort signals forwarded to provider and proof calls. A structural edit gets one route repair. Full redesign gets at most one repair per failing route and two total. Repairs receive only bounded diagnostics and the failing route source. Recompile and re-prove after each repair. No partial artifact escapes the function.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npx vitest run app/lib/storefront-ai/redesign.server.test.ts app/lib/storefront-compiler/compile.test.ts app/lib/storefront-compiler/validate.test.ts
```

Expected: PASS with the compiler security regressions unchanged.

- [ ] **Step 8: Commit**

```bash
git add app/lib/storefront-ai/redesign-*.server.ts app/lib/storefront-ai/redesign.server.test.ts
git commit -m "storefront/ai: add structured redesign engine"
```

---

### Task 5: Route redesign modes through the one command boundary

**Files:**
- Modify: `app/lib/storefront-command/command.server.ts`
- Modify: `app/lib/storefront-command/command.server.test.ts`
- Modify: `app/lib/storefront-command/types.ts`
- Modify: `app/lib/storefront-bundle/release.server.ts`
- Modify: `app/lib/storefront-bundle/release.server.test.ts`
- Modify: `app/lib/storefront-edit/undo.server.ts`
- Modify: `app/lib/storefront-edit/undo.server.test.ts`
- Modify: `app/lib/storefront-validation/command-harness.server.ts`
- Modify: `app/routes/dashboard.api.store.tsx`
- Modify: `app/routes/__tests__/dashboard.api.store.test.ts`
- Create: `supabase/migrations/<generated>_storefront_atomic_custom_redesign.sql`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 1 intents and Task 4 `runStorefrontRedesign()`.
- Produces: streamed redesign progress, custom-to-custom Undo, and the existing installed/unchanged receipts through one atomic redesign-install write.

- [ ] **Step 1: Write failing command-path tests**

Assert:

```ts
it("routes structural intent to redesign and installs one custom edit", async () => {
  const deps = dependencies({
    classify: vi.fn().mockResolvedValue({ kind: "structural_edit", scope: { routeId: "home" } }),
    redesign: vi.fn().mockResolvedValue(provenRedesign()),
    installRedesign: vi.fn().mockResolvedValue(REDESIGN_VERSION),
  });
  const receipt = await runStoreCommand({ shopId: SHOP, command: promptCommand(CURRENT, "Move products first") }, deps);
  expect(deps.redesign).toHaveBeenCalledOnce();
  expect(deps.applyIntent).not.toHaveBeenCalled();
  expect(receipt).toMatchObject({ status: "installed", undo: { targetVersionId: CURRENT } });
  expect(deps.installRedesign).toHaveBeenCalledOnce();
});
```

Add flag-off/no-provider-spend, fresh-store redesign rejection, stale version, cancellation, atomic-install rollback, persisted audit, custom-to-custom Undo, legacy-custom Undo/Publish, and Publish cases.

- [ ] **Step 2: Run and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-command/command.server.test.ts app/routes/__tests__/dashboard.api.store.test.ts
```

Expected: FAIL because command dependencies and routing do not expose redesign.

- [ ] **Step 3: Add one dependency and one branch**

Extend `StoreCommandDependencies` with:

```ts
customRedesignEnabled(): boolean;
redesign(input: RunStorefrontRedesignInput): Promise<StorefrontRedesignResult>;
installRedesign(input: InstallStorefrontRedesignInput): Promise<string>;
```

After classification and before the recipe/apply branches, handle both redesign intents. Check the flag before provider spend, emit `planning_redesign` then `building_pages`, call the engine, hash the complete `{ sourceKind: "custom", bundle, authoring }` artifact through the existing database hash boundary, then call `installRedesign` once with the original expected version, complete artifact, validation, provider audit, and edit audit. The additive `security invoker` SQL function must create, validate, audit, and compare-and-swap the draft in one transaction; any error leaves no version or audit row.

Keep existing deterministic intent handling unchanged for recipe drafts. Custom merchandising/visual-layer edits must update both the compiled bundle and `authoring.overrides`. A custom `update_text` intent routes through `structural_edit` only when `context.routeId` is present; otherwise it is unsupported. The UI sends its active preview route with every prompt, while `slot` remains optional.

Extend Undo to preserve and validate the complete target artifact. Recipe targets keep their current behavior; custom targets with authoring recreate the complete custom artifact, and legacy custom targets remain restorable without inventing authoring source.

- [ ] **Step 4: Add progress stages and bounded errors**

Extend `StoreCommandEvent` with `planning_redesign | building_pages`. Map disabled, malformed output, budget, compile, proof, cancellation, and conflict failures to existing NDJSON error handling. Add `STOREFRONT_CUSTOM_REDESIGN=0` to `.env.example`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx vitest run app/lib/storefront-command/command.server.test.ts app/lib/storefront-command/intent.server.test.ts app/routes/__tests__/dashboard.api.store.test.ts
```

Expected: PASS; first builds remain recipes, bounded edits do not call redesign, and redesign errors install nothing.

- [ ] **Step 6: Commit**

```bash
git add .env.example app/lib/storefront-command app/routes/dashboard.api.store.tsx app/routes/__tests__/dashboard.api.store.test.ts
git commit -m "storefront/command: switch follow-ups into redesign mode"
```

---

### Task 6: Render redesign progress without exposing implementation modes

**Files:**
- Modify: `app/components/dashboard/screens/Store.tsx`
- Modify: `app/components/dashboard/screens/Store.test.tsx`
- Modify: `app/components/dashboard/screens/store-logic.ts`
- Modify: `app/components/dashboard/screens/store-logic.test.ts`
- Modify: `app/lib/dashboard/store-client.ts`
- Modify: `app/lib/dashboard/store-client.test.ts`

**Interfaces:**
- Consumes: Task 5 progress events.
- Produces: merchant-facing progress messages; no new endpoint or UI toggle.

- [ ] **Step 1: Write failing UI tests**

```tsx
it("shows redesign progress without template or model terminology", async () => {
  streamStoreCommand([
    { stage: "planning_redesign" },
    { stage: "building_pages" },
    readyInstalled(),
  ]);
  renderStore();
  await user.type(screen.getByRole("textbox"), "Redesign the whole site{enter}");
  expect(await screen.findByText("Planning the redesign")).toBeInTheDocument();
  expect(await screen.findByText("Building pages")).toBeInTheDocument();
  expect(screen.queryByText(/template|recipe|compiler|model/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run and witness RED**

Run:

```bash
npx vitest run app/components/dashboard/screens/Store.test.tsx
```

Expected: FAIL because the new stages have no display mapping.

- [ ] **Step 3: Add only the two stage mappings**

Parse the two stages in the client, map `planning_redesign` to `Planning the redesign` and `building_pages` to `Building pages`, and send the active preview `routeId` with every prompt. Keep one chat composer and current Stop/Undo/Publish behavior. Do not add a mode toggle, badge, template name, model selector, or advanced panel.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx vitest run app/components/dashboard/screens/Store.test.tsx app/components/dashboard/store/__tests__/chat-rail-chips.test.tsx
```

Expected: PASS with all assistant replies still using the shared bubble.

- [ ] **Step 5: Commit**

```bash
git add app/components/dashboard/screens/Store.tsx app/components/dashboard/screens/Store.test.tsx app/components/dashboard/store/chat-types.ts app/components/dashboard/store/ChatRail.tsx
git commit -m "dashboard/store: show custom redesign progress"
```

---

### Task 7: Prove the complete recipe-to-custom lifecycle and document release safety

**Files:**
- Modify: `app/lib/storefront-validation/full-story.server.ts`
- Create: `app/lib/storefront-validation/full-story.server.test.ts`
- Create: `app/lib/storefront-validation/custom-redesign.server.test.ts`
- Modify: `app/lib/storefront-validation/command-harness.server.ts`
- Modify: `docs/STOREFRONT_RUNTIME_1_ROLLOUT.md`
- Modify: `scripts/verify-client-bundle.mjs` only if a new server-only prompt marker is found in client output; fix imports first and do not weaken the scanner.

**Interfaces:**
- Consumes: the complete Tasks 1-6 feature.
- Produces: runnable regression evidence and rollout instructions.

- [ ] **Step 1: Write the failing full-story test**

The new custom story must execute this exact lifecycle with deterministic providers without changing the existing recipe full-story contract:

```ts
const initial = await harness.prompt("Build my store");
expect(initial.bundle.source.kind).toBe("recipe");
expect(harness.redesignCalls()).toBe(0);

const bounded = await harness.prompt("Change the headline");
expect(bounded.bundle.source.kind).toBe("recipe");
expect(harness.redesignCalls()).toBe(0);

const structural = await harness.prompt("Move products above the story", [], { routeId: "home" });
expect(structural.bundle.source).toMatchObject({ kind: "custom", derivedFromVersionId: bounded.versionId });
expect(harness.redesignCalls()).toBe(1);

const full = await harness.prompt("Redesign the entire site from scratch");
expect(full.bundle.source.kind).toBe("custom");
expect(full.authoring.source.routes).not.toEqual(structural.authoring.source.routes);

await harness.undo();
expect(harness.currentVersionId()).toBe(structural.versionId);
await harness.publish();
expect(harness.publishedVersionId()).toBe(structural.versionId);
```

Add negative stories for malformed provider output, compiler rejection, missing trusted slot, browser-proof failure, abort, flag-off, stale expected version, and custom artifact missing authoring source. Each must assert the draft version is unchanged.

- [ ] **Step 2: Run and witness RED**

Run:

```bash
npx vitest run app/lib/storefront-validation/custom-redesign.server.test.ts app/lib/storefront-validation/full-story.server.test.ts
```

Expected: FAIL because the end-to-end redesign behavior is not implemented.

- [ ] **Step 3: Complete the harness wiring and verify GREEN**

Run:

```bash
npx vitest run app/lib/storefront-validation/custom-redesign.server.test.ts app/lib/storefront-validation/full-story.server.test.ts
```

Expected: PASS with recipe, custom, undo, publish, and all no-change failures proven.

- [ ] **Step 4: Run focused security and regression suites**

```bash
npx vitest run \
  app/lib/storefront-command/intent.server.test.ts \
  app/lib/storefront-command/command.server.test.ts \
  app/lib/storefront-ai/authoring.server.test.ts \
  app/lib/storefront-ai/design-guidance.server.test.ts \
  app/lib/storefront-ai/redesign.server.test.ts \
  app/lib/storefront-compiler/compile.test.ts \
  app/lib/storefront-compiler/html.test.ts \
  app/lib/storefront-compiler/css.test.ts \
  app/lib/storefront-compiler/interactions.test.ts \
  app/lib/storefront-compiler/validate.test.ts \
  app/routes/__tests__/dashboard.api.store.test.ts \
  app/components/dashboard/screens/Store.test.tsx
```

Expected: all listed files pass; no test is skipped.

- [ ] **Step 5: Refresh Graphify and run the complete repository pre-commit gate**

Run in order:

```bash
graphify update .
npm test
node scripts/verify-storefront-bundles.mjs
git diff --stat
git diff --check
git diff --name-only | xargs rg -n "console\\.log|\\.only\\(|TODO\\(me\\)|AI-generated|vibecod|Claude Design" -- 2>/dev/null || true
npm run typecheck
npm run lint
npm run build
```

Expected: exit 0 for every command; client-bundle verification contains none of the server-only prompt text, external package names, skill names, model/provider names, or internal mode names.

- [ ] **Step 6: Commit the lifecycle evidence**

```bash
git add app/lib/storefront-validation docs/STOREFRONT_RUNTIME_1_ROLLOUT.md scripts/verify-client-bundle.mjs graphify-out
git commit -m "storefront/validation: prove custom redesign lifecycle"
```

If `graphify update .` changes no tracked graph output, omit `graphify-out` from `git add`.

- [ ] **Step 7: Record the post-PR rollout runbook (do not change environments in this implementation PR)**

Update the rollout guide to enable `STOREFRONT_CUSTOM_REDESIGN=1` in Preview only after the PR has a `READY` deployment. On a controlled tenant verify:

1. Initial prompt installs a recipe.
2. Copy edit stays fast and recipe-linked.
3. Selected-route structure edit switches to custom and preserves all other routes.
4. Full redesign changes every authored route.
5. Subsequent structural edit reads custom source.
6. Undo restores the prior version.
7. Publish promotes the expected version.
8. Public home, collection, product, search, cart, and checkout render and transact through trusted platform controls.
9. Stop/cancel and an intentionally invalid prompt leave the draft unchanged.

Record deployment ID, commit SHA, route results, provider usage, proof duration, and artifact sizes. The guide must require a new Production deployment after changing the Production flag, wait for that exact deployment to become `READY`, then repeat the same smoke against `app.calderyncompany.com` plus one tenant storefront domain.

---

## Plan self-review record

- **Spec coverage:** Tasks 1-7 cover automatic mode routing, adapted guidance, source persistence, structural/full generation, compiler and proof gates, one-route integration, hidden UI, versioning, Undo, Publish, flags, and live rollout.
- **Placeholder scan:** no unresolved markers, deferred implementation, generic validation instruction, or unspecified test step remains.
- **Type consistency:** `StorefrontAuthoringV1`, `StorefrontVersionArtifactV1`, `RunStorefrontRedesignInput`, `StorefrontRedesignResult`, `structural_edit`, and `full_redesign` are defined before their consumers and retain identical names throughout.
- **Scope check:** new imagery generation, merchant-visible variations, new UI modes, table migrations, and restored legacy endpoints remain excluded; the atomic custom-install SQL function is the only schema-level addition.
