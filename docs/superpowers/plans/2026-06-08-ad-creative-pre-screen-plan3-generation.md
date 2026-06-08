# Ad Creative Pre-Screen — Plan 3: Anti-slop copy generation

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** From a screened ad, generate improved **copy** variations through an anti-slop loop — every variant is re-scored by the same scorer and only variants that **beat the original** surface, ranked best-first with their new score and a rationale.

**Architecture:** A `CreativeGenerator` adapter interface (modes copy/image/video) with a native-Claude **copy** generator implemented now; a deterministic **re-score gate** (`generateImprovements`) that scores each candidate via the Plan-1 scorer+calibrator and discards regressions. The run persists the screened `CreativeInput` (so generation can work from a saved run) and the resulting `variants`. The route gets a "Generate improvements" action + a ranked variants section.

**Tech Stack:** Remix + TS strict, Polaris, Anthropic SDK (forced tool use), Supabase, Vitest.

**Builds on:** Plans 1+2 (merged to main). Branch `plan3-generation` (worktree off main).

---

## Scope

- IN: `CreativeGenerator` interface + copy generator (native Claude), re-score gate (judge-don't-trust), persist `creative_input` + `variants`, ranked variants UI.
- OUT (later): image/video generators (Plan 4 — provider-gated; the adapter interface here makes them drop-in), and **pushing a variant to Meta as a paused draft** (a real Meta write — deferred to its own increment; for now variants are shown for the merchant to copy/apply).

**Anti-slop guarantees encoded:** generation is conditioned on the concrete weak dimensions + tips (not "make it better"), grounded in the merchant's top ad names as style refs, and **every variant is re-scored**; anything that doesn't beat the original composite is discarded (counted, not shown).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260608120000_creative_screen_variants.sql` (+ test mirror) | add `creative_input` + `variants` jsonb columns to `creative_screen_run` + refresh view |
| `app/lib/screener/types.ts` | + `GenerationMode`, `GeneratedCandidate`, `Variant`; extend `CreativeScreenRun` with `creativeInput` + `variants` |
| `app/lib/screener/runs.server.ts` | persist `creative_input` (in `completeRun`), `saveVariants`, map both in `rowToRun` |
| `app/lib/screener/orchestrate.server.ts` | pass the screened `input` into `completeRun` |
| `app/lib/screener/generate.server.ts` | `CreativeGenerator` + `copyGenerator` + `generateImprovements` re-score gate |
| `app/routes/app.screener.tsx` | "Generate improvements" action + variants UI |
| `app/lib/screener/__tests__/*` | tests per unit |

---

## Task 1: Migration — persist input + variants

**Files:**
- Create: `supabase/migrations/20260608120000_creative_screen_variants.sql`
- Create: `tests/engine/schema/migrations/20260608120000_creative_screen_variants.sql`

- [ ] **Step 1:** Create `supabase/migrations/20260608120000_creative_screen_variants.sql`:

```sql
-- Persist the screened creative input (so generation can run from a saved run)
-- and the generated, re-scored variants (only winners that beat the original).
alter table creative_screen_run add column creative_input jsonb;
alter table creative_screen_run add column variants jsonb not null default '[]'::jsonb;

-- Refresh the read view to expose the new columns.
drop view if exists v_creative_screen_runs;
create view v_creative_screen_runs as
  select id, shop_id, status, source, meta_ad_id, mapped_sku_id,
         assumed_spend_cents, scorecard, creative_input, variants, error,
         created_at, completed_at
  from creative_screen_run;
```

- [ ] **Step 2:** Copy the identical content to `tests/engine/schema/migrations/20260608120000_creative_screen_variants.sql`.

- [ ] **Step 3:** Eyeball the SQL (balanced, semicolons). No prisma.

- [ ] **Step 4: Commit**
```bash
cd /Users/ericchen/Developer/shopify-app-plan3 && git add supabase/migrations/20260608120000_creative_screen_variants.sql tests/engine/schema/migrations/20260608120000_creative_screen_variants.sql && git commit -m "screener: persist creative_input + variants on creative_screen_run"
```

---

## Task 2: Types + persistence

**Files:**
- Modify: `app/lib/screener/types.ts`
- Modify: `app/lib/screener/runs.server.ts`
- Modify: `app/lib/screener/orchestrate.server.ts`
- Modify: `app/lib/screener/__tests__/runs.test.ts`

- [ ] **Step 1: Add types.** Append to `app/lib/screener/types.ts`:

```ts

export type GenerationMode = "copy" | "image" | "video";

/** A generator's raw output: a regenerated creative + why it addresses the flaws. */
export interface GeneratedCandidate {
  input: CreativeInput;
  rationale: string;
}

/** A re-scored candidate that beat the original. */
export interface Variant {
  mode: GenerationMode;
  input: CreativeInput;
  rationale: string;
  composite: number;
  delta: number; // composite - original composite
  summary: string;
}
```

And extend the `CreativeScreenRun` interface (add two fields before the closing brace):
```ts
  creativeInput: CreativeInput | null;
  variants: Variant[];
```

- [ ] **Step 2: Update the failing test** for `rowToRun`. In `app/lib/screener/__tests__/runs.test.ts`, extend the first test's input row with `creative_input` + `variants` and assert mapping. Add inside the first `it(...)` after the existing asserts:
```ts
    // (extend the row passed to rowToRun in this test with:)
    //   creative_input: { headline: "h" }, variants: [{ mode: "copy", composite: 80 }],
    // then:
    expect(dto.creativeInput).toEqual({ headline: "h" });
    expect(dto.variants).toEqual([{ mode: "copy", composite: 80 }]);
```
Concretely, change the `rowToRun({...})` argument in that test to include `creative_input: { headline: "h" }, variants: [{ mode: "copy", composite: 80 }],` and add the two `expect` lines above. Also in the "defaults missing optionals" test add:
```ts
    expect(dto.creativeInput).toBeNull();
    expect(dto.variants).toEqual([]);
```

- [ ] **Step 3: Run** `cd /Users/ericchen/Developer/shopify-app-plan3 && npx vitest run app/lib/screener/__tests__/runs.test.ts` — expect FAIL.

- [ ] **Step 4: Implement persistence.** In `app/lib/screener/runs.server.ts`:

(a) Add to the imports: `CreativeInput`, `Variant`:
```ts
import type { CreativeInput, CreativeScreenRun, RunSource, RunStatus, ScoreCard, Variant } from "./types";
```
(b) In `rowToRun`, add the two fields to the returned object:
```ts
    creativeInput: (r.creative_input as CreativeInput | null) ?? null,
    variants: (r.variants as Variant[] | null) ?? [],
```
(c) Change `completeRun` to also persist the input:
```ts
export async function completeRun(id: string, scorecard: ScoreCard, creativeInput: CreativeInput): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ status: "done", scorecard, creative_input: creativeInput, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}
```
(d) Add `saveVariants`:
```ts
export async function saveVariants(id: string, variants: Variant[]): Promise<CreativeScreenRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("creative_screen_run")
    .update({ variants })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}
```

- [ ] **Step 5: Update the orchestrator call.** In `app/lib/screener/orchestrate.server.ts`, the `ScreenDeps.completeRun` type and the call must pass the input:
(a) change the `completeRun` member type to:
```ts
  completeRun: (id: string, scorecard: ScoreCard, creativeInput: CreativeInput) => Promise<CreativeScreenRun>;
```
(b) change the call `return await deps.completeRun(run.id, scorecard);` to:
```ts
    return await deps.completeRun(run.id, scorecard, args.input);
```
(c) In `app/lib/screener/__tests__/orchestrate.test.ts`, the fake `completeRun` signatures already ignore extra args (they're `async (_id, scorecard) => ...`), which still satisfies the wider type (fewer params is assignable). No test change required; run them to confirm.

- [ ] **Step 6: Run** `npx vitest run app/lib/screener/__tests__/runs.test.ts app/lib/screener/__tests__/orchestrate.test.ts` — expect PASS. `npx tsc --noEmit` exit 0.

- [ ] **Step 7: Commit**
```bash
cd /Users/ericchen/Developer/shopify-app-plan3 && git add app/lib/screener/types.ts app/lib/screener/runs.server.ts app/lib/screener/orchestrate.server.ts app/lib/screener/__tests__/runs.test.ts && git commit -m "screener: persist creative_input + variants; saveVariants helper"
```

---

## Task 3: Generator + re-score gate — `generate.server.ts`

The centerpiece. Pure-ish gate (DI) + a native-Claude copy generator.

**Files:**
- Create: `app/lib/screener/generate.server.ts`
- Test: `app/lib/screener/__tests__/generate.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `app/lib/screener/__tests__/generate.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateImprovements, copyGenerator, GENERATE_TOOL_NAME, type GateDeps } from "../generate.server";
import { DIMENSIONS, type CreativeInput, type ScoreCard, type GeneratedCandidate } from "../types";

const original: CreativeInput = {
  imageUrl: null, headline: "Introducing our serum", primaryText: "Buy now.",
  cta: "SHOP_NOW", destinationUrl: "https://x.test/p", audience: "women 25-44",
};

function scorecard(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "ok",
    metrics: DIMENSIONS.map((d, i) => ({ id: d.id, group: d.group, label: d.label, score: i < 3 ? 40 : 70, reasoning: "r" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1.5, roasHigh: 2.6, breakEvenRoas: 1.9, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000, mappedSku: null, skuPriceCents: null,
    },
    tips: ["front-load the offer"],
  };
}

const cand = (headline: string): GeneratedCandidate => ({
  input: { ...original, headline }, rationale: `addresses hook via ${headline}`,
});

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    generator: {
      mode: "copy",
      available: () => true,
      generate: async () => [cand("A"), cand("B"), cand("C")],
    },
    // A re-scores to 80 (win), B to 50 (regression vs 64), C to 90 (win)
    scoreOne: async (input) => {
      const map: Record<string, number> = { A: 80, B: 50, C: 90 };
      return { composite: map[input.headline] ?? 0, summary: `s:${input.headline}`, metrics: [] };
    },
    ...over,
  };
}

describe("generateImprovements (re-score gate)", () => {
  it("keeps only variants that beat the original, ranked best-first", async () => {
    const out = await generateImprovements({ original, originalScorecard: scorecard(64), count: 3 }, gateDeps());
    expect(out.available).toBe(true);
    expect(out.generated).toBe(3);
    expect(out.discarded).toBe(1); // B (50) dropped
    expect(out.variants.map((v) => v.input.headline)).toEqual(["C", "A"]); // 90 then 80
    expect(out.variants[0].delta).toBe(26); // 90 - 64
    expect(out.variants[0].rationale).toContain("C");
  });

  it("short-circuits when the generator is unavailable", async () => {
    const out = await generateImprovements(
      { original, originalScorecard: scorecard(64) },
      gateDeps({ generator: { mode: "image", available: () => false, generate: async () => [] } }),
    );
    expect(out.available).toBe(false);
    expect(out.variants).toEqual([]);
    expect(out.generated).toBe(0);
  });

  it("returns no winners when nothing beats the original", async () => {
    const out = await generateImprovements(
      { original, originalScorecard: scorecard(95) },
      gateDeps(),
    );
    expect(out.variants).toEqual([]);
    expect(out.discarded).toBe(3);
  });
});

describe("copyGenerator", () => {
  it("calls the forced tool and returns candidates", async () => {
    const gen = copyGenerator({
      createMessage: async () => ({
        content: [{ type: "tool_use", name: GENERATE_TOOL_NAME, input: {
          variants: [
            { headline: "New hook", primaryText: "Tight body.", cta: "SHOP_NOW", rationale: "fixes hook" },
          ],
        } }],
      }) as never,
      model: "m",
    });
    const out = await gen.generate({ input: original, weakMetrics: [], tips: [], styleRefs: [], count: 1 });
    expect(gen.mode).toBe("copy");
    expect(gen.available()).toBe(true);
    expect(out[0].input.headline).toBe("New hook");
    expect(out[0].input.destinationUrl).toBe(original.destinationUrl); // copy-only: image/url/audience preserved
    expect(out[0].rationale).toBe("fixes hook");
  });
});
```

- [ ] **Step 2: Run** `cd /Users/ericchen/Developer/shopify-app-plan3 && npx vitest run app/lib/screener/__tests__/generate.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.** Create `app/lib/screener/generate.server.ts`:

```ts
// app/lib/screener/generate.server.ts
// Anti-slop generation: a CreativeGenerator produces candidate creatives from the
// scored flaws; the re-score gate judges every candidate with the SAME scorer and
// keeps only those that beat the original. Generation is never trusted blindly.
import type Anthropic from "@anthropic-ai/sdk";
import type {
  CreativeInput, GeneratedCandidate, GenerationMode, MetricScore, ScoreCard, Variant,
} from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

export interface GenerateRequest {
  input: CreativeInput;
  weakMetrics: { label: string; score: number; reasoning: string }[];
  tips: string[];
  styleRefs: string[];
  count: number;
}

export interface CreativeGenerator {
  mode: GenerationMode;
  available(): boolean;
  generate(req: GenerateRequest): Promise<GeneratedCandidate[]>;
}

export interface GateDeps {
  generator: CreativeGenerator;
  /** Re-score a candidate creative; returns its calibrated composite. */
  scoreOne: (input: CreativeInput) => Promise<{ composite: number; summary: string; metrics: MetricScore[] }>;
}

export async function generateImprovements(
  args: { original: CreativeInput; originalScorecard: ScoreCard; count?: number },
  deps: GateDeps,
): Promise<{ variants: Variant[]; generated: number; discarded: number; available: boolean }> {
  if (!deps.generator.available()) {
    return { variants: [], generated: 0, discarded: 0, available: false };
  }
  const weakMetrics = args.originalScorecard.metrics
    .filter((m) => m.score < 65)
    .sort((a, b) => a.score - b.score)
    .map((m) => ({ label: m.label, score: m.score, reasoning: m.reasoning }));

  const candidates = await deps.generator.generate({
    input: args.original,
    weakMetrics,
    tips: args.originalScorecard.tips,
    styleRefs: [],
    count: args.count ?? 3,
  });

  const baseline = args.originalScorecard.composite;
  const scored: Variant[] = await Promise.all(
    candidates.map(async (c) => {
      const s = await deps.scoreOne(c.input);
      return {
        mode: deps.generator.mode,
        input: c.input,
        rationale: c.rationale,
        composite: s.composite,
        delta: s.composite - baseline,
        summary: s.summary,
      };
    }),
  );

  const winners = scored
    .filter((v) => v.composite > baseline)
    .sort((a, b) => b.composite - a.composite);

  return {
    variants: winners,
    generated: scored.length,
    discarded: scored.length - winners.length,
    available: true,
  };
}

// ---- native-Claude copy generator ----

export const GENERATE_TOOL_NAME = "report_copy_variants";
const MAX_TOKENS = 2048;

const COPY_TOOL: Anthropic.Tool = {
  name: GENERATE_TOOL_NAME,
  description: "Return improved ad COPY variants (headline, primary text, CTA) that fix the named flaws.",
  input_schema: {
    type: "object",
    properties: {
      variants: {
        type: "array",
        description: "2-4 distinct improved copy variants.",
        items: {
          type: "object",
          properties: {
            headline: { type: "string" },
            primaryText: { type: "string" },
            cta: { type: "string" },
            rationale: { type: "string", description: "Which flaw this fixes and how." },
          },
          required: ["headline", "primaryText", "cta", "rationale"],
        },
      },
    },
    required: ["variants"],
  },
};

function buildPrompt(req: GenerateRequest): string {
  const weak = req.weakMetrics.length
    ? req.weakMetrics.map((m) => `- ${m.label} (${m.score}/100): ${m.reasoning}`).join("\n")
    : "- (no specific weak dimensions flagged)";
  const refs = req.styleRefs.length ? `\nMatch the style of the merchant's winning ads: ${req.styleRefs.join(", ")}.` : "";
  return [
    "Rewrite ONLY the copy (headline, primary text, CTA) of this ad to fix its weakest dimensions.",
    "Keep the same product, offer, image and destination — do NOT invent new claims or products.",
    `\nCurrent headline: ${req.input.headline}`,
    `Current primary text: ${req.input.primaryText}`,
    `Current CTA: ${req.input.cta}`,
    `Audience: ${req.input.audience}`,
    `\nWeakest dimensions to fix:\n${weak}`,
    req.tips.length ? `\nApply these fixes: ${req.tips.join("; ")}` : "",
    refs,
    `\nReturn ${req.count} distinct variants via the ${GENERATE_TOOL_NAME} tool.`,
  ].join("\n");
}

export function copyGenerator(opts: { createMessage: CreateMessageFn; model: string }): CreativeGenerator {
  return {
    mode: "copy",
    available: () => true,
    async generate(req) {
      const res = await opts.createMessage({
        model: opts.model,
        max_tokens: MAX_TOKENS,
        tools: [COPY_TOOL],
        tool_choice: { type: "tool", name: GENERATE_TOOL_NAME },
        messages: [{ role: "user", content: buildPrompt(req) }],
      });
      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === GENERATE_TOOL_NAME,
      );
      if (!toolUse) throw new Error("Copy generator did not return the tool call");
      const out = (toolUse.input as { variants?: unknown }).variants;
      const raw = Array.isArray(out) ? out : [];
      return raw.map((v): GeneratedCandidate => {
        const r = (v ?? {}) as Record<string, unknown>;
        return {
          input: {
            ...req.input, // copy-only: preserve image, destination, audience
            headline: typeof r.headline === "string" ? r.headline : req.input.headline,
            primaryText: typeof r.primaryText === "string" ? r.primaryText : req.input.primaryText,
            cta: typeof r.cta === "string" ? r.cta : req.input.cta,
          },
          rationale: typeof r.rationale === "string" ? r.rationale : "",
        };
      });
    },
  };
}
```

- [ ] **Step 4: Run** `npx vitest run app/lib/screener/__tests__/generate.test.ts` — expect PASS. `npx tsc --noEmit` exit 0.

- [ ] **Step 5: Commit**
```bash
cd /Users/ericchen/Developer/shopify-app-plan3 && git add app/lib/screener/generate.server.ts app/lib/screener/__tests__/generate.test.ts && git commit -m "screener: CreativeGenerator + copy generator + re-score gate"
```

---

## Task 4: Route — "Generate improvements" action + variants UI

**Files:**
- Modify: `app/routes/app.screener.tsx`

- [ ] **Step 1:** Read the current `app/routes/app.screener.tsx` fully to understand structure (loader, action with manual/meta branches, `Screener` component, the results section that renders `card`).

- [ ] **Step 2: Add the generate wiring.**

(a) Imports — add:
```ts
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import { copyGenerator, generateImprovements } from "~/lib/screener/generate.server";
import { getLatestRun, listRuns, saveVariants } from "~/lib/screener/runs.server";
import { loadCalibrationInputs } from "~/lib/screener/history.server";
import { scoreCreative } from "~/lib/screener/score.server";
import { calibrate } from "~/lib/screener/calibrate.server";
```
(Adjust the existing `runs.server` import to add `saveVariants` rather than duplicating; remove any now-duplicate import lines so lint's `import/no-duplicates` stays happy — one import statement per module.)

Add `Variant` to the `~/lib/screener/types` import list.

(b) In the `action`, add a generate branch at the TOP (after reading `form`), before the meta/manual screen branches:
```ts
  if (String(form.get("intent") ?? "") === "generate") {
    const latest = await getLatestRun(session.shop);
    if (!latest || latest.status !== "done" || !latest.scorecard || !latest.creativeInput) {
      return json({ generateError: "Screen an ad first, then generate improvements." });
    }
    const original = latest.creativeInput;
    const calib = await loadCalibrationInputs(session.shop, null);
    const createMessage = (p: Parameters<typeof scoreCreative>[2]["createMessage"] extends infer T ? T : never) => getAnthropic().messages.create(p as never);
    const scoreOne = async (input: typeof original) => {
      const scored = await scoreCreative(input, calib.topAdNames, { createMessage: (p) => getAnthropic().messages.create(p), model: assistantModel() });
      const { composite } = calibrate(scored.metrics, calib, latest.assumedSpendCents);
      return { composite, summary: scored.summary, metrics: scored.metrics };
    };
    const gen = copyGenerator({ createMessage: (p) => getAnthropic().messages.create(p), model: assistantModel() });
    const result = await generateImprovements({ original, originalScorecard: latest.scorecard }, { generator: gen, scoreOne });
    const saved = await saveVariants(latest.id, result.variants);
    return json({ ...saved, generated: result.generated, discarded: result.discarded });
  }
```
(Simplify the `createMessage` typing — the inline `(p) => getAnthropic().messages.create(p)` is what `scoreCreative`/`copyGenerator` expect; drop the awkward `createMessage` const above if tsc is happy with the inline closures. Keep it clean, no `any` beyond what the SDK closure needs — match how `orchestrate.server.ts` wires `createMessage`.)

(c) Extend the loader's payload type isn't needed (variants come back on the run DTO). The `card`/run already flows through `fetcher.data ?? latest`.

(d) UI — after the existing tips card (inside the `card &&` block), add a variants section. Read `run.variants` (the run DTO now carries `variants`):
```tsx
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">Improved variations</Text>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="generate" />
                    <Button submit loading={running} disabled={running}>Generate improvements</Button>
                  </fetcher.Form>
                </InlineStack>
                {run.variants.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Generate copy variations that beat this ad. Only variants that out-score the original are shown.
                  </Text>
                ) : (
                  run.variants.map((v, i) => (
                    <Box key={i} padding="300" borderColor="border" borderBlockStartWidth="025">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">{v.input.headline}</Text>
                        <Badge tone="success">{`${v.composite} (+${v.delta})`}</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm">{v.input.primaryText}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">CTA: {v.input.cta} · {v.rationale}</Text>
                    </Box>
                  ))
                )}
              </BlockStack>
            </Card>
```

- [ ] **Step 3: Verify** `cd /Users/ericchen/Developer/shopify-app-plan3 && npx tsc --noEmit` (exit 0) and `npm run lint` (exit 0, no `import/no-duplicates`). Fix any Polaris prop names against `app/routes/app.simulator.tsx`. No `any`/`@ts-ignore`.

- [ ] **Step 4: Commit**
```bash
cd /Users/ericchen/Developer/shopify-app-plan3 && git add app/routes/app.screener.tsx && git commit -m "routes/app.screener: generate improved copy variations (re-score gated)"
```

---

## Task 5: Full gate + merge

- [ ] **Step 1:** Run from the worktree, paste each:
```bash
cd /Users/ericchen/Developer/shopify-app-plan3
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```
All exit 0.

- [ ] **Step 2 (controller):** Final review, then merge `plan3-generation` → main (in the worktree: `git checkout main && git merge --no-ff plan3-generation`), verify the merged main gate, remove the worktree.

---

## Self-Review

**Spec coverage (Plan 3):** generator adapter (copy live, image/video drop-in later) → Task 3; re-score gate keeps only winners → Task 3 (`generateImprovements`); conditioned on weak dimensions + tips + style refs → Task 3 (`buildPrompt`); persist input + variants → Tasks 1–2; ranked variants UI → Task 4. Meta-push intentionally deferred (noted in Scope). ✓

**Placeholder scan:** code is complete; the only "simplify the createMessage typing" note is a concrete instruction to match `orchestrate.server.ts`'s existing closure, not a placeholder.

**Type consistency:** `GenerationMode`/`GeneratedCandidate`/`Variant` defined once (Task 2), used by `generate.server.ts` (Task 3), `runs.server.ts` (Task 2), and the route (Task 4). `completeRun(id, scorecard, creativeInput)` signature consistent between runs (Task 2) and orchestrate (Task 2 Step 5). `generateImprovements`/`copyGenerator`/`GateDeps`/`GENERATE_TOOL_NAME` names consistent between Task 3 and Task 4.

---

## Execution
Subagent-driven in worktree `/Users/ericchen/Developer/shopify-app-plan3` (branch `plan3-generation`). All subagents work from that path.
