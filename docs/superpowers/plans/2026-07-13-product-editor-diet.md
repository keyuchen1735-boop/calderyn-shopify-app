# Product Editor Diet Implementation Plan

> **For agentic workers:** implement this plan task-by-task with a red/green loop. Keep the branch in its existing isolated worktree (`C:\Users\famou\Desktop\calderyn-product-diet`) and commit each task only after its focused checks pass.

**Goal:** Turn the new-product Details step and the existing-product editor from walls of controls into a short, animated hierarchy without changing the catalog data model, product payload, routes, or save behavior.

**Architecture:** Add one uncontrolled, accessible `Reveal` primitive to the dashboard UI layer. It keeps its children mounted so controlled fields and inventory data survive collapse, while `aria-hidden` + the DOM `inert` property keep closed controls out of the accessibility and tab trees. Use the primitive for the wizard receipts, wizard Organize block, and five editor section cards. Put all editor summary decisions in pure helpers returning `{ text, warning }`; the editor only supplies current state and renders the result. The existing `InventoryPanel` remains the owner of inventory reads/writes and reports successful balance reads upward through an optional callback so the Stock summary stays live without a second set of API calls.

**Tech Stack:** TypeScript, React 18, Remix/Vite, GSAP + `@gsap/react`, Vitest, dashboard `cd-*` CSS tokens.

**Spec:** `docs/superpowers/specs/2026-07-13-product-editor-diet-design.md`

**Branch/worktree:** `feat/product-editor-diet` in `C:\Users\famou\Desktop\calderyn-product-diet` (spec already committed).

---

## Locked decisions

- All revealers start closed. Multiple editor sections may be open at once; no accordion coordinator and no warning-driven auto-open.
- Reveal children stay mounted. This preserves every existing controlled input, media handler, inventory panel, and save binding.
- A closed panel is `aria-hidden` and `HTMLElement.inert = true`; opening removes `inert` before the height tween. If a panel closes while focus is inside it, focus returns to the trigger.
- The required height tween is confined to one clipped wrapper. The chevron uses a transform. On completion, an open wrapper clears to `height: auto`; reduced motion sets the end state immediately.
- The editor makes no new data request. `InventoryPanel` reports the balances it already fetches to `ProductEditor`; until all tracked variants report, the Stock helper falls back to `VariantDraft.inventoryOnHand` and omits the location count.
- The Stock row is still present when every variant is untracked. Its summary is `Not tracked`, and its body explains that tracking is enabled from Variants; no inventory mutation is added.
- Warning summaries include the visible `⚠` suffix and return `warning: true`. Only `Out of stock ⚠` and incomplete physical shipping are warning rows.
- Use existing `var(--orange)` / `var(--orange-bg)` warning tokens. Add no colors, decoration, tabs, or preview-first layout.
- The named design-taste skills in the spec must be applied during implementation if they are available in the execution environment. If they remain unavailable, follow the locked quiet-row hierarchy in this plan and do not delay functional work.

---

## File structure

- `app/components/dashboard/screens/product-editor-summaries.ts` — five pure section-summary helpers and the shared `{ text, warning }` result type.
- `app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts` — all helper branches, including warning cases.
- `app/components/dashboard/ui.tsx` — shared `Reveal` component.
- `app/components/dashboard/__tests__/reveal.test.tsx` — real click/open/close/accessibility-state test.
- `package.json`, `package-lock.json` — add `jsdom` as a dev-only Vitest environment; no runtime bundle impact.
- `app/styles/dashboard.css` — reveal/card/receipt styling and narrow-width prompt layout.
- `app/components/dashboard/screens/NewProductFlow.tsx` — collapsed receipts, collapsed Organize, copy diet, normal-flow layout.
- `app/components/dashboard/screens/InventoryPanel.tsx` — optional successful-balance callback only; existing reads/writes/UI stay intact.
- `app/components/dashboard/screens/ProductEditor.tsx` — header status pill, always-open Essentials, five collapsed sections, live summaries.

No route, server, Supabase, Prisma, screen-cache, storefront, or legacy embedded-app file changes.

---

### Task 1: Add the pure editor summary contract

**Files:**

- Create: `app/components/dashboard/screens/product-editor-summaries.ts`
- Create: `app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts`

- [ ] **Step 1: Write the failing summary test matrix**

Use structural fixtures typed from `client.VariantDraft` and `client.VariantBalanceVM`. Cover these exact behaviors:

`variantsSummary(options, variants)`

- one priced variant → `Single variant — $24`
- one unpriced variant → `Single variant — no price`
- one named option whose value count matches the variants, all same price → `3 sizes — all $129`
- multiple options or a non-matching option shape, all same price → `4 variants — all $129`
- differing prices → `4 variants — mixed prices`
- all prices missing → `4 variants — no prices`
- never warns

`stockSummary(variants, balancesByVariant)`

- every variant has `inventoryTracked === false` → `Not tracked`, no warning
- positive flat fallback before panel balances arrive → `75 on hand`, no warning
- complete balance reports aggregate on-hand and unique location ids → `75 on hand · 1 location`
- unique location pluralization → `75 on hand · 2 locations`
- tracked total zero → `Out of stock ⚠`, warning
- a partial balance map does not claim a location count; use the flat fallback until every persisted tracked variant has reported

`shippingSummary(variants)`

- all variants are digital (`requiresShipping === false`) → `No shipping needed`
- one complete physical shape (600 g, 400/350/80 mm) → `600 g · 40×35×8 cm`
- identical shapes across physical variants keep the compact measurement summary
- complete but mixed shapes → `3 variants · shipping complete`
- missing weight only → `Missing weight ⚠`, warning
- missing one or more dimensions only → `Missing dimensions ⚠`, warning
- missing both → `Missing weight + dimensions ⚠`, warning
- digital variants do not make a mixed product incomplete

`searchSummary(input)`

- no handle edit and no SEO override → `Automatic`
- saved meta title only → `Custom title`
- meta title + description → `Custom title + description`
- dirty handle + title → `Custom address + title`
- `seoAvailable: false` → `Temporarily unavailable`, no warning

`organizeSummary(vendor, tagsText, collectionIds)`

- all blank → `Nothing yet`
- tag parsing ignores blank comma segments and singular/plural is correct
- tags without collections → `2 tags · no collections`
- vendor is included as its trimmed value
- selected collections are singular/pluralized
- never warns

Run:

```powershell
npx vitest run app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 2: Implement the helpers as pure functions**

Use this public shape:

```ts
export interface EditorSectionSummary {
  text: string;
  warning: boolean;
}

export function variantsSummary(
  options: ReadonlyArray<{ name: string; values: readonly string[] }>,
  variants: readonly VariantDraft[],
): EditorSectionSummary;

export function stockSummary(
  variants: readonly VariantDraft[],
  balancesByVariant: Readonly<Record<string, readonly VariantBalanceVM[]>>,
): EditorSectionSummary;

export function shippingSummary(
  variants: readonly VariantDraft[],
): EditorSectionSummary;

export function searchSummary(input: {
  handle: string;
  savedHandle: string;
  metaTitle: string;
  metaDescription: string;
  seoAvailable: boolean;
}): EditorSectionSummary;

export function organizeSummary(
  vendor: string,
  tagsText: string,
  collectionIds: readonly string[],
): EditorSectionSummary;
```

Implementation rules:

- Import `VariantDraft` / `VariantBalanceVM` with `import type` only and `money` from `../format` for price formatting.
- Treat a price as present only when `Number.isFinite(variant.retailPriceCents)`.
- Use a small private `plural(count, singular)` helper. For a one-option descriptor, lowercase the option name and pluralize common names (`Size` → `sizes`, `Color` → `colors`); otherwise fall back to `variants` rather than producing awkward copy.
- A physical variant is `requiresShipping !== false`. A required shipping number is complete only when it is finite and greater than zero.
- Convert millimetres to centimetres with at most one decimal and no trailing `.0`.
- For stock, include only tracked variants (`inventoryTracked !== false`). The balance map is complete only when every tracked persisted variant id is an own key, including ids that reported an empty array. Sum each reported row's `onHand` and deduplicate `locationId`; otherwise use the variants' flat `inventoryOnHand` values.
- Keep the warning symbol in `text`; `warning` exists so the row can receive the warning tone without parsing copy.

- [ ] **Step 3: Run the focused suite and typecheck**

```powershell
npx vitest run app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```powershell
git add app/components/dashboard/screens/product-editor-summaries.ts app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts
git commit -m "dashboard/ProductEditor: add section summary helpers"
```

---

### Task 2: Build and test the shared Reveal primitive

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `app/components/dashboard/ui.tsx`
- Create: `app/components/dashboard/__tests__/reveal.test.tsx`
- Modify: `app/styles/dashboard.css`

- [ ] **Step 1: Add the dev-only DOM test environment**

Run:

```powershell
npm install --save-dev jsdom
```

Tradeoff: this adds test-install weight only. It is not imported by application code and does not enter the browser bundle. Do not add Testing Library; use the existing `react-dom/client`, `react-dom/test-utils`, and DOM APIs.

- [ ] **Step 2: Write the failing interactive test**

At the top of `reveal.test.tsx`, select jsdom for this file:

```ts
// @vitest-environment jsdom
```

Mock `gsap` and/or `reduced()` so state changes are synchronous and the test is about the component contract, not tween internals. Render a `Reveal` containing a focusable input with `createRoot` + `act`, then assert:

- initial trigger has `aria-expanded="false"`
- body has `aria-hidden="true"` and `inert === true`
- first click changes to expanded, removes inert, and leaves the child mounted
- second click returns to collapsed/inert
- when the input is focused and the reveal closes, focus returns to the trigger
- warning mode sets `data-warning="1"`
- trigger and body are joined by `aria-controls` / matching `id`

Run:

```powershell
npx vitest run app/components/dashboard/__tests__/reveal.test.tsx
```

Expected: FAIL because `Reveal` is not exported.

- [ ] **Step 3: Implement `Reveal` in `ui.tsx`**

Add `useCallback` if needed and expose this deliberately small API:

```ts
export function Reveal({
  label,
  summary,
  warning = false,
  className = "",
  children,
}: {
  label: ReactNode;
  summary?: ReactNode;
  warning?: boolean;
  className?: string;
  children: ReactNode;
})
```

Render structure/classes:

```text
.cd-reveal[data-open][data-warning]
  button.cd-reveal-trigger[aria-expanded][aria-controls]
    .cd-reveal-chev (Lucide chevronRight)
    .cd-reveal-label
    .cd-reveal-summary (optional)
  .cd-reveal-body[id][aria-hidden]
    .cd-reveal-inner
```

Motion and lifecycle:

- Store open state internally with `useState(false)` so every instance starts closed and instances remain independent.
- Scope `useGSAP` to a root ref; target body and chevron refs, not global selector strings.
- On first render, set the closed end state without animating.
- Before opening: `body.inert = false`, read `inner.offsetHeight` once, tween body `height: 0 → measured` and chevron `rotation: 0 → 90`; on completion clear body height to `auto`.
- Before closing: if focus is inside the body, focus the trigger; set `body.inert = true` immediately, freeze the current pixel height if it was `auto`, then tween to `height: 0` and chevron to `0`.
- Use `overwrite: "auto"` so rapid toggles reverse cleanly instead of stacking tweens.
- When `reduced()` is true, kill/skip tweens and set `height` / rotation directly.
- Use `revertOnUpdate: true` and context-safe callbacks so unmount removes GSAP state.
- Do not conditionally render `children` and do not use the `hidden` attribute; both would defeat the height exit animation or reset nested form state.

- [ ] **Step 4: Add the base reveal styles**

Use only existing tokens. The base styles should provide:

- full-width transparent button, 44px minimum target, inherited font, visible keyboard focus
- chevron as a fixed 16px flex item
- label at row-title weight and summary in the quieter caption/text-2 tone
- summary truncation on one line (`min-width: 0`, ellipsis) rather than pushing the chevron/label off-screen
- clipped body with initial `height: 0`
- inner padding controlled by modifiers
- `[data-warning="1"]` label/summary color using `var(--orange)` and a restrained `var(--orange-bg)` mix on hover/focus
- no `will-change: height`; height is the spec-required layout animation and should remain confined to this wrapper

Add modifier contracts used by later tasks:

- `.cd-reveal--card`: card-row trigger padding and body padding
- `.cd-reveal--inline`: light hairline boundaries, no nested card chrome
- `.cd-reveal--receipt`: trigger is a compact green badge; body holds a wrapping chip row in normal flow

At `max-width: 560px`, allow the trigger summary to consume the remaining width and truncate; do not hide it.

- [ ] **Step 5: Run focused tests, typecheck, and lint touched files**

```powershell
npx vitest run app/components/dashboard/__tests__/reveal.test.tsx
npm run typecheck
npx eslint --max-warnings=0 app/components/dashboard/ui.tsx app/components/dashboard/__tests__/reveal.test.tsx
```

Expected: all exit 0.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json app/components/dashboard/ui.tsx app/components/dashboard/__tests__/reveal.test.tsx app/styles/dashboard.css
git commit -m "dashboard/ui: add accessible GSAP Reveal primitive"
```

---

### Task 3: Diet the wizard Details step

**Files:**

- Modify: `app/components/dashboard/screens/NewProductFlow.tsx`
- Modify: `app/styles/dashboard.css`

- [ ] **Step 1: Give the prompt/receipt stack explicit layout classes**

Replace the prompt bar's large inline layout block with a `cd-npf-prompt` class while retaining only truly dynamic inline values. Replace the receipt wrapper's `marginTop: -6` with `cd-npf-receipts`.

CSS behavior:

- desktop/tablet: preserve the current single prompt row
- at `max-width: 560px`: let the prompt container wrap in normal flow; keep spark + input on the first flexible line and let Photos/Apply form a second line when needed
- every child uses `min-width: 0` where applicable; no fixed width, absolute positioning, negative margin, or z-index is used to make the stack fit
- receipts and their expanded chip list contribute real height above the active step card

- [ ] **Step 2: Collapse multiple receipts with `Reveal`**

Derive `visibleReceipts = receipts.slice(-4)` once.

- zero: render nothing
- one: render the existing green receipt badge unchanged
- two or more: render one `.cd-reveal--receipt` trigger with a check icon and `${visibleReceipts.length} changes`; put the individual existing badges in the reveal body

The trigger starts closed. The count is the number of receipts actually available in the expanded list, not the unbounded historical state length.

- [ ] **Step 3: Collapse Organize and shorten the label**

Import `Reveal` and `organizeSummary`. Replace the open Organize block with `.cd-reveal--inline`:

- label: `Organize (optional)`
- summary: omit it when the helper returns `Nothing yet`; otherwise use the helper text so vendor/tags/collection edits update it immediately
- body: move the existing Vendor, Tags, and Collections controls unchanged
- delete `Optional — helps group products later. Fine to skip.`

Change `Weight (grams)` to `Weight (g)` and make no other copy longer.

- [ ] **Step 4: Run focused existing tests, typecheck, and lint**

```powershell
npx vitest run app/components/dashboard/screens/__tests__/new-product-copy.test.ts app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts app/components/dashboard/__tests__/reveal.test.tsx
npm run typecheck
npx eslint --max-warnings=0 app/components/dashboard/screens/NewProductFlow.tsx
```

Expected: all exit 0.

- [ ] **Step 5: Browser-check the wizard at the required widths before committing**

Run the app with the branch's normal dev command, open New product, create at least four receipts, and inspect the Details step at 360, 768, and 1280 CSS pixels.

Verify:

- one compact receipt trigger when N > 1; one original chip when N = 1
- expanded chips push Sizes & colors downward
- Organize starts closed and preserves typed values across close/open
- prompt buttons wrap without horizontal overflow at 360px
- no overlap with the Sizes & colors card and no z-index workaround
- reduced-motion emulation produces immediate state changes

- [ ] **Step 6: Commit**

```powershell
git add app/components/dashboard/screens/NewProductFlow.tsx app/styles/dashboard.css
git commit -m "dashboard/NewProductFlow: collapse receipts and optional details"
```

---

### Task 4: Feed live inventory balances into the Stock summary

**Files:**

- Modify: `app/components/dashboard/screens/InventoryPanel.tsx`
- Modify: `app/components/dashboard/screens/ProductEditor.tsx`

- [ ] **Step 1: Add an optional observation callback to `InventoryPanel`**

Extend the props with:

```ts
onBalancesChange?: (
  variantId: string,
  balances: readonly client.VariantBalanceVM[],
) => void;
```

In `reload`, replace the direct `fetchVariantInventory(...).then(setRows)` with a handler that sets the same rows and then calls `onBalancesChange?.(variantId, nextRows)`. Call it for an empty successful result too, because an own empty-array entry tells `stockSummary` that the variant finished loading. Do not call it on a failed read, and do not alter pending-transfer handling, write methods, error copy, or rendering.

- [ ] **Step 2: Collect balances in the editor without extra requests**

In `ProductEditorEdit`:

- add `useCallback` to the React import
- add `balancesByVariant` state as `Record<string, readonly client.VariantBalanceVM[]>`
- reset it when `id` changes / a new product payload starts loading so one product cannot flash another product's stock
- add a stable `onBalancesChange` callback that immutably writes `balancesByVariant[variantId]`
- pass it to each existing `InventoryPanel`

Do not fetch inventory from `ProductEditor`, and do not lift inventory write ownership out of `InventoryPanel`.

- [ ] **Step 3: Typecheck and lint**

```powershell
npm run typecheck
npx eslint --max-warnings=0 app/components/dashboard/screens/InventoryPanel.tsx app/components/dashboard/screens/ProductEditor.tsx
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```powershell
git add app/components/dashboard/screens/InventoryPanel.tsx app/components/dashboard/screens/ProductEditor.tsx
git commit -m "dashboard/ProductEditor: surface live stock summary data"
```

---

### Task 5: Recompose the edit page into Essentials + five collapsed cards

**Files:**

- Modify: `app/components/dashboard/screens/ProductEditor.tsx`
- Modify: `app/styles/dashboard.css`

- [ ] **Step 1: Add the live header status pill**

Add the same local status-tone mapping used by Catalog (`active → success`, `draft → neutral`, `archived → warn`). Place a live `Pill` beside `Edit product`; its label is sentence-cased (`Active`, `Draft`, `Archived`). Keep the existing back control, Archive behavior, Save behavior, loading/error states, and action placement.

Do not show a fake draft pill while the product is loading: render the status pill only after the product detail has loaded successfully.

- [ ] **Step 2: Derive all five summaries before JSX**

Call the helpers directly from current editor state on every render:

```ts
const variantsMeta = variantsSummary(parseOptions(options), variants);
const stockMeta = stockSummary(variants, balancesByVariant);
const shippingMeta = shippingSummary(variants);
const searchMeta = searchSummary({
  handle,
  savedHandle,
  metaTitle,
  metaDescription,
  seoAvailable: !seoUnavailable,
});
const organizeMeta = organizeSummary(vendor, tags, selectedCollections);
```

No section-row summary wording or warning predicate should remain inline in JSX. The existing per-variant `Incomplete — rates estimated` body note may keep its current local predicate: it is part of the expanded shipping form, while `shippingSummary` is the single source for the collapsed row's text and tone.

- [ ] **Step 3: Build the always-open Essentials card**

Create one card titled `Essentials` containing, in this order:

1. Title
2. Status
3. Description
4. Images (existing gallery/upload/reorder/alt/remove UI and handlers unchanged)

Move Vendor and Tags out. Remove the old standalone Images card after its contents have moved. Preserve media sorting and every optimistic rollback path exactly.

- [ ] **Step 4: Merge Options + Variants into the Variants revealer**

Render:

```tsx
<Card pad={false}>
  <Reveal
    className="cd-reveal--card"
    label="Variants"
    summary={variantsMeta.text}
    warning={variantsMeta.warning}
  >
    {/* existing Options editor */}
    {/* hairline divider */}
    {/* existing Variants grid */}
  </Reveal>
</Card>
```

Keep quiet internal `Options` and `Variants` subheads so the expanded body remains scannable. Preserve `regen`, the table fields, the tracked checkbox, horizontal overflow, and the existing stock guidance.

- [ ] **Step 5: Wrap Stock and Shipping**

Stock:

- always render the Stock revealer
- use `stockMeta.text` / `stockMeta.warning`
- when tracked persisted variant ids exist, move the existing per-variant `InventoryPanel` list inside unchanged
- otherwise show one caption: `Turn on inventory tracking in Variants to manage stock by location.`

Shipping:

- move the existing per-variant shipping contents into a Shipping revealer
- use `shippingMeta.text` / `shippingMeta.warning`
- keep weight, dimensions, handling, signature, restricted-country inputs, physical toggle, and body warning note wired exactly as today

- [ ] **Step 6: Wrap Search listing and Organize**

Search listing:

- use `searchMeta`
- move the current handle/meta/preview/unavailable-status content intact
- keep the existing caption inside the expanded body

Organize:

- use `organizeMeta`
- move Vendor and Tags from Essentials into the top of the body
- move the current Collections body below them
- preserve collections failure/empty/selection behavior and save payload fields

All five revealers start closed independently. Do not introduce an `openSection` parent state.

- [ ] **Step 7: Add editor-specific spacing styles**

Add only what the shared reveal modifiers cannot express:

- a calm internal stack for expanded editor bodies
- hairline separation between Options and the variant grid
- mobile-safe two-column field fallbacks where the existing generic grid would be too narrow
- no new card shadows, gradients, colored borders, or warning colors

At 360px, row label and summary must remain one visual line; the summary truncates before the chevron/label/action geometry breaks.

- [ ] **Step 8: Run focused tests, typecheck, and lint**

```powershell
npx vitest run app/components/dashboard/screens/__tests__/product-editor-summaries.test.ts app/components/dashboard/__tests__/reveal.test.tsx app/lib/dashboard/__tests__/client-inventory.test.ts
npm run typecheck
npx eslint --max-warnings=0 app/components/dashboard/screens/ProductEditor.tsx app/components/dashboard/screens/InventoryPanel.tsx app/components/dashboard/screens/product-editor-summaries.ts
```

Expected: all exit 0.

- [ ] **Step 9: Browser-check the existing-product editor**

Use the Peak & Pine multi-variant product named in the spec, or an equivalent product with at least three variants, tracked stock, and one incomplete physical shipping shape.

Verify at 360, 768, and 1280 CSS pixels:

- header retains back/Archive/Save and shows the live status pill
- Essentials is the only open card on first paint
- five quiet rows start closed; more than one can stay open
- Variants summary changes immediately when price/options change
- Stock changes from the flat fallback to the location-aware summary after existing panels load, then updates after an on-hand edit
- out-of-stock and incomplete-shipping rows are orange/warning-toned but remain closed
- Search and Organize summaries update while typing/selecting
- fields retain values after close/open
- keyboard focus cannot enter a closed body; closing a focused body returns focus to its trigger
- reduced-motion emulation skips tweening
- Archive and Save still call the existing handlers; no request payload fields changed

- [ ] **Step 10: Commit**

```powershell
git add app/components/dashboard/screens/ProductEditor.tsx app/styles/dashboard.css
git commit -m "dashboard/ProductEditor: collapse optional product sections"
```

---

### Task 6: Full regression gate and production walk-through handoff

**Files:** none unless a check finds a defect.

- [ ] **Step 1: Review the complete branch diff**

Review against `origin/main`, not only the last commit:

```powershell
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- app/components/dashboard/screens/NewProductFlow.tsx app/components/dashboard/screens/ProductEditor.tsx app/components/dashboard/screens/InventoryPanel.tsx app/components/dashboard/ui.tsx app/styles/dashboard.css
```

Confirm:

- no route/API/schema/save contract changed
- no legacy `app/routes/app.*` or Polaris file changed
- no new runtime dependency
- no raw SVG, new icon library, z-index fix, negative layout margin, client source map, provenance marker, `console.log`, `.only`, or commented-out implementation
- Reveal is the only expand/collapse implementation; wizard/editor do not carry local tween copies
- warnings come only from summary helper output

- [ ] **Step 2: Run the required code review and patch sanity**

Run `/code-review` on the branch. Resolve blockers; record any intentionally deferred nit with a one-line reason.

Then:

```powershell
git diff --check origin/main...HEAD
git status --short
```

Expected: diff check is clean; status is clean before the full gate.

- [ ] **Step 3: Run the full repository gate in order**

```powershell
npm run typecheck
npm run lint
npm run build
npx vitest run
```

Expected: every command exits 0. The full Vitest run is mandatory (lesson from #448). Prisma validation/migration diff and GraphQL codegen are N/A because this plan changes none of those files.

- [ ] **Step 4: Re-run the required browser matrix**

Before handoff, repeat:

- wizard Details receipts + Organize at 360/768/1280
- existing-product editor first paint and all five rows at 360/768/1280
- missing shipping dimensions and out-of-stock warnings
- reduced-motion mode
- one Save smoke test proving the unchanged payload still persists edits

Record screenshots/notes for the deploy walk-through. After deployment, repeat the same Peak & Pine and wizard checks against production.

- [ ] **Step 5: Final implementation commit only if verification required fixes**

If the gate or walk-through produced fixes, commit one focused polish commit after rerunning the affected focused test and the full gate:

```powershell
git add <only-the-fix-files>
git commit -m "dashboard/ProductEditor: finish collapsed editor polish"
```

Do not push or open a PR until explicitly requested.

---

## Self-review

**Spec coverage**

- Wizard N>1 receipts collapse to one live count; N=1 stays unchanged — Task 3.
- Wizard Organize starts closed with a live summary; redundant caption removed — Task 3.
- `Weight (grams)` → `Weight (g)` — Task 3.
- 360/768/1280 overlap audit uses normal flow, no z-index fix — Tasks 3 and 6.
- Header status pill + unchanged actions — Task 5.
- Essentials always open with Title, Status, Description, Images — Task 5.
- Variants, Stock, Shipping, Search listing, Organize all closed and independently openable — Task 5.
- Warning rows remain closed and use existing warning tone — Tasks 1, 2, and 5.
- All summary text lives in five pure helpers with full branch tests — Task 1.
- One GSAP/reduced-motion Reveal primitive is shared by both surfaces — Tasks 2, 3, and 5.
- Reveal open/close state is exercised by a real DOM click test — Task 2.
- Full suite + typecheck/lint/build + production walk-through handoff — Task 6.

**Data/save safety**

- `ProductDraft`, `ProductDetailVM`, route loaders/actions, catalog writers, database schema, and save handlers are untouched.
- Inventory balance reporting is observational and piggybacks on existing reads; it adds no request and changes no mutation.
- Closed form controls remain mounted, so save data and local edits cannot disappear on collapse.

**Known implementation tradeoff**

- `jsdom` is one new dev-only dependency so the required Reveal interaction test can exercise clicks, focus, `aria-expanded`, and `inert` in Vitest's otherwise Node-only setup. It has no application runtime or bundle cost.
