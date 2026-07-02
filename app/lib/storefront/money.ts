// Deterministic money formatting for the public storefront. The locale is pinned
// because these strings are server-rendered and then hydrated: with an
// environment-default locale (`undefined`), Node's ICU and the visitor's browser
// can format the same amount differently (e.g. "US$19.99" vs "$19.99"), which
// makes React hydration fail on every priced element.
//
// Formatters are cached per currency: Intl.NumberFormat construction is the
// expensive part and product grids call this once per card per render.
const formatters = new Map<string, Intl.NumberFormat>();

export function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  let fmt = formatters.get(code);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: code });
    formatters.set(code, fmt);
  }
  return fmt.format(cents / 100);
}
