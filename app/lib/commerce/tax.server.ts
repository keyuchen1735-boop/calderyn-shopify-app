// app/lib/commerce/tax.server.ts
// Stripe Tax wrapper — the single tax source for every surface. We are already on Stripe, so
// no new vendor. Returns integer cents. Throws on a Stripe error (rule 12: a wrong/zero tax in
// chat is unrecoverable, so a tax failure must fail the quote, not silently zero the tax).
//
// ONE deliberate exception: `stripe_tax_inactive` is a CONFIG state, not a transient failure —
// the account simply hasn't activated Stripe Tax. Tax is optional merchant setup on every major
// commerce platform; hard-failing the quote here would kill checkout for every store until the
// operator flips a Stripe dashboard switch. Quote $0 tax, loudly, so the sale proceeds and the
// gap is visible in logs. Every OTHER Stripe error still fails the quote.
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getStripe } from "~/lib/payments/stripe.server";

function isStripeTaxInactive(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "stripe_tax_inactive"
  );
}

export interface TaxInput {
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  destination: Address;
}

export async function calculateTax(input: TaxInput): Promise<number> {
  try {
    const calc = await getStripe().tax.calculations.create({
      currency: input.currency,
      line_items: [{ amount: input.subtotalCents, reference: "subtotal", tax_behavior: "exclusive" }],
      shipping_cost: { amount: input.shippingCents },
      customer_details: {
        address: {
          line1: input.destination.street1,
          line2: input.destination.street2,
          city: input.destination.city,
          state: input.destination.state,
          postal_code: input.destination.zip,
          country: input.destination.country,
        },
        address_source: "shipping",
      },
    });
    return calc.tax_amount_exclusive;
  } catch (err) {
    if (isStripeTaxInactive(err)) {
      console.error(
        "[tax] Stripe Tax is not activated on this account — quoting $0 tax so checkout proceeds. " +
          "Activate it at https://dashboard.stripe.com/tax to collect tax.",
      );
      return 0;
    }
    throw err;
  }
}
