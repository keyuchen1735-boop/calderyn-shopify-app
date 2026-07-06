# Storegen Taste (taste-skill v2 + typeStyle/density levers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the `design-taste-frontend` v2 agent skill and add two curated visual levers — `typeStyle` and `density` — to the store generator, rendered as `[data-*]` CSS packs like the existing `vibe`, plus taste-principle prompt edits.

**Architecture:** Mirror the existing `vibe`/`palette` pattern exactly (curated allow-list → validated in `parseBrandPlan` → persisted in `store_settings` → rendered via `[data-*]` token packs on `.cd-store`). Both new levers are **zero-regression**: their defaults (`classic`, `standard`) reproduce today's rendering, so existing rows are untouched. `typeStyle` owns font-family tokens *only when non-default*, resolving the collision with `vibe` (which currently sets `--cd-font-display`).

**Tech Stack:** TypeScript (Remix), Supabase Postgres (SQL migrations + RLS), Vitest, the `skills` CLI (`npx skills add`), custom `cd-*` storefront CSS.

**Spec:** `docs/superpowers/specs/2026-07-06-taste-skill-storegen-design.md`

**Locked vocabulary (use these exact strings everywhere):**
- `StudioTypeStyle = "classic" | "editorial" | "rounded"` — default `"classic"` (defers to vibe's font; no `--cd-font-display` override). `editorial` = serif heading, `rounded` = rounded heading; body stays sans for all.
- `StudioDensity = "compact" | "standard" | "roomy"` — default `"standard"` (= today's `--cd-gap: 16px`).

**Branch:** `feat/storegen-taste` (already created; spec committed there).

---

## File Structure

- `.claude/skills/`, `skills-lock.json`, `CLAUDE.md` — agent skill install + usage rule (Task 1).
- `app/lib/storebuilder/studio-types.ts` — add `StudioTypeStyle`/`StudioDensity` unions + `StudioSettings` fields (Task 2).
- `supabase/migrations/20260706120000_store_settings_type_density.sql` — 2 new columns + CHECK (Task 3).
- `app/lib/storegen/block-plan.ts` — `BrandPlan` fields, `TYPE_STYLES`/`DENSITIES` consts, `parseBrandPlan` validate/default (Task 4).
- `app/lib/storefront/settings.server.ts` — `StoreSettings`/`StoreSettingsInput` fields, select, row-map, upsert, `defaults()` (Task 5).
- `app/lib/storegen/generate.server.ts` — brand fallback + conditional-spread write + `FallbackContext` (Task 6).
- `app/lib/storegen/prompts.ts` — brand JSON shape + curated menus + taste-principle edits (Task 7).
- `app/lib/storebuilder/studio.server.ts` — `loadStudioState` DTO map (Task 8).
- `app/routes/storefront.tsx` + `app/styles/storefront.css` — `data-*` attrs + `[data-type]`/`[data-density]` packs + `--cd-font-body` token (Task 9).
- Eval: `docs/superpowers/plans/` note — taste audit of sample stores (Task 10).

Each task ends green (typecheck + its tests) and commits. Run the full gate (`npm run typecheck && npm run lint && npm run build && npx vitest run`) before the final merge.

---

### Task 1: Install taste-skill v2 + CLAUDE.md rule

**Files:**
- Modify: `skills-lock.json`, `.claude/skills/` (created by the CLI)
- Modify: `CLAUDE.md` (design-conventions section)

- [ ] **Step 1: Install the skill (v2 default)**

Run: `npx skills add Leonxlnx/taste-skill`
Expected: the CLI adds an entry to `skills-lock.json` and writes `.claude/skills/design-taste-frontend/SKILL.md` (v2 is the default). If it prompts for a variant, pick `design-taste-frontend` (v2).

- [ ] **Step 2: Verify the install**

Run: `cat skills-lock.json | grep -i taste; ls .claude/skills/`
Expected: a `skills-lock.json` entry sourced from `Leonxlnx/taste-skill`, and a `design-taste-frontend` skill directory present alongside `emil-design-eng`.

- [ ] **Step 3: Add the usage rule to CLAUDE.md**

In `CLAUDE.md`, under the `## Language & style` → UI bullet (near the `cd-*`/Lucide rules), add:

```markdown
- **Design taste:** when generating or restyling dashboard/storefront UI (including storegen prompt/lever work), apply the `design-taste-frontend` skill (taste-skill v2) to avoid generic output; it composes with `emil-design-eng`. If v2 (experimental) misbehaves, install `design-taste-frontend-v1` and use that instead.
```

- [ ] **Step 4: Commit**

```bash
git add skills-lock.json .claude/skills CLAUDE.md
git commit -m "chore(skills): add design-taste-frontend v2 + CLAUDE.md usage rule"
```

---

### Task 2: Add `StudioTypeStyle` / `StudioDensity` union types

**Files:**
- Modify: `app/lib/storebuilder/studio-types.ts:8` (next to `StudioVibe`)

- [ ] **Step 1: Add the union types + StudioSettings fields**

After the `StudioVibe` definition (line 8), add:

```ts
/** Mirrors the store_settings.type_style check constraint. "classic" defers to
 *  the vibe's font (no [data-type] override); editorial/rounded set their own. */
export type StudioTypeStyle = "classic" | "editorial" | "rounded";

/** Mirrors the store_settings.density check constraint (storefront [data-density]
 *  spacing pack). "standard" = today's spacing. */
export type StudioDensity = "compact" | "standard" | "roomy";
```

In `interface StudioSettings` (currently ends at line 18), add two fields after `vibe`:

```ts
  vibe: StudioVibe;
  typeStyle: StudioTypeStyle;
  density: StudioDensity;
```

- [ ] **Step 2: Typecheck (expected to fail — consumers don't set the new fields yet)**

Run: `npm run typecheck`
Expected: FAIL — errors where `StudioSettings` objects are constructed without `typeStyle`/`density` (e.g. `studio.server.ts` `loadStudioState`). That is expected; Task 8 fixes the DTO. To keep tasks independently green, make the two fields optional for now — change to:

```ts
  typeStyle?: StudioTypeStyle;
  density?: StudioDensity;
```

Re-run: `npm run typecheck` → PASS. (Task 8 populates them; they stay optional on the client DTO, which is fine — the storefront reads from `StoreSettings`, not this DTO.)

- [ ] **Step 3: Commit**

```bash
git add app/lib/storebuilder/studio-types.ts
git commit -m "feat(storegen): add StudioTypeStyle/StudioDensity types"
```

---

### Task 3: DB migration — `type_style` + `density` columns

**Files:**
- Create: `supabase/migrations/20260706120000_store_settings_type_density.sql`

- [ ] **Step 1: Write the migration (mirrors the vibe column added in `20260705100000_store_studio_v2.sql`)**

```sql
-- Two curated storefront design levers the CSS packs key off, alongside vibe:
-- type_style ([data-type] font pairing) and density ([data-density] spacing).
-- Defaults reproduce today's rendering (classic defers to vibe's font; standard
-- = current spacing), so existing rows are unaffected.
alter table public.store_settings
  add column if not exists type_style text not null default 'classic'
    check (type_style in ('classic','editorial','rounded'));

alter table public.store_settings
  add column if not exists density text not null default 'standard'
    check (density in ('compact','standard','roomy'));
```

- [ ] **Step 2: Apply to the database via the supabase MCP**

Use the supabase MCP `apply_migration` tool with name `store_settings_type_density` and the SQL above (project `ajgrmnvzxfxxlwrxcgnu`). Confirm success (no error).

- [ ] **Step 3: Verify the columns exist**

Use the supabase MCP `list_tables` (or `execute_sql`: `select column_name, column_default from information_schema.columns where table_name='store_settings' and column_name in ('type_style','density');`).
Expected: both columns present with defaults `'classic'` / `'standard'`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260706120000_store_settings_type_density.sql
git commit -m "feat(db): store_settings type_style + density columns"
```

---

### Task 4: `block-plan.ts` — parse + validate the new fields

**Files:**
- Modify: `app/lib/storegen/block-plan.ts` (`BrandPlan` ~line 10, add consts ~line 37, `parseBrandPlan` ~line 111)
- Test: `app/lib/storegen/block-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `app/lib/storegen/block-plan.test.ts`:

```ts
it("parses typeStyle and density, defaulting invalid/missing to classic/standard", () => {
  const ok = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold","typeStyle":"editorial","density":"roomy","voiceTagline":"Go"}');
  expect(ok?.typeStyle).toBe("editorial");
  expect(ok?.density).toBe("roomy");

  const bad = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold","typeStyle":"comic-sans","density":"huge"}');
  expect(bad?.typeStyle).toBe("classic");
  expect(bad?.density).toBe("standard");

  const missing = parseBrandPlan('{"storeName":"Acme","paletteName":"Midnight","vibe":"bold"}');
  expect(missing?.typeStyle).toBe("classic");
  expect(missing?.density).toBe("standard");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storegen/block-plan.test.ts -t typeStyle`
Expected: FAIL — `typeStyle`/`density` are `undefined` on the result.

- [ ] **Step 3: Implement**

In `block-plan.ts`, import the types (extend the existing `studio-types` import on line 6):

```ts
import type { StudioVibe, StudioTypeStyle, StudioDensity } from "~/lib/storebuilder/studio-types";
```

Extend `BrandPlan` (after `vibe: StudioVibe;`):

```ts
  vibe: StudioVibe;
  typeStyle: StudioTypeStyle;
  density: StudioDensity;
```

Add allow-lists next to `VIBES` (line 37):

```ts
const TYPE_STYLES: readonly StudioTypeStyle[] = ["classic", "editorial", "rounded"];
const DENSITIES: readonly StudioDensity[] = ["compact", "standard", "roomy"];
```

In `parseBrandPlan`, after the `const vibe = ...` line (line 111), add (same idiom):

```ts
  const typeStyle = TYPE_STYLES.includes(p.typeStyle as StudioTypeStyle) ? (p.typeStyle as StudioTypeStyle) : "classic";
  const density = DENSITIES.includes(p.density as StudioDensity) ? (p.density as StudioDensity) : "standard";
```

And add them to the returned object (after `vibe,`):

```ts
    vibe,
    typeStyle,
    density,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storegen/block-plan.test.ts`
Expected: PASS (new test + existing `parseBrandPlan` tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/storegen/block-plan.ts app/lib/storegen/block-plan.test.ts
git commit -m "feat(storegen): parse+validate typeStyle/density in brand plan"
```

---

### Task 5: `settings.server.ts` — persist + read the new fields

**Files:**
- Modify: `app/lib/storefront/settings.server.ts` (type ~line 9, input ~line 18, VIBES-area ~line 31, `defaults()` ~line 34, `getStoreSettings` select+map ~line 40/58, `saveStoreSettings` ~line 76)
- Test: `app/lib/storefront/__tests__/settings.server.test.ts` (create if absent; else the existing settings test file)

- [ ] **Step 1: Write the failing test**

Add (create the file with the existing mock pattern if none — mirror `getStoreSettings`/`saveStoreSettings` tests already present in the repo):

```ts
it("reads type_style/density with defaults and writes them when provided", async () => {
  // getStoreSettings maps an invalid stored value to the default
  const s = mapRow({ store_name: "A", palette: null, logo_url: null, voice_tagline: null, vibe: "bold", type_style: "editorial", density: "junk" });
  expect(s.typeStyle).toBe("editorial");
  expect(s.density).toBe("standard");
});
```

(If the suite tests `getStoreSettings` via a mocked Supabase client rather than a `mapRow` export, assert on the returned `typeStyle`/`density` instead — match the file's existing style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storefront/__tests__/settings.server.test.ts -t type_style`
Expected: FAIL — `typeStyle`/`density` undefined.

- [ ] **Step 3: Implement — five edit points**

Add allow-lists near `VIBES` (line 31):

```ts
const TYPE_STYLES: readonly StudioTypeStyle[] = ["classic", "editorial", "rounded"];
const DENSITIES: readonly StudioDensity[] = ["compact", "standard", "roomy"];
```

Extend the `studio-types` import to include `StudioTypeStyle, StudioDensity`.

`StoreSettings` (after `vibe: StudioVibe;`):

```ts
  vibe: StudioVibe;
  typeStyle: StudioTypeStyle;
  density: StudioDensity;
```

`StoreSettingsInput` (after the optional `vibe?`):

```ts
  vibe?: StudioVibe;
  typeStyle?: StudioTypeStyle;
  density?: StudioDensity;
```

`defaults()` return (add fields):

```ts
  return { shopId, storeName: "Calderyn Demo Store", logoUrl: null, palette: DEFAULT_PALETTE, voiceTagline: null, vibe: "minimal", typeStyle: "classic", density: "standard" };
```

`getStoreSettings` — extend the `.select(...)` string to include the columns:

```ts
    .select("store_name, palette, logo_url, voice_tagline, vibe, type_style, density")
```

and the row→object map (after the `vibe:` line):

```ts
    vibe: VIBES.includes(data.vibe as StudioVibe) ? (data.vibe as StudioVibe) : "minimal",
    typeStyle: TYPE_STYLES.includes(data.type_style as StudioTypeStyle) ? (data.type_style as StudioTypeStyle) : "classic",
    density: DENSITIES.includes(data.density as StudioDensity) ? (data.density as StudioDensity) : "standard",
```

Also add the fields to the no-row `defaults(...)`-with-displayName branch (it spreads `defaults(shopId)`, so it already carries them — no change needed there).

`saveStoreSettings` — after the `if (input.vibe !== undefined) row.vibe = input.vibe;` line:

```ts
  if (input.typeStyle !== undefined) row.type_style = input.typeStyle;
  if (input.density !== undefined) row.density = input.density;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storefront/__tests__/settings.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/storefront/settings.server.ts app/lib/storefront/__tests__/settings.server.test.ts
git commit -m "feat(storegen): persist+read typeStyle/density in store settings"
```

---

### Task 6: `generate.server.ts` — write the new fields from a generated brand

**Files:**
- Modify: `app/lib/storegen/generate.server.ts` (brand fallback ~line 90, settings write ~line 100, FallbackContext seed ~line 116)
- Test: `app/lib/storegen/generate.server.test.ts`

- [ ] **Step 1: Write the failing test**

Add a case asserting a first-brand generation persists `typeStyle`/`density` (match the file's existing mock of `saveStoreSettings`):

```ts
it("persists typeStyle/density on first branding", async () => {
  // arrange: parseBrandPlan returns a plan with typeStyle/density (mock the model reply
  // or the parseBrandPlan result per this suite's existing pattern), hasStoreSettings=false
  await generateStore({ shopId: UUID, mode: "brief", brief: "make it editorial and roomy" });
  expect(saveStoreSettingsMock).toHaveBeenCalledWith(UUID, expect.objectContaining({ typeStyle: "editorial", density: "roomy" }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storegen/generate.server.test.ts -t typeStyle`
Expected: FAIL — the write omits `typeStyle`/`density`.

- [ ] **Step 3: Implement**

Brand fallback (the `if (!brand)` block ~line 90) — add fields from existing settings:

```ts
    brand = {
      storeName: existing.storeName || "My Store",
      palette: existing.palette,
      voiceTagline: existing.voiceTagline ?? "",
      vibe: existing.vibe ?? "minimal",
      typeStyle: existing.typeStyle ?? "classic",
      density: existing.density ?? "standard",
    };
```

Settings write (~line 100) — mirror the `vibe` conditional-spread so the merchant owns them after first set:

```ts
    await saveStoreSettings(input.shopId, {
      storeName: brand.storeName, palette: brand.palette, logoUrl: null, voiceTagline: brand.voiceTagline,
      ...(firstBrand || explicitBrief ? { vibe: brand.vibe, typeStyle: brand.typeStyle, density: brand.density } : {}),
    });
```

(`FallbackContext` seeding stays `vibe`-only — fallback copy varies by vibe only; see Task-6 note. No change needed there unless a later task varies fallback layout by density.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storegen/generate.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/storegen/generate.server.ts app/lib/storegen/generate.server.test.ts
git commit -m "feat(storegen): write typeStyle/density from generated brand"
```

---

### Task 7: `prompts.ts` — brand contract + taste-principle edits

**Files:**
- Modify: `app/lib/storegen/prompts.ts` (`BRAND_SYSTEM_PROMPT` lines 32-40; `HOME_FEWSHOT`/home guidance lines 58-98)
- Test: `app/lib/storegen/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("brand prompt instructs typeStyle and density with their allowed values", () => {
  expect(BRAND_SYSTEM_PROMPT).toContain('"typeStyle"');
  expect(BRAND_SYSTEM_PROMPT).toContain('"density"');
  expect(BRAND_SYSTEM_PROMPT).toContain("classic");
  expect(BRAND_SYSTEM_PROMPT).toContain("editorial");
  expect(BRAND_SYSTEM_PROMPT).toContain("compact");
  expect(BRAND_SYSTEM_PROMPT).toContain("roomy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storegen/prompts.test.ts -t typeStyle`
Expected: FAIL.

- [ ] **Step 3: Implement**

Update the JSON shape line (line 34):

```ts
  '{"storeName": string, "paletteName": string, "vibe": string, "typeStyle": string, "density": string, "voiceTagline": string}',
```

Add two enumerated lines after the `vibe MUST be one of` line (line 37), mirroring its style:

```ts
  '- typeStyle MUST be one of: "classic" (let the vibe pick the font), "editorial" (serif headings), "rounded" (rounded, friendly headings) — pick from the brief/catalog mood.',
  '- density MUST be one of: "compact", "standard", "roomy" — how much breathing room the store has; default "standard" unless the brief implies otherwise.',
```

Taste-principle edit (home guidance, lines 89-98): replace the single `HOME_FEWSHOT` reference with variety guidance so composition isn't identical every run. Change the "Example of an excellent home composition" bullet to:

```ts
      "- Vary the composition to fit THIS catalog — do not force a fixed template. Strong homes lead",
      "  with a clear hero, then alternate rhythm (a product grid, a short story, a collection list)",
      "  chosen by what the catalog actually has; a single-collection shop needs fewer sections than a",
      "  multi-collection one. Keep strong visual hierarchy; avoid uniform, evenly-sized stacked blocks.",
      "- One illustrative composition (emulate its copy style and rhythm, NOT its literal structure or",
      "  catalog references):",
      HOME_FEWSHOT,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storegen/prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/storegen/prompts.ts app/lib/storegen/prompts.test.ts
git commit -m "feat(storegen): brand prompt gains typeStyle/density + layout-variety guidance"
```

---

### Task 8: `studio.server.ts` — expose new fields in the studio DTO

**Files:**
- Modify: `app/lib/storebuilder/studio.server.ts` (`loadStudioState` settings map, lines 145-152)
- Test: `app/lib/storebuilder/studio.server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("surfaces typeStyle/density in the studio settings DTO", async () => {
  // getStoreSettings mock returns typeStyle:"editorial", density:"roomy"
  const state = await loadStudioState(shopId);
  expect(state.settings.typeStyle).toBe("editorial");
  expect(state.settings.density).toBe("roomy");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/storebuilder/studio.server.test.ts -t typeStyle`
Expected: FAIL — DTO omits the fields.

- [ ] **Step 3: Implement**

In `loadStudioState`'s `settings` object (lines 145-152), after `vibe: settings.vibe,`:

```ts
      vibe: settings.vibe,
      typeStyle: settings.typeStyle,
      density: settings.density,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/storebuilder/studio.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/storebuilder/studio.server.ts app/lib/storebuilder/studio.server.test.ts
git commit -m "feat(storegen): expose typeStyle/density in studio DTO"
```

---

### Task 9: Storefront render — `[data-type]` / `[data-density]` packs

**Files:**
- Modify: `app/routes/storefront.tsx` (the `.cd-store` root, lines 57-62)
- Modify: `app/styles/storefront.css` (add packs after the vibe packs, ~line 92; add `--cd-font-body` base token ~line 22)
- Test: `app/routes/__tests__/storefront.render.test.ts` (existing render test)

- [ ] **Step 1: Write the failing test**

Add to the storefront render test:

```ts
it("renders data-type and data-density on the store root", () => {
  // settings mock: typeStyle:"editorial", density:"roomy"
  const html = renderStorefront({ typeStyle: "editorial", density: "roomy" });
  expect(html).toContain('data-type="editorial"');
  expect(html).toContain('data-density="roomy"');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts -t data-type`
Expected: FAIL — attributes absent.

- [ ] **Step 3a: Render the attributes**

In `storefront.tsx`, the `.cd-store` `<div>` (lines 57-62) — add two attributes (default to `classic`/`standard` for legacy rows lacking the fields):

```tsx
    <div
      className="cd-store"
      data-vibe={experimentVibe ?? settings.vibe}
      data-type={settings.typeStyle ?? "classic"}
      data-density={settings.density ?? "standard"}
      style={{ background: settings.palette.background, color: settings.palette.text }}
    >
```

- [ ] **Step 3b: Add a body-font token + the CSS packs**

In `storefront.css`, add a `--cd-font-body` token to the base `.cd-store` block (after `--cd-font-display`, line ~22) and apply it:

```css
  --cd-font-display: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --cd-font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Add `font-family: var(--cd-font-body);` to the `.cd-store` rule body (so body text uses the token). Then, **after the `[data-vibe="warm"]` pack (line ~92)** so they win the family cascade when set (both selectors are specificity 0,2,0; later source order wins), add:

```css
/* ---- typeStyle packs — classic intentionally omitted (defers to the vibe's font) ---- */
.cd-store[data-type="editorial"] {
  --cd-font-display: ui-serif, Georgia, "Times New Roman", serif;
  --cd-tracking-display: 0em;
}
.cd-store[data-type="rounded"] {
  --cd-font-display: ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
}

/* ---- density packs — standard intentionally omitted (base --cd-gap: 16px) ---- */
.cd-store[data-density="compact"] { --cd-gap: 12px; }
.cd-store[data-density="roomy"]   { --cd-gap: 24px; }
```

(`--cd-gap` is declared at `:root` (0,1,0); `.cd-store[data-density]` (0,2,0) overrides it. `classic`/`standard` have no selector, so they inherit the vibe font / base gap → zero regression.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/routes/__tests__/storefront.render.test.ts && npm run build`
Expected: render test PASS; `build` PASS incl. `verify:client-bundle` (no external fonts / source maps introduced — all font stacks are system).

- [ ] **Step 5: Commit**

```bash
git add app/routes/storefront.tsx app/styles/storefront.css app/routes/__tests__/storefront.render.test.ts
git commit -m "feat(storefront): [data-type]/[data-density] token packs (zero-regression defaults)"
```

---

### Task 10: Taste-audit eval (the real success criterion)

**Files:** none (verification task; record results in the PR description).

- [ ] **Step 1: Generate sample stores across briefs**

With the app running against a scratch shop, run storegen for ~5 briefs spanning the space: `"minimal, monochrome"`, `"bold and dramatic"`, `"warm and editorial"`, `"playful, rounded, roomy"`, and an empty brief (catalog-only). Capture the resulting `store_settings` (`vibe/paletteName/typeStyle/density`) and the rendered home for each.

- [ ] **Step 2: Score against the taste checklist (using the taste-skill's redesign-audit protocol)**

For each sample, apply `design-taste-frontend` v2's redesign-audit and score: (a) visual hierarchy present, (b) home composition varies from the others (not one template), (c) palette/type/density fit the brief, (d) no generic filler copy. Record pass/fail + notes.

- [ ] **Step 3: Iterate the prompt if the audit fails**

If ≥2 samples read generic or identical, tighten the Task-7 prompt language (more explicit hierarchy/variety guidance or few-shot contrast) and re-run Step 1-2. Success = a clear, defensible lift over the pre-change output.

- [ ] **Step 4: Full gate + finish**

Run: `npm run typecheck && npm run lint && npm run build && npx vitest run`
Expected: all green. Then open the PR (per the pre-commit gate); paste the eval results (Step 2) in the PR body as the taste evidence.

---

## Notes / decisions carried from the spec

- **Zero-regression is load-bearing:** never emit a `[data-type="classic"]` or `[data-density="standard"]` selector — their absence is what makes existing rows render unchanged. Do not "helpfully" add them.
- **System fonts only** — every `--cd-font-*` stack is a system/`ui-*` family; introducing an external font (`@font-face`/CDN) is out of scope and would trip `verify:client-bundle`/CSP.
- **Keep the three allow-lists in lockstep** (`block-plan.ts`, `settings.server.ts`, `prompts.ts`) with the DB CHECK constraint. Changing the vocabulary means editing all four.
- **No dashboard editing control** for typeStyle/density in this plan (storegen sets them; the studio DTO only *displays*). A `saveStudioTypeStyle` writer mirroring `saveStudioVibe` is a deliberate follow-up if merchants should hand-edit them.
