# Storefront Recipe Light Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship nine distinct, light, three-color ecommerce recipes with functional catalog and protected cart flows.

**Architecture:** Keep the existing recipe compiler, public-data bindings, prototype mirror, and trusted commerce slots. Change only recipe-owned design tokens, route HTML/CSS, and versioned visual artifacts.

**Tech Stack:** TypeScript, compiled recipe HTML/CSS, Vitest, Playwright screenshot verifier.

## Global Constraints

- Light primary surface for all nine recipes.
- At most three non-spacing design colors per recipe.
- Nine distinct local display fonts and hero/motion systems.
- No external font, image, script, or commerce dependency.
- Preserve every trusted commerce slot and live-data repeat.

---

### Task 1: Lock the visual and commerce contracts

**Files:**
- Modify: `app/lib/storefront-recipes/route-matrix.test.ts`
- Test: `app/lib/storefront-recipes/route-matrix.test.ts`

- [ ] Add assertions for light primary palettes, no more than three color tokens, unique display fonts, named hero/motion signatures, all routes, and protected slots.
- [ ] Run `npx vitest run app/lib/storefront-recipes/route-matrix.test.ts` and confirm the new visual assertions fail against the old recipes.

### Task 2: Redesign the nine recipe sources

**Files:**
- Modify: `app/lib/storefront-recipes/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}/bundle.ts`
- Modify: `docs/superpowers/prototypes/storefront-recipes/{volt,atelier,gilt,ember,roast,fizz,forge,haven,glow}.html`

- [ ] Assign the approved palettes and unique local display fonts.
- [ ] Implement the nine hero compositions and motion signatures in recipe-owned HTML/CSS.
- [ ] Apply each palette and typography system across collections, product, search, story, cart, checkout, and not-found surfaces.
- [ ] Preserve all repeat bindings, route targets, state actions, and trusted commerce slots.
- [ ] Run the nine bundle tests, route matrix, source parity, and interactive contract tests until green.
- [ ] Commit the recipe redesign.

### Task 3: Version and verify the redesign

**Files:**
- Modify: `app/lib/storefront-bundle/registry.ts`
- Modify: `app/lib/storefront-validation/screenshot-manifest.json`
- Create: `public/storefront-recipes/<recipe>/baselines/v3-*.webp`
- Modify: `public/template-previews/<recipe>.webp`

- [ ] Increment all nine recipe versions to 3 and register the new immutable versions.
- [ ] Capture all route/device visual baselines with `node scripts/verify-storefront-bundles.mjs --filter=<recipe> --update-baselines`.
- [ ] Re-run each filter without baseline updates and confirm all cases pass.
- [ ] Run focused tests, `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`.
- [ ] Commit, push PR #619, and verify the Vercel branch deployment.
