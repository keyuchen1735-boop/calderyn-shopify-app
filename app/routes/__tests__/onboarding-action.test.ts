import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { action, loader } from "../app.onboarding";

// Spies for the calderyn client boundaries; the real route logic runs against them.
const {
  getStateSpy,
  advanceSpy,
  guardrailsGetSpy,
  guardrailsUpdateSpy,
  integrationsListSpy,
  startOAuthSpy,
} = vi.hoisted(() => ({
  getStateSpy: vi.fn(),
  advanceSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
  guardrailsUpdateSpy: vi.fn(),
  integrationsListSpy: vi.fn(),
  startOAuthSpy: vi.fn(),
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
    InlineGrid: Stub,
    InlineStack: Stub,
    Page: Stub,
    Text: Stub,
    TextField: Stub,
  };
});
vi.mock("~/lib/toast", () => ({ useActionToast: () => {} }));
vi.mock("~/components/calderyn", () => ({ GuardrailMeter: () => null }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
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
  ]) {
    spy.mockReset();
  }
  advanceSpy.mockResolvedValue(undefined);
});

describe("onboarding action — step advancement", () => {
  it("advances to the requested step and reports ok", async () => {
    const res = await callAction(postRequest({ intent: "advance", step: "3" }));
    const body = (await res.json()) as { ok: boolean };

    expect(body.ok).toBe(true);
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(advanceSpy).toHaveBeenCalledWith(3, expect.anything());
  });
});

describe("onboarding action — guardrails", () => {
  it("saves guardrails in cents, then advances, then confirms with a toast", async () => {
    guardrailsUpdateSpy.mockResolvedValue({});

    const res = await callAction(
      postRequest({
        intent: "save_guardrails",
        step: "2",
        budget: "2500",
        cap: "1000",
        cooldown: "30",
      }),
    );
    const body = (await res.json()) as { ok: boolean; toast?: { message: string } };

    expect(body.ok).toBe(true);
    expect(body.toast?.message).toBe("Guardrails saved");
    expect(guardrailsUpdateSpy).toHaveBeenCalledWith(
      {
        daily_action_budget_cents: 250000,
        dollar_cap_cents: 100000,
        cooldown_minutes: 30,
      },
      expect.anything(),
    );
    // The step only advances once the save succeeded.
    expect(advanceSpy).toHaveBeenCalledWith(2, expect.anything());
    expect(guardrailsUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
      advanceSpy.mock.invocationCallOrder[0],
    );
  });

  it("clamps negative guardrail values to zero instead of persisting them", async () => {
    guardrailsUpdateSpy.mockResolvedValue({});

    await callAction(
      postRequest({
        intent: "save_guardrails",
        step: "2",
        budget: "-50",
        cap: "-1",
        cooldown: "-10",
      }),
    );

    expect(guardrailsUpdateSpy).toHaveBeenCalledWith(
      { daily_action_budget_cents: 0, dollar_cap_cents: 0, cooldown_minutes: 0 },
      expect.anything(),
    );
  });

  it("does NOT advance the step when the guardrail save fails", async () => {
    guardrailsUpdateSpy.mockRejectedValue(
      Object.assign(new Error("guardrails.update: boom"), { code: "ERROR", status: 500 }),
    );

    const res = await callAction(
      postRequest({ intent: "save_guardrails", step: "2", budget: "100", cap: "50", cooldown: "30" }),
    );
    const body = (await res.json()) as { ok: boolean; toast?: { isError?: boolean } };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.toast?.isError).toBe(true);
    expect(advanceSpy).not.toHaveBeenCalled();
  });
});

describe("onboarding action — integration connect", () => {
  it("starts OAuth for the chosen provider, forwarding the embedded host param", async () => {
    startOAuthSpy.mockResolvedValue({ redirectUrl: "https://accounts.google.com/o/oauth2/auth?x=1" });

    const res = await callAction(
      postRequest(
        { intent: "connect_integration", provider: "google" },
        "http://localhost/app/onboarding?host=abc123",
      ),
    );

    expect(startOAuthSpy).toHaveBeenCalledWith("google", "abc123");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://accounts.google.com/o/oauth2/auth?x=1");
  });

  it("surfaces a not-configured provider as an error toast instead of redirecting", async () => {
    startOAuthSpy.mockRejectedValue(
      Object.assign(new Error("Meta OAuth is not configured"), {
        code: "META_NOT_CONFIGURED",
        status: 500,
      }),
    );

    const res = await callAction(postRequest({ intent: "connect_integration", provider: "meta" }));
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

describe("onboarding action — finish and unknown intents", () => {
  it("marks onboarding complete and redirects to the dashboard", async () => {
    const res = await callAction(postRequest({ intent: "finish" }));

    // 8 steps total; the client clamps to the final "complete" step server-side.
    expect(advanceSpy).toHaveBeenCalledWith(8, expect.anything());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");
  });

  it("rejects an unknown intent with 400 and touches nothing", async () => {
    const res = await callAction(postRequest({ intent: "self_destruct" }));
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
  it("assembles step, guardrails, and integrations for the current shop", async () => {
    getStateSpy.mockResolvedValue({ step: 2, done: false });
    guardrailsGetSpy.mockResolvedValue({ daily_action_budget_cents: 250000 });
    integrationsListSpy.mockResolvedValue({
      google_ads: { status: "connected" },
    });

    const res = await callLoader();
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.step).toBe(2);
    expect(body.done).toBe(false);
    expect(body.shopDomain).toBe("acme.myshopify.com");
    expect(body.guardrails).toEqual({ daily_action_budget_cents: 250000 });
    expect(body.integrations).toEqual({ google_ads: { status: "connected" } });
    expect(body.error).toBeNull();
  });

  it("fails soft when the backend is unreachable: step 0, visible error, no throw", async () => {
    getStateSpy.mockRejectedValue(
      Object.assign(new Error("shops lookup failed"), { code: "ERROR", status: 500 }),
    );
    guardrailsGetSpy.mockResolvedValue(null);
    integrationsListSpy.mockResolvedValue({});

    const res = await callLoader();
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.step).toBe(0);
    expect(body.guardrails).toBeNull();
    expect(body.error).toEqual({ code: "ERROR", message: "shops lookup failed" });
  });

  it("keeps the dev skip-setup bypass OFF unless ONBOARDING_DEV_BYPASS is exactly \"true\"", async () => {
    getStateSpy.mockResolvedValue({ step: 0, done: false });
    guardrailsGetSpy.mockResolvedValue(null);
    integrationsListSpy.mockResolvedValue({});

    const off = (await (await callLoader()).json()) as { devBypass: boolean };
    expect(off.devBypass).toBe(false);

    vi.stubEnv("ONBOARDING_DEV_BYPASS", "true");
    vi.resetModules();
    try {
      const fresh = await import("../app.onboarding");
      const res = await fresh.loader({
        request: new Request("http://localhost/app/onboarding"),
      } as unknown as LoaderFunctionArgs);
      const on = (await res.json()) as { devBypass: boolean };
      expect(on.devBypass).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
