# Storefront design doctrine: craft rules for the studio designer (storegen)

Date: 2026-07-20
Branch: `feat/storegen-design-doctrine` (based on `codex/storefront-generation-quality`, where both generation stacks live)

**Scope decision (owner call, 2026-07-20): wire the doctrine into the secret designer only for now.** The `storefront-ai` wiring described below is designed but deferred; the doctrine module is written so the main builder can adopt it later without rework.

## Addendum: port to main's designer engine (this branch)

The sections below were designed against the `codex/storefront-generation-quality` branch, whose `storegen` prompt pipeline never landed on `main`. Production deploys from `origin/main`, where the secret designer is the conversational edit engine in `app/lib/designer/` (template pick or scratch seed -> per-page build turns -> launch-readiness review pass), whose `SYSTEM_PROMPT` already carries one-accent/contrast/DTC-conversion/AI-tell rules and whose art directions are committed per store in `direction.server.ts`.

This branch therefore ports only the doctrine blocks that engine was missing, as `app/lib/designer/doctrine.ts`:

- `CRAFT_RULES` (into `SYSTEM_PROMPT`, so both first-build and edit turns obey it): store-wide radius/shadow/motion commitment, hierarchy first/second/third read + 5-second test, repeat-then-break rhythm on the 8px scale, full interaction-state spec (hover/active/:focus-visible, 0.15-0.3s transitions, prefers-reduced-motion), accessibility floors (3:1 large text and controls, one h1 and no skipped levels, specific alt text, 44px targets, no color-only state). The old shorter "hover and focus states" clause is removed in favor of this block.
- `REVIEW_CRAFT_CHECKS` (into `REVIEW_PROMPT`, replacing its two weaker clauses): contrast floors against the actual background, missing hover/active/focus-visible, pure #FFFFFF-on-#000000, heading-structure defects, mixed radius/shadow regimes.

The judge/candidate-variety parts of the original design have no analog in this engine (it reviews per page rather than ranking candidates) and are represented by the review checks. The original storegen wiring remains on `feat/storegen-design-doctrine` for whenever that pipeline lands.

## Goal

Raise the design quality of generated storefronts by integrating the distilled doctrine from the public Claude Design system-prompt research (design identity, anti-generic defaults, hierarchy and rhythm rules, interaction states, accessibility floors, slop detection, designed variation) into the store builder's generation and judging prompts. The point is not to paste a 36KB prompt into every call; it is to distill the doctrine into dense, checkable rule blocks and wire them into the exact seams where they change output quality.

## Context

There are two generation stacks, both live:

- **storegen** (studio designer, `app/lib/storegen/`): brand plan -> full self-contained HTML home page (plus block-plan collection/PDP), N candidates -> judge -> optional critique-driven revision.
- **storefront-ai** (runtime-1 pipeline, `app/lib/storefront-ai/`): 3 concept strategies -> screenshot-based judge -> expansion to all routes -> browser proof/repair. Its `COMPILER_SYSTEM_PROMPT` is a strict closed-DSL contract that must not be diluted.

Both already carry some taste rules (no em-dashes, no eyebrow labels, anti-slop judge lines, curated palettes/fonts). What the doctrine adds that is genuinely missing:

1. **Design-system commitment**: one radius scale, one shadow regime, one motion mode, one accent rule, applied consistently page-wide.
2. **Hierarchy and rhythm as concrete rules**: layered hierarchy signals, one primary CTA, the 5-second test, a 4/8px spacing scale, one type scale, repeat-then-break section rhythm.
3. **Interaction states**: default/hover/active/focus-visible + 0.15-0.3s transitions + `prefers-reduced-motion` (absent from storegen prompts entirely).
4. **Accessibility floors**: contrast ratios, heading hierarchy, alt-text specificity, hit targets, no color-only state.
5. **Sharper judging**: a concrete slop-detection checklist plus severity-ordered critique (blockers -> quality -> polish) so the revision loop fixes the right things.
6. **Designed variation**: candidate angles specified concretely (named hero paradigms, different regimes) instead of "take a different angle".

## Design

### New module: `app/lib/storegen/doctrine.ts`

Pure string constants (no runtime deps), each a dense rule block:

- `DESIGN_COMMIT_RULES` - commit to one design system (radius/shadow/motion/accent) page-wide.
- `HIERARCHY_RULES` - first/second/third read, layered signals, one primary CTA, 5-second test.
- `RHYTHM_RULES` - spacing scale, type scale, repeat-then-break.
- `SURFACE_RULES` - palette-derived tints only, toned whites/blacks, on-tone gradients.
- `INTERACTION_RULES` - full state set, transition timing, focus-visible, reduced motion.
- `ACCESSIBILITY_RULES` - contrast floors, heading hierarchy, alt text, hit targets.
- `NO_FILLER_RULES` - every element earns its place; no invented stats/testimonials; space over padding.
- `SLOP_RUBRIC` - judge-facing detection list of template-default tells.
- `CRITIQUE_TRIAGE` - severity-ordered critique framing for revision loops.

Single source of truth; today only `storegen` imports it, and the main builder can import the same blocks later so the doctrine never forks.

### storegen wiring (`app/lib/storegen/prompts.ts`)

- `HOME_HTML_SYSTEM_PROMPT`: new CRAFT block (commit + hierarchy + rhythm + surfaces + interaction + accessibility + no-filler).
- `SECTION_SYSTEM_PROMPT`: consistency-with-committed-system line + interaction + accessibility (revised sections must still belong to the page).
- `docSystemPrompt`: no-filler rules (block pages control composition and copy only; the registry owns CSS).
- `BRAND_SYSTEM_PROMPT`: one line requiring the palette/vibe/typeStyle combination to be chosen with intent for this catalog, not a safe default.
- `HOME_JUDGE_SYSTEM_PROMPT`: slop rubric + concrete craft checks + severity-ordered critique.
- `candidateAngleNudge`: angle 1 upgraded to a concretely specified bolder take (named hero paradigms, different regime, different section order).

### storefront-ai wiring (DEFERRED, not in this change)

When the main builder adopts the doctrine later: `conceptPrompt` gets the craft block minus interaction rules (concepts are static previews and the judge is instructed not to deduct for missing states); `expansionPrompt` gets interaction + accessibility rules; `judgePrompt` gets the craft bar and slop rubric; `COMPILER_SYSTEM_PROMPT` and repair prompts stay unchanged; `STOREFRONT_AI_PROMPT_VERSION` bumps to 2 with `GenerationAudit.promptContractVersion` widened to `number`.

### Explicitly out of scope

- No changes to sanitizers, verifiers, judges' JSON contracts, budgets, or thresholds.
- No new model calls; token cost per call grows by roughly 600-900 tokens of system-prompt text, well inside existing budgets.
- The interactive skills from the source repo (decks, wireframes, tweak panels, discovery questions) do not apply to a headless pipeline and are not ported.

## Approaches considered

1. **Shared doctrine module wired into both stacks (chosen)** - one source of truth, additive edits, no contract changes.
2. Per-stack inline edits - faster but duplicates the doctrine and drifts.
3. Install the repo as dev-time agent skills - wrong layer; the ask is product runtime quality, not authoring-time assistance.

## Testing

- Existing prompt tests are containment assertions; all edits are additive.
- New tests: doctrine blocks are non-empty and em-dash-free; storegen home + judge prompts contain the craft and slop blocks; the section prompt keeps the committed system; candidate angle 1 names concrete hero paradigms.
- Gate: `npm run typecheck`, `npm run lint`, `npm run build`, `npx vitest run` for the storegen prompt tests.
