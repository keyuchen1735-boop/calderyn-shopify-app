# iPhone Embedded-App Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the phone view of every Shopify embedded-app page read clean and card-based like the Calderyn dashboard, without changing the desktop layout.

**Architecture:** Pure Polaris presentational changes. Layout restructuring is gated to the phone breakpoint via `useBreakpoints().smDown` (desktop renders unchanged). Wide tables gain a `smDown` stacked-card branch modeled on the existing Analytics `GradeCard`/`AdCard` pattern. KPI grids change only their phone column count. No data, loader, action, or DTO changes.

**Tech Stack:** Remix + React 18 + Shopify Polaris + App Bridge. TypeScript strict. Verification via Playwright MCP at iPhone (~390px) and desktop (~1280px) viewports.

## Global Constraints

- **Desktop unchanged:** every layout change is gated to `smDown`; desktop output must be identical to `main`. (Verified by desktop before/after screenshots.)
- **Polaris only:** no raw CSS frameworks, no Lucide in `app.*` (Polaris convention / App Store review). Reuse `useBreakpoints` exactly as `app.analytics._index.tsx` does — do not introduce a new breakpoint source.
- **No data/logic changes:** loaders, actions, DTOs, detectors untouched.
- **Capability parity:** any phone card must expose every action its desktop table row does (Undo + Download PDF on Audit; Revoke / Disconnect on Claude connections).
- **Embedded admin only:** `app/routes/app.*`. Do not touch `dashboard.*` (the dashboard is the reference, not a mirror target here).
- **Pre-commit gate (CLAUDE.md), all green with evidence pasted, before any commit beyond trivial:** `/code-review` → `git diff --check` → `npm run typecheck` → `npm run lint` (`--max-warnings=0` on touched files) → `npm run build`. No prisma/graphql-codegen (no schema/query changes).
- **Already-shipped (no task — confirmed in code):** Home single-hero CTA (`app._index.tsx:185-195`), Claude-connections rename (`app.mcp.tsx:207-210`), onboarding stepper + env-gated skip (`app.onboarding.tsx:257-273`). Do not redo these.

---

### Task 1: Create the feature worktree

**Files:** none (git only).

- [ ] **Step 1: Create the isolated worktree**

REQUIRED SUB-SKILL: Use superpowers:using-git-worktrees. Equivalent git fallback:

Run:
```bash
git worktree add ../calderyn-mobile-polish -b feat/mobile-embedded-polish
```
Expected: `Preparing worktree (new branch 'feat/mobile-embedded-polish')`. Do all subsequent tasks inside `../calderyn-mobile-polish`.

- [ ] **Step 2: Install deps in the worktree (the repo needs node_modules present to typecheck/build)**

Run:
```bash
cd ../calderyn-mobile-polish && npm install
```
Expected: completes with no error (note: `main` has historically needed a fresh `npm install` for `pdf-lib` — this covers it).

---

### Task 2: Home — 2-up KPI tiles + no-squish "Today's focus" on phone

**Files:**
- Modify: `app/routes/app._index.tsx` (KPI grid ~line 199; "Today's focus" row ~lines 240-282)

**Interfaces:**
- Consumes: existing `useBreakpoints` from `@shopify/polaris` (add to imports if absent).
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Add `useBreakpoints` to the Polaris import (if not already imported), and read it in the component**

In the component body of the default export (near the other hooks, e.g. just after `const navigate = ...`), add:
```tsx
const { smDown } = useBreakpoints();
```
Confirm `useBreakpoints` is in the `@shopify/polaris` import list at the top; add it if missing.

- [ ] **Step 2: Make the KPI grid 2-up on phones**

Change the stat-row grid (currently line ~199):
```tsx
<InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
```
to:
```tsx
<InlineGrid columns={{ xs: 2, sm: 2, md: 4 }} gap="400">
```
(Desktop `md: 4` unchanged; phone goes from 1 thin bar to 2-up.)

- [ ] **Step 3: Stop the "Today's focus" title + buttons from colliding on phones**

The "Today's focus" block (line ~242) uses `InlineStack align="space-between" ... wrap={false}` with a button row `InlineStack gap="200" wrap={false}` (line ~265). Make both stack on phone by switching the outer stack to a vertical layout and letting the buttons go full-width under `smDown`.

Replace the outer wrapper (line ~242) opening tag:
```tsx
<InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
```
with:
```tsx
<BlockStack gap="300">
```
and its matching closing `</InlineStack>` (the one at line ~281, immediately before `</div>`) with `</BlockStack>`.

Then change the button group (line ~265) from:
```tsx
<InlineStack gap="200" wrap={false}>
```
to:
```tsx
<InlineStack gap="200" wrap={false} align={smDown ? "fill" : "start"}>
```
and add `fullWidth={smDown}` to BOTH `<Button>`s inside it (the "Review" button ~line 266 and the action button ~line 273), so on phone they sit on their own full-width row beneath the text instead of being crushed beside it. On desktop (`smDown === false`) `fullWidth` is false and the row renders as today.

> Note: `BlockStack` is already imported in this file (used elsewhere). Verify before relying on it.

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "routes/app._index: 2-up KPI tiles + stacked Today's focus on phone"
```

---

### Task 3: Audit — 2-up summary tiles + mobile card branch for the action table

**Files:**
- Modify: `app/routes/app.audit.tsx` (summary grid ~line 302; `IndexTable` ~lines 318-331; default export `Audit()` ~line 236)
- Add: a new `AuditCardEx` component in the same file (mirrors `AuditRowEx`, no new file — it shares all the same helpers/state and is only used here).

**Interfaces:**
- Consumes: existing helpers already in the file — `auditLegibility`, `stateDiff`, `ACTION_LABELS`, `fmtMoney`, `fmtRelTime`, `fmtAbsTime`, `shortId`, `DownloadPoButton`, `COST_SOURCE_LABELS`, and the `AuditEntry` type. `useBreakpoints` from `@shopify/polaris`.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Make the 3 summary tiles 2-up on phones**

Change the summary grid (line ~302):
```tsx
<InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
```
to:
```tsx
<InlineGrid columns={{ xs: 2, sm: 3 }} gap="400">
```

- [ ] **Step 2: Add a phone card component next to `AuditRowEx`**

Add this component immediately after the `AuditRowEx` function (after line ~234). It shows the same fields and the same Undo/Download actions, stacked as a tappable card with the detail inline (no IndexTable):
```tsx
function AuditCardEx({
  a, index, submitting,
}: { a: AuditEntry; index: number; submitting: boolean }) {
  const [open, setOpen] = useState(false);
  const leg = auditLegibility(a);
  const diff = stateDiff(a.action_kind, a.pre_state, a.post_state);
  const actionLabel = ACTION_LABELS[a.action_kind] ?? a.action_kind;
  const canUndo = a.undo_eligible && !a.undo_of;
  const hasPoPdf =
    a.action_kind === "create_po_draft" && a.outcome === "succeeded" && Boolean(a.post_state?.po);
  const estimateCents = Number(a.post_state?.estimate_cents ?? 0);
  const showEstimate =
    !a.dollar_impact_at_exec && estimateCents > 0 && a.action_kind !== "snooze_alert";
  const showImpact = a.dollar_impact_at_exec > 0 && !a.undo_of;

  return (
    <Box
      padding="400"
      borderBlockStartWidth={index === 0 ? undefined : "025"}
      borderColor="border"
    >
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
          <BlockStack gap="050">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {a.undo_of ? `Reversed — ${actionLabel}` : actionLabel}
            </Text>
            <Text as="p" variant="bodyXs" tone="subdued">
              {fmtRelTime(a.created_at)} · {shortId(a.target)}
            </Text>
          </BlockStack>
          <Badge tone={a.outcome === "succeeded" ? "success" : a.outcome === "retrying" ? "attention" : "critical"}>
            {a.outcome}
          </Badge>
        </InlineStack>

        <Text as="p" variant="bodySm" tone="subdued">{leg.why}</Text>

        <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={leg.mode === "auto" ? "info" : undefined}>
              {leg.mode === "auto" ? "Auto" : "Manual"}
            </Badge>
            <Text as="span" variant="bodySm" fontWeight="semibold">
              {a.dollar_impact_at_exec < 0 ? "-" : ""}{fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
            </Text>
            {showEstimate && (
              <Text as="span" variant="bodyXs" tone="subdued">est. {fmtMoney(estimateCents)}</Text>
            )}
          </InlineStack>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            {(canUndo || hasPoPdf) && (
              <>
                {canUndo && (
                  <Form method="post">
                    <input type="hidden" name="intent" value="undo" />
                    <input type="hidden" name="auditId" value={a.id} />
                    <Button submit variant="plain" loading={submitting} disabled={submitting}>Undo</Button>
                  </Form>
                )}
                {hasPoPdf && <DownloadPoButton auditId={a.id} />}
              </>
            )}
            <Button
              variant="tertiary"
              icon={open ? ChevronDownIcon : ChevronRightIcon}
              onClick={() => setOpen((v) => !v)}
              accessibilityLabel={open ? "Hide details" : "Show details"}
            />
          </InlineStack>
        </InlineStack>

        <Collapsible id={`mdetail-${a.id}`} open={open} transition={{ duration: "150ms" }}>
          <Box padding="300" background="bg-surface-secondary" borderRadius="200">
            <BlockStack gap="150">
              <DetailLine label="Why this fired" value={leg.whyDetail ?? leg.why} />
              {a.failure_reason && <DetailLine label="Failure reason" value={a.failure_reason} />}
              {showImpact && (
                <DetailLine label="Booked margin"
                  value={`${a.dollar_impact_at_exec < 0 ? "-" : ""}${fmtMoney(Math.abs(a.dollar_impact_at_exec))} · ${leg.marginBasisLabel}`} />
              )}
              {diff.length > 0 && (
                <BlockStack gap="150">
                  <Text as="span" variant="bodySm" fontWeight="semibold">Before → after</Text>
                  <InlineGrid columns={{ xs: 1, sm: Math.min(diff.length, 2) as 1 | 2 }} gap="200">
                    {diff.map((r) => (
                      <Box key={r.label} background="bg-surface" padding="200" borderRadius="200" borderColor="border" borderWidth="025">
                        <Text as="p" variant="bodySm" tone="subdued">{r.label}</Text>
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          {r.before != null && r.after != null ? `${r.before} → ${r.after}` : r.after ?? r.before}
                        </Text>
                      </Box>
                    ))}
                  </InlineGrid>
                </BlockStack>
              )}
            </BlockStack>
          </Box>
        </Collapsible>
      </BlockStack>
    </Box>
  );
}
```

- [ ] **Step 3: Read `smDown` in `Audit()` and branch the table vs card list**

In `Audit()` (default export, ~line 236), after `useActionToast(actionData);` add:
```tsx
const { smDown } = useBreakpoints();
```
Then replace the `<Card padding="0"> ... <IndexTable> ... </IndexTable> </Card>` block (lines ~318-331) with:
```tsx
<Card padding="0">
  {smDown ? (
    <BlockStack gap="0">
      {(audit as AuditEntry[]).map((a, i) => (
        <AuditCardEx key={a.id} a={a} index={i} submitting={submitting} />
      ))}
    </BlockStack>
  ) : (
    <IndexTable
      selectable={false}
      itemCount={audit.length}
      headings={[
        { title: "" }, { title: "Time" }, { title: "Action" }, { title: "Mode" },
        { title: "Target" }, { title: "Impact", alignment: "end" }, { title: "Status" }, { title: "" },
      ]}
    >
      {(audit as AuditEntry[]).map((a, i) => (
        <AuditRowEx key={a.id} a={a} index={i} submitting={submitting} />
      ))}
    </IndexTable>
  )}
</Card>
```

- [ ] **Step 4: Ensure `useBreakpoints` is imported**

Confirm `useBreakpoints` is in the `@shopify/polaris` import block at the top of `app.audit.tsx`; add it if missing.

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0. (Watch for the `as 1 | 2` cast and that all helpers referenced exist in-file.)

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.audit.tsx
git commit -m "routes/app.audit: stacked action cards on phone + 2-up summary tiles"
```

---

### Task 4: Claude connections — mobile card branch for the token + grant tables

**Files:**
- Modify: `app/routes/app.mcp.tsx` (tokens `DataTable` ~lines 233-237; oauth grants `DataTable` ~lines 248-263; default export component)

**Interfaces:**
- Consumes: the existing `tokens`, `oauthGrants`, `rows` data already in scope in the component; `submitting`; `useBreakpoints`.
- Produces: nothing other tasks rely on.

> Context: `rows` (line ~ before 233) is a pre-built array for the `DataTable`. For the cards, read from the source `tokens`/`oauthGrants` objects directly. Before writing Step 2, read the loader's token/grant shape near the top of `app.mcp.tsx` to confirm field names (e.g. `t.id`, `t.name`, `t.prefix`, `t.scopes`, `t.last_used_at`, `t.created_at`; `g.id`, `g.name`, `g.created_at`, `g.last_used_at`). Use the exact field names found.

- [ ] **Step 1: Read `smDown` in the component**

After the existing hooks in the default export, add:
```tsx
const { smDown } = useBreakpoints();
```
Add `useBreakpoints` to the `@shopify/polaris` import if missing.

- [ ] **Step 2: Branch the tokens table to cards on phone**

Replace the tokens `<DataTable .../>` (lines ~233-237) with:
```tsx
smDown ? (
  <BlockStack gap="300">
    {tokens.map((t) => (
      <Box key={t.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
        <BlockStack gap="150">
          <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
            <Text as="span" variant="bodySm" fontWeight="semibold">{t.name}</Text>
            <Text as="span" variant="bodyXs" tone="subdued">{t.prefix}</Text>
          </InlineStack>
          <Text as="span" variant="bodyXs" tone="subdued">{t.scopes}</Text>
          <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
            <Text as="span" variant="bodyXs" tone="subdued">
              Last used {t.last_used_at ? new Date(t.last_used_at).toLocaleDateString() : "never"}
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="revoke" />
              <input type="hidden" name="token_id" value={t.id} />
              <Button submit tone="critical" variant="plain" loading={submitting} disabled={submitting}>
                Revoke
              </Button>
            </Form>
          </InlineStack>
        </BlockStack>
      </Box>
    ))}
  </BlockStack>
) : (
  <DataTable
    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
    headings={["Name", "Prefix", "Scopes", "Last used", "Created", ""]}
    rows={rows}
  />
)
```
(Adjust `t.scopes` rendering if `scopes` is an array — join with `", "`. Confirm against the loader shape from Step 0's read.)

- [ ] **Step 3: Branch the oauth-grants table to cards on phone**

Replace the oauth grants `<DataTable .../>` (lines ~248-263) with:
```tsx
smDown ? (
  <BlockStack gap="300">
    {oauthGrants.map((g) => (
      <Box key={g.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" fontWeight="semibold">{g.name}</Text>
            <Text as="span" variant="bodyXs" tone="subdued">
              Connected {new Date(g.created_at).toLocaleDateString()}
              {g.last_used_at ? ` · last used ${new Date(g.last_used_at).toLocaleDateString()}` : ""}
            </Text>
          </BlockStack>
          <Form method="post">
            <input type="hidden" name="intent" value="oauth-revoke" />
            <input type="hidden" name="token_id" value={g.id} />
            <Button submit tone="critical" variant="plain" loading={submitting} disabled={submitting}>
              Disconnect
            </Button>
          </Form>
        </InlineStack>
      </Box>
    ))}
  </BlockStack>
) : (
  <DataTable
    columnContentTypes={["text", "text", "text", "text"]}
    headings={["Name", "Connected", "Last used", ""]}
    rows={oauthGrants.map((g) => [
      g.name,
      new Date(g.created_at).toLocaleString(),
      g.last_used_at ? new Date(g.last_used_at).toLocaleString() : "—",
      <Form method="post" key={`oauth-revoke-${g.id}`}>
        <input type="hidden" name="intent" value="oauth-revoke" />
        <input type="hidden" name="token_id" value={g.id} />
        <Button submit tone="critical" loading={submitting} disabled={submitting}>
          Disconnect
        </Button>
      </Form>,
    ])}
  />
)
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0. Fix any field-name mismatches against the real loader shape.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.mcp.tsx
git commit -m "routes/app.mcp: stacked access-key + workspace cards on phone"
```

---

### Task 5: Alert detail — PO modal fields stack on phone

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (PO field row ~lines 711-734)

**Interfaces:**
- Consumes: `FormLayout` from `@shopify/polaris` (add to imports if absent).

- [ ] **Step 1: Replace the side-by-side `InlineStack` with a responsive `FormLayout.Group`**

`FormLayout.Group` renders fields side-by-side on wide screens and stacks them on narrow ones automatically — desktop looks the same, phone stacks. Replace the wrapper at line ~711:
```tsx
<InlineStack gap="200" wrap={false}>
```
…through its closing `</InlineStack>` at line ~734, changing only the wrapper element so the two `<TextField>`s are wrapped as:
```tsx
<FormLayout>
  <FormLayout.Group>
    <TextField
      label="Quantity"
      name="po_quantity"
      type="number"
      min={1}
      max={1_000_000}
      value={poQuantity}
      onChange={setPoQuantity}
      autoComplete="off"
    />
    <TextField
      label="Unit cost"
      name="po_unit_cost"
      type="number"
      min={0}
      step={0.01}
      prefix="$"
      value={poUnitCost}
      onChange={setPoUnitCost}
      autoComplete="off"
      helpText="Leave blank if unknown — printed as TBD."
    />
  </FormLayout.Group>
</FormLayout>
```

- [ ] **Step 2: Ensure `FormLayout` is imported**

Confirm `FormLayout` is in the `@shopify/polaris` import block; add it if missing.

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.alerts.$id.tsx
git commit -m "routes/app.alerts.$id: PO modal fields stack on phone via FormLayout.Group"
```

---

### Task 6: Generator — tokenize the `ScoreChip` hardcoded sizes

**Files:**
- Modify: `app/routes/app.generator.tsx` (`ScoreChip` ~lines 178-199)

**Interfaces:** none.

- [ ] **Step 1: Replace hardcoded px with Polaris space tokens (visually neutral)**

In `ScoreChip` (line ~181), swap the numeric `width`/`height`/`fontSize` for token-based values so it matches the design system (same rendered size). Change:
```tsx
        width: 34,
        height: 34,
```
to:
```tsx
        width: "var(--p-space-800)",
        height: "var(--p-space-800)",
        minWidth: "var(--p-space-800)",
```
(`--p-space-800` = 32px, the nearest Polaris token; the 2px delta is intentional and visually neutral. Leave `fontSize: 13` — there is no exact token and changing it would shift the look.)

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.generator.tsx
git commit -m "routes/app.generator: tokenize ScoreChip sizing"
```

---

### Task 7: Alerts list — decide flat-vs-grouped, then phone row polish

**Files:**
- Modify (conditional): `app/routes/app.alerts._index.tsx` (row ~line 184)

**Open decision (ask the user before coding this task):** the extension currently groups alerts into severity cards (criticals-first), which already matches the dashboard's priority-first intent. The dashboard uses a single flat rank-sorted list. Options:
- **(A) Keep grouping (recommended)** — it's shipped, renders well on both, and is arguably clearer than a flat list. Do only the phone row polish below.
- **(B) Flatten to a dashboard-style ranked list** — bigger change, touches desktop, reverses prior work. Only if the user explicitly wants it.

- [ ] **Step 1 (always): phone row polish so the title never crushes the amount**

The row at line ~184 uses `InlineStack align="space-between" ... wrap={false}` with a `Box minWidth="120px"` amount. On a ~390px phone a long title + 120px amount can collide. Allow the row to wrap on phone only. Add `const { smDown } = useBreakpoints();` in the component (import `useBreakpoints` if absent), then change line ~184 from:
```tsx
<InlineStack align="space-between" blockAlign="center" gap="400" wrap={false}>
```
to:
```tsx
<InlineStack align="space-between" blockAlign={smDown ? "start" : "center"} gap="200" wrap={smDown}>
```
(Desktop keeps `wrap={false}` / centered; phone may wrap the amount under the title.)

- [ ] **Step 2 (only if option B chosen): flat ranked list** — out of scope unless the user opts in; if so, this becomes its own re-planned task.

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.alerts._index.tsx
git commit -m "routes/app.alerts._index: allow alert row to wrap on phone"
```

---

### Task 8: Full pre-commit gate

**Files:** none (verification).

- [ ] **Step 1: Patch sanity**

Run:
```bash
git diff main --stat && git diff main --check
```
Expected: only the seven `app/routes/app.*` files touched; no whitespace errors; no stray `console.log`/`.only`/commented-out blocks.

- [ ] **Step 2: Typecheck / lint / build**

Run:
```bash
npm run typecheck && npm run lint && npm run build
```
Expected: all exit 0. Lint must be clean (`--max-warnings=0`) on the touched files.

- [ ] **Step 3: Code review**

Run `/code-review` on the working tree. Resolve every blocker; downgrade nits with a one-line justification each. Paste the result.

---

### Task 9: Visual verification (Playwright MCP)

**Files:** none (verification + screenshots).

> **Auth note:** the embedded `app.*` routes require a Shopify admin session, so a bare Playwright navigation hits `/auth/login`. Use the running dev app with an authenticated session (the dev store the rest of QA uses — see memory `testing-on-prod`/`prod-observability`). If Playwright cannot drive the embedded iframe, fall back to capturing each route while signed into the admin, or render at the route with a seeded dev session. Capture both viewports regardless.

- [ ] **Step 1: Start the app**

Run the dev server (e.g. `npm run dev` / `shopify app dev`) and confirm the embedded app loads in an authenticated session.

- [ ] **Step 2: Phone screenshots (~390px), after**

With the Playwright MCP at a 390×844 viewport, capture: Home, Alerts list, Alert detail (PO modal open), Audit, Claude connections, Generator. Verify per page: no horizontal scroll; KPI tiles 2-up; Audit + Claude-connections render as stacked cards (not a sideways table); every action (Undo/Download, Revoke/Disconnect) is visible and tappable; Today's-focus + PO-modal fields stack cleanly.

- [ ] **Step 3: Desktop screenshots (~1280px), regression check**

At a 1280×900 viewport capture the same pages. Verify they look identical to `main` (the `smDown` branches are inactive; only the KPI `xs` change and token-neutral tweaks differ, none of which affect desktop). Compare against a quick `git stash`/`main` capture if anything looks off.

- [ ] **Step 4: Report**

Post the before/after phone shots + the desktop regression shots for user review. Do not merge until the user confirms the phone view looks right and desktop is unregressed.

---

## Self-Review

**Spec coverage:**
- Pattern 1 (KPI grid phone-only) → Tasks 2, 3. ✅
- Pattern 2 (mobile data cards) → Tasks 3 (Audit), 4 (Claude connections). ✅ (Analytics/Campaigns/Inventory already have it — no task, per spec.)
- Pattern 3 (no-squish rows) → Tasks 2 (Home focus), 5 (PO modal), 7 (alert row). ✅
- Rule 4 (content parity) → Home CTA, mcp rename, onboarding stepper all **already shipped** (Global Constraints "Already-shipped"); ranked Alerts flagged as an open decision in Task 7. ✅ (Coverage accounted for: done or flagged.)
- Generator token tidy → Task 6. ✅
- Desktop-unchanged + dual-viewport verification → Task 9. ✅
- Pre-commit gate → Task 8. ✅
- Worktree isolation → Task 1. ✅

**Placeholder scan:** no TBD/TODO in code steps; the only "ask first" is Task 7's deliberate decision gate (a real open question surfaced from the code, not a lazy placeholder). Task 4 Step 0 read is explicit about confirming field names.

**Type consistency:** `AuditCardEx` reuses the exact helper names/signatures from `AuditRowEx` (`auditLegibility`, `stateDiff`, `ACTION_LABELS`, `fmtMoney`, `fmtRelTime`, `shortId`, `DownloadPoButton`, `AuditEntry`). `useBreakpoints().smDown` used identically across tasks. mcp card field names flagged for confirmation against the loader before coding.
