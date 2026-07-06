# Design: taste-skill v2 + storegen taste levers

**Date:** 2026-07-06
**Status:** Approved (brainstorming) — ready for implementation plan
**Surfaces:** agent tooling (Claude Code skill) + product (`app/lib/storegen`, `app/lib/storebuilder`, storefront render)

## Goal

Raise the design quality ("taste") of everything we generate, on two surfaces at once:

1. **Agent tooling** — install Leonxlnx's `design-taste-frontend` (taste-skill **v2**) so the design/UI/generation work Claude does is taste-guided, not generic.
2. **Product runtime** — improve the merchant-facing store generator (`storegen`) so generated storefronts look less generic, by (a) encoding taste principles into its prompts and (b) adding two new visual levers the current vocabulary lacks.

**Non-goal / dropped:** Figma integration (no populated Figma design system exists — cut entirely). Hosted web-fonts, motion/GSAP in the storefront (deferred; see Simplifications).

## Background (current state)

- Storegen brand stage (`app/lib/storegen/prompts.ts` → `BRAND_SYSTEM_PROMPT`) emits `{storeName, paletteName, vibe, voiceTagline}`.
  - `paletteName` ∈ curated `PALETTE_LIBRARY` (model picks a name; `parseBrandPlan` in `block-plan.ts` resolves/snaps hallucinated hex to the nearest curated palette).
  - `vibe` ∈ `"minimal" | "bold" | "warm"` (`StudioVibe`), rendered as a `[data-vibe]` CSS token pack on the `.cd-store` root (`app/styles/storefront.css`, `app/routes/storefront.tsx`).
- Page stage (`docSystemPrompt`) composes blocks (hero, richText, image, button, productGrid, collectionList, …) on a 12-col grid, with copy rules and a single canonical home few-shot.
- **Typography:** system-ui globally — no lever. **Density/spacing:** implicit inside the vibe packs — no explicit lever.
- Existing agent design skill: `emil-design-eng` (installed via `skills-lock.json`).

## Design

### 1. Agent tooling (foundation)

- `npx skills add Leonxlnx/taste-skill`; pin **v2** (`design-taste-frontend`) — recorded in `skills-lock.json` like `emil-design-eng`.
- Add one rule to the repo `CLAUDE.md` design conventions: when generating or restyling dashboard/storefront UI, apply taste-skill v2; it **composes** with `emil-design-eng` (taste-skill = primary "avoid generic," emil = complementary). Keep both installed.
- **v2 is experimental:** if it misbehaves, fall back to `design-taste-frontend-v1` (documented in the CLAUDE.md rule).

### 2. Storegen prompt taste (no schema change)

Rework `BRAND_SYSTEM_PROMPT` and `docSystemPrompt` — authored by Claude under taste-skill v2 guidance — within the existing vocabulary:

- **Layout-rhythm variety:** the home few-shot (`HOME_FEWSHOT`) currently teaches one canonical 6-block layout, so every store comes out the same shape. Replace the single example with variety guidance (and/or 2–3 contrasting shapes) so composition varies with the brief/catalog.
- **Hierarchy & restraint:** stronger guidance on visual and information hierarchy, and not over-stuffing pages.
- Keep the existing untrusted-input framing, JSON-only contract, and copy rules intact.

### 3. Two new levers

Both mirror the `vibe`/`palette` pattern exactly: a **curated name** the model picks from an embedded menu, validated by `parseBrandPlan`, rendered as a `[data-*]` token pack on `.cd-store`. No free-form values reach render.

**Lever A — `typeStyle` (typography):**
- New curated `TYPE_LIBRARY` of **font pairings** (heading + body), ~3–4 named options with distinct intent, e.g.:
  - `Editorial` — serif heading + sans body
  - `Modern` — grotesk/sans throughout
  - `Warm` — rounded heading + sans body
- **System-font stacks only** (`ui-serif`, `ui-sans-serif`, `ui-rounded`, `ui-monospace`, with concrete fallbacks) — **no external font loading**, to stay within the CSP/browser-hygiene rules (no CDN, no `sourceMappingURL`, no external requests from the storefront bundle).
- Rendered via a `[data-type]` pack on `.cd-store` setting the storefront font-family custom properties.

**Lever B — `density`:**
- `density` ∈ `"compact" | "standard" | "roomy"`.
- Rendered via a `[data-density]` pack on `.cd-store` that sets the storefront spacing scale (section padding, block gaps, line-height). Complements, does not replace, vibe.

### 4. Data flow

```
brand LLM call
  → { storeName, paletteName, vibe, typeStyle, density, voiceTagline }
  → parseBrandPlan (block-plan.ts): validate typeStyle ∈ TYPE_LIBRARY names,
      density ∈ {compact,standard,roomy}; fall back to defaults on miss
      (mirrors the vibe/palette validation + snapping)
  → store_settings (2 new columns) via studio.server / settings.server
  → storefront render: <root class="cd-store" data-vibe data-type data-density>
      + palette CSS vars
```

- `fallback.ts` (soft-degraded generation) sets defaults for the new fields so a fallback store still renders coherently.
- `StudioSettings` (`studio-types.ts`) gains `typeStyle` + `density`; `sanitize.ts`/`guard.server.ts` validate/clamp server-side.

### 5. Schema / migration

- `store_settings`: add `type_style text` and `density text`, each **NOT NULL DEFAULT** + **CHECK constraint** on the allowed values — mirroring the existing `vibe` check-constraint column.
- SQL migration checked in and applied to prod via the supabase MCP/CLI. RLS already enabled on the table (no change).
- `npx prisma validate` if any Prisma schema is touched (product data is Supabase, so likely just the SQL migration + regenerated types).

### 6. Testing / eval

- **Unit:** `block-plan` parse/validate for `typeStyle` + `density` (valid → passthrough; invalid/missing → default); `prompts.test.ts` asserts the new curated menus are embedded and the JSON shape updated; migration `validate`.
- **Render:** storefront render test asserts `[data-type]`/`[data-density]` attributes are emitted and legacy rows (missing columns → defaults) still render.
- **Eval (the real success criterion):** generate N sample stores across a spread of briefs (colorful, minimal, bold, warm, empty-brief) and score them against a **taste checklist** (hierarchy, layout variety, palette/type/density fit, no generic filler) using taste-skill v2's redesign-audit protocol. Output looking less generic is the goal — green unit tests alone are not sufficient (contract rule 9).

## Success criteria

1. taste-skill v2 installed + pinned; CLAUDE.md rule in place; composes with emil-design-eng.
2. Storegen prompts encode taste principles; home composition visibly varies across briefs (no single canonical shape).
3. `typeStyle` + `density` flow end-to-end: model → parse/validate → store_settings → storefront render, with defaults + fallback covered.
4. Sample-store taste audit shows a clear quality lift over current output.
5. Pre-commit gate green (typecheck, lint, build + client-bundle hygiene, tests, migration validate).

## Risks / simplifications (deliberate)

- **System fonts, not hosted webfonts** — CSP-safe and zero-dependency; a hosted-font decision (self-hosted under our origin) is a later, separate change if brand fonts are wanted.
- **No motion/GSAP** in the storefront — bigger render work, out of the "1–2 lever" scope.
- **v2 experimental** — `-v1` fallback documented.
- **Curated-only values** — the model never emits raw fonts/spacing; everything snaps to a curated name, same safety property as palettes today.

## Process

- Implement in an isolated worktree/branch `feat/storegen-taste` (feature-isolation rule).
- Ships via the standard pre-commit gate; auto-commit only after the gate is green.
