import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { action, loader } from "../app.onboarding";

// Spies for the calderyn client boundaries; the real route logic runs against them.
const {
  getStateSpy,
  advanceSpy,
  guardrailsGetSpy,
  guardrailsUpdateSpy,
  integrationsListSpy,
  startOAuthSpy,
  consentGetSpy,
  consentSetSpy,
} = vi.hoisted(() => ({
  getStateSpy: vi.fn(),
  advanceSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
  guardrailsUpdateSpy: vi.fn(),
  integrationsListSpy: vi.fn(),
  startOAuthSpy: vi.fn(),
  consentGetSpy: vi.fn(),
  consentSetSpy: vi.fn(),
}));

// Stub Polaris so importing the route module doesn't pull the real UI lib.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Badge: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    Checkbox: Stub,
    InlineStack: Stub,
    Modal: Object.assign(Stub, { Section: Stub }),
    Page: Stub,
    Spinner: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));
// The onboarding loader self-heals a missing shops row via provisionShop before
// reading state; stub it so the loader tests don't hit a real Supabase client.
vi.mock("~/lib/supabase.server", () => ({ provisionShop: vi.fn(async () => {}) }));
vi.mock("~/components/calderyn", () => ({ Icon: () => null, GuardrailMeter: () => null }));

// The shopify step's live Admin check calls admin.graphql; the action tests never
// hit the shopify step (step 0), and the one loader test that does is wrapped in a
// try/catch in the route, so a minimal admin stub keeps the module honest.
vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: "acme.myshopify.com" },
      admin: { graphql: async () => ({ json: async () => ({ data: { shop: { name: "Acme" } } }) }) },
    }),
  },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    onboarding: {
      getState: (...a: unknown[]) => getStateSpy(...a),
      advance: (...a: unknown[]) => advanceSpy(...a),
    },
    guardrails: {
      get: (...a: unknown[]) => guardrailsGetSpy(...a),
      update: (...a: unknown[]) => guardrailsUpdateSpy(...a),
    },
    integrations: {
      list: (...a: unknown[]) => integrationsListSpy(...a),
      startOAuth: (...a: unknown[]) => startOAuthSpy(...a),
    },
    consent: {
      get: (...a: unknown[]) => consentGetSpy(...a),
      set: (...a: unknown[]) => consentSetSpy(...a),
    },
  }),
}));

function postRequest(fields: Record<string, string>, url = "http://localhost/app/onboarding"): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new Request(url, { method: "POST", body: fd });
}

function callAction(request: Request) {
  return action({ request } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  for (const spy of [
    getStateSpy,
    advanceSpy,
    guardrailsGetSpy,
    guardrailsUpdateSpy,
    integrationsListSpy,
    startOAuthSpy,
    consentGetSpy,
    consentSetSpy,
  ]) {
    spy.mockReset();
  }
  advanceSpy.mockResolvedValue(undefined);
  consentGetSpy.mockResolvedValue(false);
  consentSetSpy.mockResolvedValue(undefined);
});

describe("onboarding action — step advancement", () => {
  it("advances to the requested step and reports ok", async () => {
    const res = toResponse(await callAction(postRequest({ intent: "advance", step: "3" })));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(advanceSpy).toHaveBeenCalledWith(3, expect.anything());
  });
});

describe("onboarding action — guardrails", () => {
  it("saves guardrails in cents, then advances, then confirms with a toast", async () => {
    guardrailsUpdateSpy.mockResolvedValue({});

    const res = toResponse(await callAction(
      postRequest({
        intent: "save_guardrails",
        step: "2",
        budget: "2500",
        cap: "1000",
      }),
    ));
    const body = (await res.json()) as { ok: boolean; toast?: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast?.message).toBe("Limits saved");
    // The redesigned "Set your limits" step has only budget + cap — cooldown is NOT
    // in the patch, so an existing cooldown stays as the merchant last set it.
    expect(guardrailsUpdateSpy).toHaveBeenCalledWith(
      {
        daily_action_budget_cents: 250000,
        dollar_cap_cents: 100000,
      },
      expect.anything(),
    );
    // The step only advances once the save succeeded.
    expect(advanceSpy).toHaveBeenCalledWith(2, expect.anything());
    expect(guardrailsUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      advanceSpy.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["negative budget/cap", { budget: "-50", cap: "-1", cooldown: "30" }],
    ["zero budget", { budget: "0", cap: "50", cooldown: "30" }],
    ["zero cap", { budget: "100", cap: "0", cooldown: "30" }],
    ["blank budget", { budget: "", cap: "50", cooldown: "30" }],
    ["non-numeric budget", { budget: "abc", cap: "50", cooldown: "30" }],
  ])(
    "rejects %s with a 400 and persists nothing (no silent $0 guardrail)",
    async (_label, fields) => {
      guardrailsUpdateSpy.mockResolvedValue({});

      const res = toResponse(await callAction(postRequest({ intent: "save_guardrails", step: "2", ...fields })));
      const body = (await res.json()) as { ok: boolean; error?: { code: string }; toast?: { isError?: boolean } };

      expect(res.status).toBe(400);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("INVALID_GUARDRAILS");
      expect(body.toast?.isError).toBe(true);
      // The invalid values are never written, and the step does not advance.
      expect(guardrailsUpdateSpy).not.toHaveBeenCalled();
      expect(advanceSpy).not.toHaveBeenCalled();
    },
  );

  it("patches only budget + cap (the step no longer carries cooldown)", async () => {
    guardrailsUpdateSpy.mockResolvedValue({});

    const res = toResponse(await callAction(
      postRequest({ intent: "save_guardrails", step: "2", budget: "100", cap: "50" }),
    ));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(guardrailsUpdateSpy).toHaveBeenCalledWith(
      { daily_action_budget_cents: 10000, dollar_cap_cents: 5000 },
      expect.anything(),
    );
  });

  it("does NOT advance the step when the guardrail save fails", async () => {
    guardrailsUpdateSpy.mockRejectedValue(
      Object.assign(new Error("guardrails.update: boom"), { code: "ERROR", status: 500 }),
    );

    const res = toResponse(await callAction(
      postRequest({ intent: "save_guardrails", step: "2", budget: "100", cap: "50", cooldown: "30" }),
    ));
    const body = (await res.json()) as { ok: boolean; toast?: { isError?: boolean } };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.toast?.isError).toBe(true);
    expect(advanceSpy).not.toHaveBeenCalled();
  });
});

describe("onboarding action — integration connect", () => {
  it("returns the OAuth URL as data (no 302 — the iframe can't load provider pages)", async () => {
    startOAuthSpy.mockResolvedValue({ redirectUrl: "https://accounts.google.com/o/oauth2/auth?x=1" });

    const res = toResponse(await callAction(
      postRequest({ intent: "connect_integration", provider: "google", host: "abc123" }),
    ));
    const body = (await res.json()) as { ok: boolean; redirectUrl?: string };

    // popup=true (3rd arg): the callback lands on /auth/connected; the client opens
    // this URL in a NEW TAB rather than redirecting the embedded iframe.
    expect(startOAuthSpy).toHaveBeenCalledWith("google", "abc123", true);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.redirectUrl).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
  });

  it("passes a null host (and popup=true) when the form omits the host", async () => {
    startOAuthSpy.mockResolvedValue({ redirectUrl: "https://example.com/oauth" });

    await callAction(postRequest({ intent: "connect_integration", provider: "google" }));

    expect(startOAuthSpy).toHaveBeenCalledWith("google", null, true);
  });

  it("surfaces a not-configured provider as an error toast instead of redirecting", async () => {
    startOAuthSpy.mockRejectedValue(
      Object.assign(new Error("Meta OAuth is not configured"), {
        code: "META_NOT_CONFIGURED",
        status: 500,
      }),
    );

    const res = toResponse(await callAction(postRequest({ intent: "connect_integration", provider: "meta" })));
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
      toast?: { isError?: boolean };
    };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("META_NOT_CONFIGURED");
    expect(body.toast?.isError).toBe(true);
  });
});

describe("onboarding action — consent", () => {
  it("persists an opt-in then advances", async () => {
    // Consent is step index 3; Continue advances to "complete" (index 4).
    const res = toResponse(await callAction(postRequest({ intent: "save_consent", step: "4", consent: "true" })));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(consentSetSpy).toHaveBeenCalledWith(true, expect.anything());
    expect(advanceSpy).toHaveBeenCalledWith(4, expect.anything());
    // consent is written before the step advances
    expect(consentSetSpy.mock.invocationCallOrder[0]).toBeLessThan(
      advanceSpy.mock.invocationCallOrder[0],
    );
  });

  it("records a decline (consent=false) and still advances", async () => {
    await callAction(postRequest({ intent: "save_consent", step: "4", consent: "false" }));

    expect(consentSetSpy).toHaveBeenCalledWith(false, expect.anything());
    expect(advanceSpy).toHaveBeenCalledWith(4, expect.anything());
  });
});

describe("onboarding action — finish and unknown intents", () => {
  it("marks onboarding complete and redirects to the dashboard", async () => {
    const res = toResponse(await callAction(postRequest({ intent: "finish" })));

    // 5 steps total; advance clamps the submitted STEPS.length to "complete" server-side.
    expect(advanceSpy).toHaveBeenCalledWith(5, expect.anything());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");
  });

  it("rejects an unknown intent with 400 and touches nothing", async () => {
    const res = toResponse(await callAction(postRequest({ intent: "self_destruct" })));
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("INVALID_INTENT");
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(guardrailsUpdateSpy).not.toHaveBeenCalled();
    expect(startOAuthSpy).not.toHaveBeenCalled();
  });
});

function callLoader(url = "http://localhost/app/onboarding") {
  return loader({ request: new Request(url) } as unknown as LoaderFunctionArgs);
}

describe("onboarding loader", () => {
  it("assembles step, guardrails, and per-provider pairing for the current shop", async () => {
    // step 2 is the connect screen — the loader skips the live Admin shop check there.
    getStateSpy.mockResolvedValue({ step: 2, done: false });
    guardrailsGetSpy.mockResolvedValue({ daily_action_budget_cents: 250000 });
    integrationsListSpy.mockResolvedValue({
      google_ads: { status: "connected" },
    });

    const res = toResponse(await callLoader());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.step).toBe(2);
    expect(body.shopDomain).toBe("acme.myshopify.com");
    expect(body.guardrails).toEqual({ daily_action_budget_cents: 250000 });
    // integrations.list is collapsed to the four onboarding providers' paired booleans.
    expect(body.paired).toEqual({ google: true, meta: false, tiktok: false, quickbooks: false });
    expect(body.error).toBeNull();
  });

  it("fails soft when the backend is unreachable: step 0, visible error, no throw", async () => {
    getStateSpy.mockRejectedValue(
      Object.assign(new Error("shops lookup failed"), { code: "ERROR", status: 500 }),
    );
    guardrailsGetSpy.mockResolvedValue(null);
    integrationsListSpy.mockResolvedValue({});

    const res = toResponse(await callLoader());
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.step).toBe(0);
    expect(body.guardrails).toBeNull();
    expect(body.error).toEqual({ code: "ERROR", message: "shops lookup failed" });
  });

  it("keeps the dev skip-setup bypass OFF unless ONBOARDING_DEV_BYPASS is exactly \"true\"", async () => {
    getStateSpy.mockResolvedValue({ step: 0, done: false });
    guardrailsGetSpy.mockResolvedValue(null);
    integrationsListSpy.mockResolvedValue({});

    const off = (await toResponse(await callLoader()).json()) as { devBypass: boolean };
    expect(off.devBypass).toBe(false);

    vi.stubEnv("ONBOARDING_DEV_BYPASS", "true");
    vi.resetModules();
    try {
      const fresh = await import("../app.onboarding");
      const res = toResponse(await fresh.loader({
        request: new Request("http://localhost/app/onboarding"),
      } as unknown as LoaderFunctionArgs));
      const on = (await res.json()) as { devBypass: boolean };
      expect(on.devBypass).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
