// Shared canonical tax-reduction case used across edit.server.test.ts and
// reduce-line-preview.test.ts: ensures both the backend executor and the client preview formula
// stay synchronized on the exact numbers, so a formula change breaks both tests visibly (not one).
export const REDUCTION_TAX_FIXTURE = {
  subtotalCents: 10000,
  taxCents: 800,
  deltaSubtotal: 2500, // 2 units * 1250 unit_price_cents
  expectedTaxShare: 200, // floor(800 * 2500 / 10000)
  expectedRefund: 2700, // 2500 + 200
};
