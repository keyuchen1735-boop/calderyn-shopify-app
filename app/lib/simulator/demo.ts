// app/lib/simulator/demo.ts
//
// A built-in sample behavior model so the simulator can produce a full teardown
// WITHOUT calling the Anthropic API (no ANTHROPIC_API_KEY needed). Used by the
// "Run sample teardown" demo path. Pure data — safe to import anywhere.
import type { BehaviorModel } from "./types";

export const DEMO_MODEL: BehaviorModel = {
  storeSummary:
    "Sample teardown — a premium accessories store with a flat $9.95 shipping fee revealed late in checkout.",
  shipping: { amount: 9.95, currency: "USD", estimated: false },
  archetypes: [
    {
      id: "deal-hunter",
      name: "Deal-hunter",
      weight: 0.3,
      advance: {
        landed: 0.95,
        viewed_product: 0.85,
        added_to_cart: 0.8,
        started_checkout: 0.9,
        shipping_reveal: 0.18,
        bought: 0,
      },
      dropReason: { shipping_reveal: "$9.95 shipping wiped out the deal." },
    },
    {
      id: "gift-buyer",
      name: "Gift-buyer",
      weight: 0.22,
      advance: {
        landed: 0.92,
        viewed_product: 0.82,
        added_to_cart: 0.78,
        started_checkout: 0.88,
        shipping_reveal: 0.3,
        bought: 0,
      },
      dropReason: { shipping_reveal: "No express option to guarantee it arrives in time." },
    },
    {
      id: "bargain-browser",
      name: "Bargain browser",
      weight: 0.14,
      advance: {
        landed: 0.9,
        viewed_product: 0.8,
        added_to_cart: 0.76,
        started_checkout: 0.85,
        shipping_reveal: 0.25,
        bought: 0,
      },
      dropReason: { shipping_reveal: "Shipping pushed it over my budget." },
    },
    {
      id: "skeptic-first-timer",
      name: "Skeptical first-timer",
      weight: 0.12,
      advance: {
        landed: 0.85,
        viewed_product: 0.55,
        added_to_cart: 0.6,
        started_checkout: 0.8,
        shipping_reveal: 0.6,
        bought: 0,
      },
      dropReason: { viewed_product: "No reviews or returns policy — didn't trust it." },
    },
    {
      id: "impatient-mobile",
      name: "Impatient mobile shopper",
      weight: 0.12,
      advance: {
        landed: 0.55,
        viewed_product: 0.65,
        added_to_cart: 0.6,
        started_checkout: 0.7,
        shipping_reveal: 0.6,
        bought: 0,
      },
      dropReason: { landed: "Didn't immediately see why this was worth it." },
    },
    {
      id: "loyal-repeat",
      name: "Loyal repeat-buyer",
      weight: 0.1,
      advance: {
        landed: 0.96,
        viewed_product: 0.9,
        added_to_cart: 0.9,
        started_checkout: 0.95,
        shipping_reveal: 0.92,
        bought: 0,
      },
      dropReason: {},
    },
  ],
  findings: [
    {
      id: "shipping-shock",
      severity: "critical",
      title: "Shipping cost shock",
      stage: "shipping_reveal",
      personaIds: ["deal-hunter", "gift-buyer", "bargain-browser"],
      fix: "Add a free-shipping threshold bar and show shipping on the product page.",
    },
    {
      id: "thin-product-info",
      severity: "high",
      title: "Thin product information",
      stage: "viewed_product",
      personaIds: ["skeptic-first-timer"],
      fix: "Add returns policy and review snippets above the fold.",
    },
    {
      id: "weak-mobile-hero",
      severity: "low",
      title: "Weak mobile hero",
      stage: "landed",
      personaIds: ["impatient-mobile"],
      fix: "Sharpen the headline and primary CTA for first-time mobile visitors.",
    },
  ],
};
