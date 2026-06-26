// Render characterization tests for the redesigned onboarding wizard.
//
// Renders the real route component (real Polaris, real providerPaired-derived
// `paired` booleans from the loader) with mocked Remix data hooks, then inspects
// the emitted HTML for each step: the right screen, the live-shop badge, seeded
// guardrail inputs, per-provider pairing, the connect step's Skip-vs-Continue
// label, and the dev bypass. The redesign drives navigation through useSubmit +
// onClick (no <form>s), so the click→intent wiring is covered separately by
// onboarding-action.test.ts; here we lock what the SSR output renders.

import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";

const fixture = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

vi.mock("@remix-run/react", () => {
  const Form = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement("form", rest, children);
  const noop = () => {};
  return {
    Form,
    useLoaderData: () => fixture.data,
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
    useSearchParams: () => [new URLSearchParams("host=test-host")],
    useSubmit: () => noop,
    // Both the connect fetcher and the status-poll fetcher resolve to this stub;
    // SSR never runs the effects/handlers that call submit/load.
    useFetcher: () => ({ state: "idle", data: undefined, submit: noop, load: noop, Form }),
  };
});

vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({ calderynClient: () => ({}) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock registration
import { AppProvider } from "@shopify/polaris";
// eslint-disable-next-line import/first
import en from "@shopify/polaris/locales/en.json";
// eslint-disable-next-line import/first
import Onboarding from "../app.onboarding";

type Paired = { google: boolean; meta: boolean; tiktok: boolean; quickbooks: boolean };
const NONE: Paired = { google: false, meta: false, tiktok: false, quickbooks: false };

function loaderData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: 0,
    shopDomain: "acme.myshopify.com",
    shopName: "Acme",
    shopLive: true,
    guardrails: null,
    paired: NONE,
    consent: false,
    error: null,
    devBypass: false,
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}): string {
  fixture.data = loaderData(overrides);
  return renderToString(createElement(AppProvider, { i18n: en }, createElement(Onboarding)));
}

describe("onboarding wizard — render", () => {
  it("step 0 (shop): a live Admin check shows the real connected badge", () => {
    const html = render({ step: 0, shopLive: true });
    expect(html).toContain("Calderyn is connected to your store");
    expect(html).toContain("Connected");
    expect(html).toContain("Get started");
  });

  it("step 0 (shop): a failed live check shows a non-fake checking state, not Connected", () => {
    const html = render({ step: 0, shopLive: false });
    expect(html).toContain("Connecting to your store");
    expect(html).toContain("Checking");
    // The badge must NOT claim a confirmed connection when the live check failed.
    expect(html).not.toContain(">Connected<");
  });

  it("step 1 (guardrails): renders the two limits, seeded from defaults", () => {
    const html = render({ step: 1, guardrails: null });
    expect(html).toContain("Set your limits");
    expect(html).toContain("Spend at most per day");
    expect(html).toContain("Ask me before any change over");
    // Seeded from DEFAULT_GUARDRAILS ($2,500/day, $1,000/action), shown with
    // thousands separators by the grouped text inputs.
    expect(html).toContain('value="2,500"');
    expect(html).toContain('value="1,000"');
  });

  it("step 1 (guardrails): seeds saved values when present", () => {
    const html = render({
      step: 1,
      guardrails: { daily_action_budget_cents: 50000, dollar_cap_cents: 7500 },
    });
    expect(html).toContain('value="500"');
    expect(html).toContain('value="75"');
  });

  it("step 2 (connect): lists all four providers and offers Skip when none connected", () => {
    const html = render({ step: 2, paired: NONE });
    expect(html).toContain("Connect your accounts");
    expect(html).toContain("Google Ads");
    expect(html).toContain("Meta Ads");
    expect(html).toContain("TikTok Ads");
    expect(html).toContain("QuickBooks");
    // Nothing connected → the primary action is a skip (which opens the confirm modal).
    expect(html).toContain("Skip for now");
    expect(html).not.toContain("Continue");
  });

  it("step 2 (connect): a paired provider shows Connected and unlocks Continue", () => {
    // The loader resolves providerPaired (incl. pending) to a boolean before render.
    const html = render({ step: 2, paired: { ...NONE, meta: true } });
    expect(html).toContain("Connected");
    // With at least one connected, the primary action becomes Continue, not Skip.
    expect(html).toContain("Continue");
    expect(html).not.toContain("Skip for now");
  });

  it("step 3 (consent): renders the opt-in comparison checkbox", () => {
    const html = render({ step: 3, consent: false });
    expect(html).toContain("See how you compare");
    expect(html).toContain("Add my store to the comparison");
    expect(html).toContain("Continue");
    expect(html).toContain("Back");
  });

  it("step 4 (complete): renders the finish CTA", () => {
    const html = render({ step: 4 });
    expect(html).toContain("You");
    expect(html).toContain("all set");
    expect(html).toContain("Open dashboard");
  });

  it("hides the dev skip-setup shortcut unless the bypass flag is on", () => {
    expect(render({ step: 0, devBypass: false })).not.toContain("Skip setup");
    expect(render({ step: 0, devBypass: true })).toContain("Skip setup");
  });

  it("never shows the dev shortcut on the final step", () => {
    expect(render({ step: 4, devBypass: true })).not.toContain("Skip setup");
  });
});
