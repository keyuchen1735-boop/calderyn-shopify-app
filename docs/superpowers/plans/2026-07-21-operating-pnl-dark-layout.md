# Operating P&L Dark Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dashboard Operating P&L a clear, theme-safe financial hierarchy in dark mode without changing its data or interactions.

**Architecture:** Keep `OperatingPnl` as the sole presentation component. It will emit semantic classes for the signed net-profit summary and the product table; scoped `cd-pnl-*` CSS will use existing dashboard tokens to provide the dark-aware emphasis. The existing cache, QuickBooks request, range control, chart, animation, and mobile overflow remain unchanged.

**Tech Stack:** React 18, TypeScript, Remix, Vitest, existing dashboard CSS tokens.

## Global Constraints

- Use no new dependencies.
- Change only `app/components/dashboard/screens/OperatingPnl.tsx`, its existing screen test, and `app/styles/dashboard.css`.
- Keep QuickBooks data, calculations, range selection, cache keys, explanatory hover text, loading/error states, and product-table mobile overflow unchanged.
- Use existing `--card`, `--card-solid`, `--text-*`, `--green`, `--red`, `--gray-bg`, `--hairline*`, and `--shadow-card` dashboard tokens; do not add fixed colors.
- Keep the change presentation-only and TypeScript-strict.

---

### Task 1: Add signed summary and product-table hierarchy

**Files:**
- Modify: `app/components/dashboard/screens/__tests__/operating-pnl.test.tsx:29-39`
- Modify: `app/components/dashboard/screens/OperatingPnl.tsx:50-57,145-238`
- Modify: `app/styles/dashboard.css` after the existing dashboard theme overrides

**Interfaces:**
- Consumes: `statement.netIncomeCents` and the existing `Metric` component props.
- Produces: `cd-pnl-stat--net`, `cd-pnl-stat--positive` or `cd-pnl-stat--negative`, `cd-pnl`, and `cd-pnl-product-table` markup hooks used only by the P&L stylesheet.

- [ ] **Step 1: Write the failing render test for signed hierarchy**

```tsx
it("gives net P&L a signed visual summary", () => {
  cacheScreenData(operatingPnlCacheKey(30), data);
  expect(renderToStaticMarkup(<OperatingPnl />)).toContain(
    "cd-pnl-stat--net cd-pnl-stat--positive",
  );

  cacheScreenData(operatingPnlCacheKey(30), {
    ...data,
    statement: { ...data.statement!, netIncomeCents: -40_00 },
  });
  const negative = renderToStaticMarkup(<OperatingPnl />);
  expect(negative).toContain("cd-pnl-stat--net cd-pnl-stat--negative");
  expect(negative).toContain("cd-pnl-product-table");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails before the markup exists**

Run: `npx vitest run app/components/dashboard/screens/__tests__/operating-pnl.test.tsx`

Expected: FAIL because `cd-pnl-stat--net` and `cd-pnl-product-table` are absent.

- [ ] **Step 3: Emit the smallest semantic hooks from the existing component**

```tsx
function Metric({ label, value, explain, emphasis = false, tone }: {
  label: string;
  value: string;
  explain: string;
  emphasis?: boolean;
  tone?: "positive" | "negative";
}) {
  const className = [
    "cd-stat",
    "cd-pnl-stat",
    emphasis && "cd-pnl-stat--net",
    tone && `cd-pnl-stat--${tone}`,
  ].filter(Boolean).join(" ");
  return (
    <Card className={className} data-explain={explain}>
      <span style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 650 }}>{label}</span>
      <strong className="tabular-nums" style={{ color: "var(--text-1)", fontSize: 28, letterSpacing: "-.04em" }}>{value}</strong>
    </Card>
  );
}

<div
  ref={rootRef}
  className="cd-screen cd-pnl"
  onMouseMove={onMove}
  onMouseLeave={() => setTip(null)}
>
  <Metric
    label="Net profit / loss"
    value={money(statement.netIncomeCents, data.currency)}
    explain="net"
    emphasis
    tone={statement.netIncomeCents >= 0 ? "positive" : "negative"}
  />
</div>

<div className="cd-pnl-products cd-pnl-product-table"><div>
```

- [ ] **Step 4: Add page-scoped token CSS for the signed summary and statement table**

```css
.cd-pnl { gap: calc(20px * var(--density)); }
.cd-pnl .cd-pnl-stat { min-height: 108px; justify-content: center; }
.cd-pnl .cd-pnl-stat--net {
  background: color-mix(in oklch, var(--card-solid) 90%, var(--gray-bg));
  box-shadow: inset 3px 0 var(--pnl-tone), var(--shadow-card);
}
.cd-pnl .cd-pnl-stat--positive { --pnl-tone: var(--green); }
.cd-pnl .cd-pnl-stat--negative { --pnl-tone: var(--red); }
.cd-pnl-product-table {
  overflow: hidden;
  border: 0.5px solid var(--hairline-strong);
  border-radius: 12px;
  background: color-mix(in oklch, var(--card-solid) 92%, var(--gray-bg));
}
.cd-pnl-product-table .cd-tablehd { background: var(--gray-bg); }
.cd-pnl-product-table .cd-trow { transition: background 0.16s ease; }
.cd-pnl-product-table .cd-trow:hover { background: var(--gray-bg); }
```

- [ ] **Step 5: Run the focused test and confirm it passes**

Run: `npx vitest run app/components/dashboard/screens/__tests__/operating-pnl.test.tsx`

Expected: PASS with both positive and negative signed-summary assertions.

- [ ] **Step 6: Run the required verification and commit the implementation**

Run: `npm run typecheck && npm run lint && npm run build`

Expected: each command exits 0.

```bash
git add app/components/dashboard/screens/OperatingPnl.tsx \
  app/components/dashboard/screens/__tests__/operating-pnl.test.tsx \
  app/styles/dashboard.css
git commit -m "dashboard/OperatingPnl: refine dark financial layout"
```
