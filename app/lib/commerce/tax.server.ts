// app/lib/commerce/tax.server.ts
// Stripe Tax wrapper — the single tax source for every surface. We are already on Stripe, so
// no new vendor. Returns integer cents. Throws on a Stripe error (rule 12: a wrong/zero tax in
// chat is unrecoverable, so a tax failure must fail the quote, not silently zero the tax).
import type { Address } from "~/lib/ship-cost/adapters/rate-quote";
import { getStripe } from "~/lib/payments/stripe.server";

export interface TaxInput {
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  destination: Address;
}

export async function calculateTax(input: TaxInput): Promise<number> {
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
}
