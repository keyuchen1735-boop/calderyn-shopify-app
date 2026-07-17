// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutPlatform } from "../storefront.checkout";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const stripe = vi.hoisted(() => ({
  confirmPayment: vi.fn(async () => ({})),
  elements: {},
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => ({})),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => children,
  PaymentElement: () => <div aria-label="Card details" />,
  useElements: () => stripe.elements,
  useStripe: () => ({ confirmPayment: stripe.confirmPayment }),
}));

const loaded = {
  publishableKey: "pk_test_checkout",
  paymentsReady: true,
  origin: "https://shop.example",
  prefill: null,
  summary: {
    lines: [
      {
        id: "line-1",
        title: "Field Jacket",
        quantity: 1,
        unitPriceCents: 3998,
      },
    ],
    subtotalCents: 3998,
    currency: "usd",
  },
};

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function input(host: HTMLElement, name: string): HTMLInputElement {
  return host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}

function submit(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  act(() => button!.click());
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("CheckoutPlatform", () => {
  it("drives address, delivery, consent, checkout creation, and Stripe confirmation", async () => {
    const submissions: Array<Record<string, string>> = [];
    const router = createMemoryRouter(
      [
        {
          path: "/storefront/checkout",
          element: <CheckoutPlatform loaded={loaded} />,
          action: async ({ request }) => {
            const fields = Object.fromEntries(
              [...(await request.formData()).entries()].map(([key, value]) => [
                key,
                String(value),
              ]),
            );
            submissions.push(fields);
            if (fields.intent === "quote") {
              return Response.json({
                shippingOptions: [
                  {
                    service: "UPS::GROUND",
                    label: "UPS Ground",
                    amountCents: 599,
                    deliveryEarliest: "2026-07-20",
                    deliveryLatest: "2026-07-22",
                  },
                  {
                    service: "UPS::EXPRESS",
                    label: "UPS Express",
                    amountCents: 999,
                    deliveryEarliest: "2026-07-18",
                    deliveryLatest: "2026-07-18",
                  },
                ],
                optionsCurrency: "usd",
              });
            }
            return Response.json({
              clientSecret: "pi_checkout_secret_test",
              confirmationToken: "confirmation-token",
              subtotalCents: 3998,
              shippingCents: 999,
              taxCents: 360,
              totalCents: 5357,
              currency: "usd",
              shippingService: "UPS Express",
              deliveryEarliest: "2026-07-18",
              deliveryLatest: "2026-07-18",
            });
          },
        },
      ],
      { initialEntries: ["/storefront/checkout"] },
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<RouterProvider router={router} />));

    input(host, "email").value = "buyer@example.test";
    input(host, "name").value = "Ada Buyer";
    input(host, "line1").value = "1 Market Street";
    input(host, "city").value = "San Francisco";
    input(host, "region").value = "CA";
    input(host, "postal").value = "94105";
    submit(host, "Continue to shipping");

    await waitFor(() => expect(host.textContent).toContain("UPS Express"));
    expect(submissions).toEqual([
      expect.objectContaining({
        intent: "quote",
        email: "buyer@example.test",
        line1: "1 Market Street",
        country: "US",
      }),
    ]);

    const express = host.querySelector<HTMLInputElement>(
      'input[value="UPS::EXPRESS"]',
    )!;
    express.click();
    expect(express.checked).toBe(true);
    submit(host, "Continue to payment");
    await act(async () => undefined);
    expect(submissions).toHaveLength(1);

    input(host, "tos").click();
    input(host, "privacy").click();
    submit(host, "Continue to payment");

    await waitFor(() => expect(host.textContent).toContain("Pay $53.57"));
    expect(submissions[1]).toEqual(
      expect.objectContaining({
        intent: "pay",
        email: "buyer@example.test",
        shippingService: "UPS::EXPRESS",
        tos: "on",
        privacy: "on",
      }),
    );

    submit(host, "Pay $53.57");
    await waitFor(() => expect(stripe.confirmPayment).toHaveBeenCalledOnce());
    expect(stripe.confirmPayment).toHaveBeenCalledWith({
      elements: stripe.elements,
      confirmParams: {
        return_url:
          "https://shop.example/storefront/checkout/confirmation/confirmation-token",
      },
    });

    act(() => root.unmount());
  });
});
