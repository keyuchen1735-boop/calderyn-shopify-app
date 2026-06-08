# Ad Creative Pre-Screen — Plan 2: Meta Source

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a merchant pick an existing **paused** ad from their connected Meta account and screen its real creative — instead of typing it in by hand — reusing the Plan 1 scoring/calibration/persistence untouched.

**Architecture:** A new `app/lib/screener/meta-creative.server.ts` with PURE parsers (Graph JSON → `CreativeInput` / `ScreenableAd` / audience summary) that are unit-tested with fixtures, plus thin I/O wrappers built on the existing `metaClientForShop`. The orchestrator gains a `source`/`metaAdId` passthrough; the route gets a "Pull from Meta" picker alongside the manual form.

**Tech Stack:** Remix + TS strict, Polaris, Meta Graph API v21.0 (via existing `MetaClient`), Vitest.

**Builds on:** Plan 1 (merged to main; `app/lib/screener/*`). This plan is on branch `plan2-meta-source` (worktree off main).

---

## Scope

- IN: list paused ads, fetch one ad's creative → `CreativeInput`, audience summary from adset targeting, route picker, persist `source="meta_ad"` + `meta_ad_id`.
- OUT (later plans): generation/variations (Plan 3), pushing anything back to Meta, image-hash→URL resolution (we use `image_url` when Meta provides it; otherwise imageUrl is null and scoring runs copy-only).

**Verification honesty (rule 12):** the live Graph calls (`listScreenableAds`, `fetchCreativeInput`) are exercised only structurally here (tsc + build) and via fixture-based unit tests on the pure parsers. True end-to-end against a real Meta account is a manual in-app check by the user; this plan does NOT claim live-verified Meta reads.

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/screener/types.ts` | + `ScreenableAd` interface |
| `app/lib/screener/meta-creative.server.ts` | PURE parsers (`mapAdListItem`, `summarizeTargeting`, `parseCreativeInput`) + I/O (`listScreenableAds`, `fetchCreativeInput`) |
| `app/lib/screener/orchestrate.server.ts` | thread `source` + `metaAdId` through `executeScreen` |
| `app/routes/app.screener.tsx` | loader loads ad list; action handles meta mode; UI picker |
| `app/lib/screener/__tests__/meta-creative.test.ts` | fixture tests for the parsers |
| `app/lib/screener/__tests__/orchestrate.test.ts` | + a meta-source case |

---

## Task 1: Types — add `ScreenableAd`

**Files:** Modify `app/lib/screener/types.ts`

- [ ] **Step 1: Add the interface** at the end of `app/lib/screener/types.ts` (after `CreativeScreenRun`):

```ts

/** One ad the merchant can pick to screen (Meta source). */
export interface ScreenableAd {
  id: string;
  name: string;
  effectiveStatus: string;
}
```

- [ ] **Step 2: Verify** `npx tsc --noEmit` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/screener/types.ts
git commit -m "screener/types: add ScreenableAd for Meta source picker"
```

---

## Task 2: Meta creative reader — `meta-creative.server.ts`

Pure parsers (TDD with fixtures) + thin I/O. The parsers handle the three common Meta creative shapes: `object_story_spec.link_data`, legacy top-level (`title`/`body`/`image_url`), and `asset_feed_spec` (Advantage+ arrays).

**Files:**
- Create: `app/lib/screener/meta-creative.server.ts`
- Test: `app/lib/screener/__tests__/meta-creative.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `app/lib/screener/__tests__/meta-creative.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapAdListItem, summarizeTargeting, parseCreativeInput } from "../meta-creative.server";

describe("mapAdListItem", () => {
  it("maps a raw ad row to ScreenableAd", () => {
    const out = mapAdListItem({ id: "123", name: "Spring Ad", effective_status: "PAUSED" });
    expect(out).toEqual({ id: "123", name: "Spring Ad", effectiveStatus: "PAUSED" });
  });
  it("defaults missing name/status", () => {
    const out = mapAdListItem({ id: "9" });
    expect(out.name).toBe("(untitled ad)");
    expect(out.effectiveStatus).toBe("UNKNOWN");
  });
});

describe("summarizeTargeting", () => {
  it("flattens geo, age, gender and interests into a short string", () => {
    const s = summarizeTargeting({
      age_min: 25, age_max: 44, genders: [2],
      geo_locations: { countries: ["US", "CA"] },
      flexible_spec: [{ interests: [{ name: "Skincare" }, { name: "Beauty" }] }],
    });
    expect(s).toContain("US");
    expect(s).toContain("25–44");
    expect(s.toLowerCase()).toContain("women");
    expect(s).toContain("Skincare");
  });
  it("returns a neutral default when targeting is empty", () => {
    expect(summarizeTargeting({})).toBe("Broad / unspecified audience");
  });
});

describe("parseCreativeInput", () => {
  it("reads object_story_spec.link_data (the common shape)", () => {
    const raw = {
      creative: {
        object_story_spec: {
          link_data: {
            message: "Glass skin in 7 days.",
            name: "Try the serum",
            link: "https://shop.test/p/serum?utm_content=HYD-SERUM",
            call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.test/p/serum" } },
          },
        },
        image_url: "https://img.test/c.jpg",
      },
      adset: { targeting: { age_min: 25, age_max: 44, geo_locations: { countries: ["US"] } } },
    };
    const out = parseCreativeInput(raw);
    expect(out.headline).toBe("Try the serum");
    expect(out.primaryText).toBe("Glass skin in 7 days.");
    expect(out.cta).toBe("SHOP_NOW");
    expect(out.destinationUrl).toBe("https://shop.test/p/serum?utm_content=HYD-SERUM");
    expect(out.imageUrl).toBe("https://img.test/c.jpg");
    expect(out.audience).toContain("US");
  });

  it("falls back to legacy top-level title/body and asset_feed_spec", () => {
    const legacy = parseCreativeInput({
      creative: { title: "Legacy headline", body: "Legacy body", image_url: "https://img.test/x.jpg", call_to_action_type: "LEARN_MORE", link_url: "https://shop.test/x" },
    });
    expect(legacy.headline).toBe("Legacy headline");
    expect(legacy.primaryText).toBe("Legacy body");
    expect(legacy.cta).toBe("LEARN_MORE");
    expect(legacy.destinationUrl).toBe("https://shop.test/x");

    const afs = parseCreativeInput({
      creative: {
        asset_feed_spec: {
          titles: [{ text: "AFS headline" }],
          bodies: [{ text: "AFS body" }],
          link_urls: [{ website_url: "https://shop.test/afs" }],
          call_to_action_types: ["BUY_NOW"],
        },
      },
    });
    expect(afs.headline).toBe("AFS headline");
    expect(afs.primaryText).toBe("AFS body");
    expect(afs.destinationUrl).toBe("https://shop.test/afs");
    expect(afs.cta).toBe("BUY_NOW");
  });

  it("never throws on a sparse/empty creative — returns empty-ish CreativeInput", () => {
    const out = parseCreativeInput({});
    expect(out.imageUrl).toBeNull();
    expect(out.headline).toBe("");
    expect(out.cta).toBe("SHOP_NOW");
    expect(out.audience).toBe("Broad / unspecified audience");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run app/lib/screener/__tests__/meta-creative.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement.** Create `app/lib/screener/meta-creative.server.ts`:

```ts
// app/lib/screener/meta-creative.server.ts
// Reads paused ads + their creative from the connected Meta account and shapes
// them into the screener's CreativeInput. Pure parsers are exported for testing;
// the I/O wrappers build on the existing metaClientForShop. Never throws on
// sparse creatives — missing fields degrade to empty strings / null image so
// scoring can still run copy-only.
import { metaClientForShop } from "../meta/client.server";
import type { MetaResponse } from "../meta/campaigns.server";
import type { CreativeInput, ScreenableAd } from "./types";

// ---- pure parsers ----

export function mapAdListItem(raw: Record<string, unknown>): ScreenableAd {
  return {
    id: String(raw.id ?? ""),
    name: typeof raw.name === "string" && raw.name ? raw.name : "(untitled ad)",
    effectiveStatus:
      typeof raw.effective_status === "string"
        ? raw.effective_status
        : typeof raw.status === "string"
          ? (raw.status as string)
          : "UNKNOWN",
  };
}

const GENDER_LABEL: Record<number, string> = { 1: "men", 2: "women" };

export function summarizeTargeting(t: Record<string, unknown> | null | undefined): string {
  if (!t || typeof t !== "object") return "Broad / unspecified audience";
  const parts: string[] = [];

  const geo = (t.geo_locations as { countries?: unknown } | undefined)?.countries;
  if (Array.isArray(geo) && geo.length) parts.push(geo.filter((c) => typeof c === "string").join(", "));

  const min = t.age_min as number | undefined;
  const max = t.age_max as number | undefined;
  if (min || max) parts.push(`${min ?? 18}–${max ?? 65}`);

  const genders = t.genders as number[] | undefined;
  if (Array.isArray(genders) && genders.length) {
    const g = genders.map((n) => GENDER_LABEL[n]).filter(Boolean);
    if (g.length) parts.push(g.join(" & "));
  }

  const flex = t.flexible_spec as Array<{ interests?: Array<{ name?: string }> }> | undefined;
  const interests = Array.isArray(flex)
    ? flex.flatMap((f) => (f.interests ?? []).map((i) => i.name).filter((n): n is string => !!n))
    : [];
  if (interests.length) parts.push(`interested in ${interests.slice(0, 5).join(", ")}`);

  return parts.length ? parts.join(" · ") : "Broad / unspecified audience";
}

type LinkData = {
  message?: string;
  name?: string;
  link?: string;
  call_to_action?: { type?: string; value?: { link?: string } };
};
type AssetFeed = {
  titles?: Array<{ text?: string }>;
  bodies?: Array<{ text?: string }>;
  link_urls?: Array<{ website_url?: string }>;
  call_to_action_types?: string[];
};
type RawCreative = {
  title?: string;
  body?: string;
  image_url?: string;
  link_url?: string;
  call_to_action_type?: string;
  object_story_spec?: { link_data?: LinkData };
  asset_feed_spec?: AssetFeed;
};

const firstStr = (...vals: Array<unknown>): string => {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return "";
};

/** Shape a raw `{creative, adset}` ad object into a CreativeInput. Never throws. */
export function parseCreativeInput(rawAd: Record<string, unknown>): CreativeInput {
  const creative = (rawAd.creative ?? {}) as RawCreative;
  const link = creative.object_story_spec?.link_data;
  const afs = creative.asset_feed_spec;

  const headline = firstStr(link?.name, creative.title, afs?.titles?.[0]?.text);
  const primaryText = firstStr(link?.message, creative.body, afs?.bodies?.[0]?.text);
  const cta = firstStr(
    link?.call_to_action?.type,
    creative.call_to_action_type,
    afs?.call_to_action_types?.[0],
  ) || "SHOP_NOW";
  const destinationUrl = firstStr(
    link?.link,
    link?.call_to_action?.value?.link,
    creative.link_url,
    afs?.link_urls?.[0]?.website_url,
  );
  const imageUrl = firstStr(creative.image_url) || null;

  const targeting = (rawAd.adset as { targeting?: Record<string, unknown> } | undefined)?.targeting;
  const audience = summarizeTargeting(targeting);

  return { imageUrl, headline, primaryText, cta, destinationUrl, audience };
}

// ---- I/O (build on the existing Meta client) ----

function check(r: MetaResponse): MetaResponse {
  if (r.error) throw new Error(`Meta API error: ${r.error.message}`);
  return r;
}

/** Paused ads in the connected account, for the picker. Returns [] if Meta isn't connected. */
export async function listScreenableAds(shop: string): Promise<ScreenableAd[]> {
  const conn = await metaClientForShop(shop);
  if (!conn) return [];
  const body = check(
    await conn.client.get(`/${conn.adAccountId}/ads`, {
      fields: "id,name,effective_status",
      effective_status: JSON.stringify(["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"]),
      limit: "50",
    }),
  );
  const rows = (body.data as Array<Record<string, unknown>>) ?? [];
  return rows.map(mapAdListItem);
}

/** Fetch one ad's creative + adset targeting and shape it into a CreativeInput. */
export async function fetchCreativeInput(shop: string, adId: string): Promise<CreativeInput> {
  const conn = await metaClientForShop(shop);
  if (!conn) throw new Error("Meta account is not connected");
  const body = check(
    await conn.client.get(`/${adId}`, {
      fields:
        "name,creative{title,body,image_url,link_url,call_to_action_type,object_story_spec,asset_feed_spec},adset{targeting}",
    }),
  );
  return parseCreativeInput(body as Record<string, unknown>);
}
```

- [ ] **Step 4: Run** `npx vitest run app/lib/screener/__tests__/meta-creative.test.ts` — expect PASS. Also `npx tsc --noEmit` exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/meta-creative.server.ts app/lib/screener/__tests__/meta-creative.test.ts
git commit -m "screener: Meta creative reader (paused ad list + creative→CreativeInput)"
```

---

## Task 3: Thread `source` + `metaAdId` through the orchestrator

**Files:**
- Modify: `app/lib/screener/orchestrate.server.ts`
- Modify: `app/lib/screener/__tests__/orchestrate.test.ts`

- [ ] **Step 1: Update the failing test first.** In `app/lib/screener/__tests__/orchestrate.test.ts`, add a meta-source case inside `describe("executeScreen", ...)` (before its closing `});`):

```ts
  it("threads source and metaAdId into the run", async () => {
    const captured: { source?: string } = {};
    const out = await executeScreen(
      { shop: "s", input, assumedSpendCents: 50000, source: "meta_ad", metaAdId: "ad-9" },
      deps({
        startRun: async (_shop, source) => {
          captured.source = source;
          return {
            id: "run-9", status: "running", source, metaAdId: "ad-9",
            assumedSpendCents: 50000, scorecard: null, error: null, createdAt: "t", completedAt: null,
          };
        },
      }),
    );
    expect(captured.source).toBe("meta_ad");
    expect(out.metaAdId).toBe("ad-9");
    expect(out.status).toBe("done");
  });
```

Also update the `ScreenDeps` fake's `startRun` type usage: the existing `deps()` helper's `startRun: async () => run` stays valid because the signature widens (see Step 3). No other test changes needed.

- [ ] **Step 2: Run** `npx vitest run app/lib/screener/__tests__/orchestrate.test.ts` — expect FAIL (executeScreen doesn't accept `source`/`metaAdId`; `out.metaAdId` is "run-1"'s null).

- [ ] **Step 3: Implement.** Edit `app/lib/screener/orchestrate.server.ts`:

(a) Widen `ScreenDeps.startRun` to accept any `RunSource` and a metaAdId, and import `RunSource`:

Change the import line:
```ts
import type {
  CalibrationInputs, CreativeInput, CreativeScreenRun, RunSource, ScoreCard,
} from "./types";
```
Change the `startRun` member of `ScreenDeps` from:
```ts
  startRun: (shop: string, source: "manual", assumedSpendCents: number) => Promise<CreativeScreenRun>;
```
to:
```ts
  startRun: (shop: string, source: RunSource, assumedSpendCents: number, metaAdId?: string | null) => Promise<CreativeScreenRun>;
```

(b) Change `executeScreen`'s signature and body to accept + thread the new fields:
```ts
export async function executeScreen(
  args: { shop: string; input: CreativeInput; assumedSpendCents: number; source?: RunSource; metaAdId?: string | null },
  deps: ScreenDeps = defaultDeps(),
): Promise<CreativeScreenRun> {
  const source: RunSource = args.source ?? "manual";
  const metaAdId = args.metaAdId ?? null;
  let run: CreativeScreenRun | null = null;
  try {
    run = await deps.startRun(args.shop, source, args.assumedSpendCents, metaAdId);
    const mappedSku = deps.resolveSku(args.input.destinationUrl);
    const calib = await deps.loadCalibrationInputs(args.shop, mappedSku);
    const scored = await deps.scoreCreative(args.input, calib.topAdNames);
    const { outcomes, composite, grade, confidence } = calibrate(
      scored.metrics,
      calib,
      args.assumedSpendCents,
    );
    const scorecard: ScoreCard = {
      composite, grade, confidence,
      summary: scored.summary,
      metrics: scored.metrics,
      outcomes,
      tips: scored.tips,
    };
    return await deps.completeRun(run.id, scorecard);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        return await deps.failRun(run.id, message);
      } catch {
        // failRun itself failed — fall through to a synthetic error DTO.
      }
    }
    return {
      id: run?.id ?? "",
      status: "error",
      source,
      metaAdId,
      assumedSpendCents: args.assumedSpendCents,
      scorecard: null,
      error: message,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}
```

(c) `defaultDeps()` already passes `realStart` (from runs.server, whose `startRun(shop, source, assumedSpendCents, metaAdId?)` matches the widened type) — no change needed there.

- [ ] **Step 4: Run** `npx vitest run app/lib/screener/__tests__/orchestrate.test.ts` — expect PASS (3 tests). `npx tsc --noEmit` exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/screener/orchestrate.server.ts app/lib/screener/__tests__/orchestrate.test.ts
git commit -m "screener/orchestrate: thread source + metaAdId into executeScreen"
```

---

## Task 4: Route — Meta picker (loader list, action mode, UI)

**Files:**
- Modify: `app/routes/app.screener.tsx`
- Test: `app/lib/screener/__tests__/route-helpers.test.ts` (add a meta-mode parse assertion)

- [ ] **Step 1: Add a failing test** for the action-mode helper. Append to `app/lib/screener/__tests__/route-helpers.test.ts`:

```ts
import { isMetaSubmit } from "../../../routes/app.screener";

describe("isMetaSubmit", () => {
  it("detects the meta source mode + ad id", () => {
    const fd = new FormData();
    fd.set("source", "meta_ad");
    fd.set("metaAdId", "ad-7");
    expect(isMetaSubmit(fd)).toEqual({ metaAdId: "ad-7" });
  });
  it("returns null for manual submits", () => {
    const fd = new FormData();
    expect(isMetaSubmit(fd)).toBeNull();
  });
  it("returns null when meta mode lacks an ad id", () => {
    const fd = new FormData();
    fd.set("source", "meta_ad");
    expect(isMetaSubmit(fd)).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run app/lib/screener/__tests__/route-helpers.test.ts` — expect FAIL (`isMetaSubmit` missing).

- [ ] **Step 3: Implement the route changes.**

(a) Add to the imports from the screener lib in `app/routes/app.screener.tsx`:
```ts
import { listScreenableAds, fetchCreativeInput } from "~/lib/screener/meta-creative.server";
import { type ScreenableAd } from "~/lib/screener/types";
```
(Add `ScreenableAd` to the existing `~/lib/screener/types` import list rather than duplicating, and add the meta-creative import as a new line.)

(b) Add the exported helper near `parseCreativeForm`:
```ts
export function isMetaSubmit(form: FormData): { metaAdId: string } | null {
  if (String(form.get("source") ?? "") !== "meta_ad") return null;
  const metaAdId = String(form.get("metaAdId") ?? "").trim();
  return metaAdId ? { metaAdId } : null;
}
```

(c) Extend `LoaderPayload` and the loader to include the ad list:
```ts
type LoaderPayload = { latest: CreativeScreenRun | null; history: CreativeScreenRun[]; metaAds: ScreenableAd[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history, metaAds] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
    listScreenableAds(session.shop).catch(() => [] as ScreenableAd[]),
  ]);
  return json<LoaderPayload>({ latest, history, metaAds });
};
```
(The `.catch(() => [])` keeps the page working when Meta isn't connected or the call fails — the picker just shows empty, rule 12: the manual path is unaffected.)

(d) Update the action to branch on meta vs manual:
```ts
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const assumedSpendCents = clampSpend(form.get("assumedSpendCents"));
  const meta = isMetaSubmit(form);
  if (meta) {
    const input = await fetchCreativeInput(session.shop, meta.metaAdId);
    const run = await executeScreen({
      shop: session.shop, input, assumedSpendCents, source: "meta_ad", metaAdId: meta.metaAdId,
    });
    return json(run);
  }
  const input = parseCreativeForm(form);
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json(run);
};
```

(e) Update the component to read `metaAds` and render a picker card above the manual form. In `export default function Screener()`, change the destructure:
```ts
  const { latest, history, metaAds } = useLoaderData<typeof loader>();
```
Then add this card as the FIRST child inside the top `<BlockStack gap="500">`, before the manual-form `<Card>`:
```tsx
        {metaAds.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">Screen a paused ad from Meta</Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Pulls the real creative + targeting from your connected Meta account.
              </Text>
              <BlockStack gap="200">
                {metaAds.map((ad) => (
                  <InlineStack key={ad.id} align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text as="span" variant="bodyMd">{ad.name}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{ad.effectiveStatus}</Text>
                    </BlockStack>
                    <fetcher.Form method="post">
                      <input type="hidden" name="source" value="meta_ad" />
                      <input type="hidden" name="metaAdId" value={ad.id} />
                      <input type="hidden" name="assumedSpendCents" value={Math.round(Number(spend || 0) * 100)} />
                      <Button submit loading={running} disabled={running}>Screen this ad</Button>
                    </fetcher.Form>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}
```
Keep the existing manual-form card and the whole results section unchanged. (The manual form already keeps the `<Text as="h2">` heading? If not, optionally add a "Or enter an ad manually" heading to the manual card — minor, your call. Do NOT restructure the results UI.)

- [ ] **Step 4: Run** `npx vitest run app/lib/screener/__tests__/route-helpers.test.ts` — expect PASS. Then `npx tsc --noEmit` exit 0 (watch the Polaris `gap="050"` value — if the installed Polaris rejects "050", use "100"; confirm against existing usage in `app/routes/app.simulator.tsx`).

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.screener.tsx app/lib/screener/__tests__/route-helpers.test.ts
git commit -m "routes/app.screener: pull-from-Meta picker (paused ads → screen real creative)"
```

---

## Task 5: Full gate

- [ ] **Step 1: Run the gate, paste each result** (rule 12 — evidence, no assertions without output):
```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```
All must exit 0. If `npm run build` fails on a `.server` import leaking client-side, that's a real failure — STOP and report (do not paper over).

- [ ] **Step 2: Commit** any lint-fix touch-ups if needed (otherwise nothing to commit). The feature is already committed task-by-task.

---

## Self-Review

**Spec coverage (Plan 2):** list paused Meta ads → Task 2 (`listScreenableAds`) + Task 4 (picker); fetch real creative → Task 2 (`fetchCreativeInput`/`parseCreativeInput`); creative→SKU still via the destination URL the Meta creative carries (existing `resolveSku` in orchestrator — no change needed; the Meta `link_data.link` flows into `CreativeInput.destinationUrl`); persist `source="meta_ad"` + `meta_ad_id` → Task 3; graceful when Meta not connected → Task 2 (`[]`) + Task 4 (`.catch`). ✓

**Placeholder scan:** every code step is complete; the only conditional ("if Polaris rejects gap=050") is a concrete verify-and-swap, not a placeholder.

**Type consistency:** `ScreenableAd` defined once (Task 1), used in meta-creative (Task 2) + route (Task 4). `executeScreen` new optional `source`/`metaAdId` (Task 3) consumed by the route action (Task 4). `parseCreativeInput` returns the Plan-1 `CreativeInput` verbatim. `fetchCreativeInput`/`listScreenableAds` names consistent between Task 2 and Task 4.

---

## Execution

Subagent-driven, in the worktree `/Users/ericchen/Developer/shopify-app-plan2` (branch `plan2-meta-source`). All subagents work from that path. After the gate is green, controller merges `plan2-meta-source` → main and removes the worktree.
