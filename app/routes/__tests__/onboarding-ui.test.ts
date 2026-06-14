// Button-wiring characterization tests for the onboarding wizard.
//
// Renders the real route component (real Polaris, real providerPaired mapping)
// with mocked Remix data hooks, then inspects the emitted <form>s: which
// intent each button submits, which hidden step it carries, and whether the
// required-OAuth Continue gate is closed. These exist because every onboarding
// button is a hidden-input form — a typo'd intent or step renders fine and
// fails only when clicked.

import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";

const fixture = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
}));

vi.mock("@remix-run/react", () => {
  // Spread all props so the mock keeps the real Form's pass-through behavior
  // (style, id, …) instead of silently dropping them.
  const Form = ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) =>
    createElement("form", rest, children);
  return {
    Form,
    useLoaderData: () => fixture.data,
    useActionData: () => undefined,
    useNavigation: () => ({ state: "idle" }),
    useSearchParams: () => [new URLSearchParams("host=test-host")],
    // The OAuth connect button posts through its own fetcher so the provider
    // URL comes back as data instead of 302ing the iframe.
    useFetcher: () => ({ state: "idle", data: undefined, Form }),
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

function loaderData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    step: 0,
    done: false,
    shopDomain: "acme.myshopify.com",
    guardrails: null,
    integrations: {},
    consent: false,
    error: null,
    devBypass: false,
    ...overrides,
  };
}

function render(overrides: Record<string, unknown> = {}): string {
  fixture.data = loaderData(overrides);
  return renderToString(
    createElement(AppProvider, { i18n: en }, createElement(Onboarding)),
  );
}

/** Split rendered HTML into forms, each with its hidden fields and button states. */
function formsOf(html: string): Array<{
  fields: Record<string, string>;
  buttonDisabled: boolean;
}> {
  return [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((m) => {
    const inner = m[1];
    const fields: Record<string, string> = {};
    for (const inp of inner.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
      fields[inp[1]] = inp[2];
    }
    // Polaris 12 renders disabled buttons as aria-disabled="true", not the
    // native disabled attribute (verified against @shopify/polaris 12.27.0).
    return { fields, buttonDisabled: /<button[^>]*aria-disabled="true"[^>]*>/.test(inner) };
  });
}

/** Max <form> nesting depth. Browsers drop a <form> opened inside another
 * form, silently re-parenting its inputs/buttons into the outer form. */
function maxFormDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const tag of html.matchAll(/<form\b|<\/form>/g)) {
    depth += tag[0] === "</form>" ? -1 : 1;
    max = Math.max(max, depth);
  }
  return max;
}

describe("onboarding wizard — button wiring", () => {
  it("step 0 (shop): Continue submits advance to step 1", () => {
    const forms = formsOf(render({ step: 0 }));

    expect(forms).toHaveLength(1);
    expect(forms[0].fields).toEqual({ intent: "advance", step: "1" });
    expect(forms[0].buttonDisabled).toBe(false);
  });

  it("step 1 (guardrails): Back and Save are separate, non-nested forms", () => {
    const html = render({ step: 1 });

    // A nested form would make the Back button silently submit save_guardrails.
    expect(maxFormDepth(html)).toBe(1);

    const intents = formsOf(html).map((f) => f.fields);
    expect(intents).toContainEqual({ intent: "advance", step: "0" });
    expect(intents).toContainEqual({
      intent: "save_guardrails",
      step: "2",
      budget: "2500",
      cap: "1000",
      cooldown: "30",
    });
  });

  it("step 2 (google, not connected): offers Connect and Skip; Continue stays gated", () => {
    const forms = formsOf(render({ step: 2, integrations: {} }));

    const connect = forms.find((f) => f.fields.intent === "connect_integration");
    expect(connect?.fields.provider).toBe("google");
    expect(connect?.buttonDisabled).toBe(false);

    // Back (advance to 1) stays open. Forward there are TWO advance-to-3 forms:
    // "Skip for now" (enabled) and Continue (locked until connected) — every
    // connector is skippable so a broken provider can't dead-end onboarding (#56).
    const advances = forms.filter((f) => f.fields.intent === "advance");
    expect(advances.find((f) => f.fields.step === "1")?.buttonDisabled).toBe(false);
    const forward = advances.filter((f) => f.fields.step === "3");
    expect(forward.map((f) => f.buttonDisabled).sort()).toEqual([false, true]);
  });

  it("step 3 (meta): recognizes a pairing stored under the meta_ads kind and unlocks Continue", () => {
    const forms = formsOf(
      render({ step: 3, integrations: { meta_ads: { status: "connected" } } }),
    );

    // Paired: no Connect button, and Continue (advance to 4) is enabled.
    expect(forms.some((f) => f.fields.intent === "connect_integration")).toBe(false);
    const next = forms.find((f) => f.fields.intent === "advance" && f.fields.step === "4");
    expect(next?.buttonDisabled).toBe(false);
  });

  it("step 3 (meta): a pending first sync still counts as paired", () => {
    const forms = formsOf(
      render({ step: 3, integrations: { meta_ads: { status: "pending" } } }),
    );

    expect(forms.some((f) => f.fields.intent === "connect_integration")).toBe(false);
  });

  it("step 4 (tiktok, not connected): offers Connect and Skip; Continue gated", () => {
    const forms = formsOf(render({ step: 4, integrations: {} }));

    const connect = forms.find((f) => f.fields.intent === "connect_integration");
    expect(connect?.fields.provider).toBe("tiktok");

    // Skip (enabled) and Continue (gated) both advance to 5.
    const toNext = forms.filter((f) => f.fields.intent === "advance" && f.fields.step === "5");
    expect(toNext).toHaveLength(2);
    expect(toNext.map((f) => f.buttonDisabled).sort()).toEqual([false, true]);
  });

  it("step 5 (quickbooks, not connected): offers Skip; Continue gated like every connector", () => {
    const forms = formsOf(render({ step: 5, integrations: {} }));

    const connect = forms.find((f) => f.fields.intent === "connect_integration");
    expect(connect?.fields.provider).toBe("quickbooks");

    // Skip (enabled) and Continue (gated) both advance to 6.
    const toNext = forms.filter((f) => f.fields.intent === "advance" && f.fields.step === "6");
    expect(toNext).toHaveLength(2);
    expect(toNext.map((f) => f.buttonDisabled).sort()).toEqual([false, true]);
  });

  it("step 7 (consent): Continue submits save_consent carrying the checkbox value; Back to creative", () => {
    const forms = formsOf(render({ step: 7, consent: false }));

    const save = forms.find((f) => f.fields.intent === "save_consent");
    expect(save?.fields).toEqual({ intent: "save_consent", step: "8", consent: "false" });
    expect(forms).toContainEqual(
      expect.objectContaining({ fields: { intent: "advance", step: "6" } }),
    );
  });

  it("step 8 (complete): Open dashboard submits finish, Back returns to consent", () => {
    const forms = formsOf(render({ step: 8 }));

    const finish = forms.find((f) => f.fields.intent === "finish");
    expect(finish?.buttonDisabled).toBe(false);
    expect(forms).toContainEqual(
      expect.objectContaining({ fields: { intent: "advance", step: "7" } }),
    );
  });

  it("never nests forms on any step — a nested form re-parents its buttons", () => {
    for (let step = 0; step < 9; step++) {
      const html = render({ step, devBypass: true });
      expect(maxFormDepth(html), `form nesting on step ${step}`).toBe(1);
    }
  });

  it("hides the dev skip-setup shortcut unless the bypass flag is on", () => {
    const offForms = formsOf(render({ step: 0, devBypass: false }));
    expect(offForms.some((f) => f.fields.intent === "finish")).toBe(false);

    const onForms = formsOf(render({ step: 0, devBypass: true }));
    expect(onForms.some((f) => f.fields.intent === "finish")).toBe(true);
  });
});
