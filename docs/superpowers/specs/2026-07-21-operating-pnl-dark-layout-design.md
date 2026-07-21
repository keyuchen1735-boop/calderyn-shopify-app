# Operating P&L dark layout design

## Goal

Make the dashboard Operating P&L feel native in dark mode and easier to scan as a financial statement, without changing its QuickBooks data, calculations, navigation, cache, or mobile table behavior.

## Scope

- Keep the existing header, 7/14/30 day control, four metrics, daily P&L chart, statement, product table, explanatory hover text, loading, and error states.
- Replace the screen's fixed navy, emerald, and paper colors with the dashboard theme tokens.
- Add small, page-scoped visual hierarchy: a distinct net-profit metric, quieter supporting metrics, readable dividers, a restrained chart zero line, and a compact product-table header.
- Preserve the existing two-column desktop and stacked/mobile layout. The product table stays horizontally scrollable on narrow screens.

## Implementation

- Update `app/components/dashboard/screens/OperatingPnl.tsx` only for semantic page classes and token-backed inline values that depend on live P&L data.
- Add a small set of `cd-pnl-*` rules to `app/styles/dashboard.css` for the fixed layout treatment. They must use existing `--card`, `--card-solid`, `--text-*`, `--green`, `--red`, `--gray-bg`, and `--hairline*` tokens.
- Positive profit uses `--green`; losses use `--red`; neutral financial text uses `--text-1` and `--text-2`.
- Keep all visual changes CSS-only or presentation-only. No API, data-shape, or interaction changes.

## Verification

- Add a focused regression test only if the existing P&L screen test setup can assert the themed class/value contract without mocking the full dashboard.
- Run the focused test, typecheck, lint, and build after implementation.
- Review the rendered page in dark mode at desktop and phone widths before completion.
