import { describe, it, expect, vi } from "vitest";
import { ASSISTANT_TOOLS, EXTERNAL_TOOLS, makeToolDispatcher } from "../tools.server";
import { CalderynError } from "../../calderyn.server";
import type { CalderynClient } from "../../calderyn.server";
import * as commerceTools from "../commerce-tools.server";
import * as executeModule from "../actions/execute.server";

vi.mock("../commerce-tools.server", () => ({
  COMMERCE_TOOL_NAMES: ["get_catalog", "create_quote", "get_quote", "place_order"],
  COMMERCE_TOOLS: [],
  handleCommerceTool: vi.fn(async () => ({
    content: JSON.stringify({ order_id: "ord1", pay_url: "https://stripe/cs_1", status: "awaiting_payment" }),
  })),
}));

// tools.server.ts pulls the real registry to build ASSISTANT_TOOLS + the
// registry-name set; stub it to a couple of fake actions so this dispatch-
// logic test never needs the real domain modules (they reach app/shopify.server.ts,
// which throws without SHOPIFY_API_SECRET — same reason execute.test.ts mocks
// import/run.server).
vi.mock("../actions/registry.server", () => ({
  ASSISTANT_ACTIONS: [{ name: "pause_campaign" }, { name: "issue_refund" }],
  generatedWriteTools: () => [
    { name: "pause_campaign", description: "Pause a campaign.", input_schema: { type: "object", properties: {} } },
    { name: "issue_refund", description: "Issue a refund.", input_schema: { type: "object", properties: {} } },
  ],
}));

vi.mock("../actions/execute.server", () => ({
  runRegistryAction: vi.fn(async () => ({
    content: JSON.stringify({ ok: true, receipt: { action: "pause_campaign" } }),
    receipt: { action: "pause_campaign", summary: "Paused the campaign", auditId: "a1", undoable: true },
  })),
}));

function fakeClient(): {
  client: CalderynClient;
  listSpy: ReturnType<typeof vi.fn>;
  getSpy: ReturnType<typeof vi.fn>;
} {
  const listSpy = vi.fn(async () => [{ id: "a1" }, { id: "a2" }]);
  const getSpy = vi.fn(async (id: string) => {
    if (id === "missing") {
      throw new CalderynError({ code: "ALERT_NOT_FOUND", status: 404, message: "nope" });
    }
    return {
      id,
      detector_id: "campaign_below_breakeven",
      title: "Below breakeven",
      dollar_impact: 123400,
    };
  });
  const client = {
    alerts: { list: listSpy, get: getSpy },
    campaigns: { list: async () => [] },
    skus: { list: async () => [] },
    audit: { list: async () => [] },
    guardrails: { get: async () => ({}) },
    integrations: { list: async () => ({}) },
  } as unknown as CalderynClient;
  return { client, listSpy, getSpy };
}

describe("ASSISTANT_TOOLS", () => {
  it("exposes read tools + flag_alert + generated registry tools, with propose_action gone", () => {
    const names = ASSISTANT_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "flag_alert",
        "get_alert",
        "get_guardrails",
        "list_alerts",
        "list_audit",
        "list_campaigns",
        "list_integrations",
        "list_skus",
        "pause_campaign",
        "issue_refund",
      ].sort(),
    );
    expect(names).not.toContain("propose_action");
  });
});

describe("EXTERNAL_TOOLS", () => {
  it("never includes registry write tools", () => {
    const names = EXTERNAL_TOOLS.map((t) => t.name);
    expect(names).not.toContain("pause_campaign");
    expect(names).not.toContain("issue_refund");
    expect(names).toContain("flag_alert");
  });
});

describe("makeToolDispatcher", () => {
  it("list_alerts maps detector_id input to the client 'detector' filter", async () => {
    const { client, listSpy } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("list_alerts", { detector_id: "cogs_drift", status: "open" }, "tu-0");
    expect(listSpy).toHaveBeenCalledWith({ status: "open", severity: undefined, detector: "cogs_drift" });
    expect(JSON.parse(res.content).alerts).toHaveLength(2);
    expect(res.isError).toBeFalsy();
  });

  it("flag_alert acknowledges via the injected callback and reports the flagged alert", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(flagAlert).toHaveBeenCalledWith("a1");
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).flagged).toEqual({
      id: "a1",
      title: "Below breakeven",
      status: "acknowledged",
    });
  });

  it("flag_alert errors when the surface provides no flag callback", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_UNAVAILABLE");
  });

  it("flag_alert reports a no-op acknowledge as FLAG_FAILED", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client, { flagAlert: async () => false });
    const res = await dispatch("flag_alert", { alert_id: "a1" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_FAILED");
  });

  it("flag_alert never flags an unknown alert (shop-scoped get throws first)", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "missing" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ALERT_NOT_FOUND");
    expect(flagAlert).not.toHaveBeenCalled();
  });

  it("returns COMMERCE_UNAVAILABLE when a commerce tool is called with no commerceCtx", async () => {
    const dispatch = makeToolDispatcher({} as never);
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" }, "tu-0");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("COMMERCE_UNAVAILABLE");
  });

  it("routes a commerce tool to the handler when commerceCtx is present (no scope needed)", async () => {
    vi.mocked(commerceTools.handleCommerceTool).mockClear();
    const ctx = { shopId: "s1", clientId: "c1" };
    const dispatch = makeToolDispatcher({} as never, { commerceCtx: ctx });
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" }, "tu-0");
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).pay_url).toBe("https://stripe/cs_1");
    expect(vi.mocked(commerceTools.handleCommerceTool)).toHaveBeenCalledWith(
      "place_order",
      { quote_id: "q1", email: "b@x.com" },
      ctx,
    );
  });

  it("returns ACTIONS_UNAVAILABLE for a registry action name without actionCtx", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("pause_campaign", { campaign_id: "c1" }, "tu-1");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ACTIONS_UNAVAILABLE");
    expect(vi.mocked(executeModule.runRegistryAction)).not.toHaveBeenCalled();
  });

  it("dispatches a registry action to runRegistryAction with a minted idempotency key", async () => {
    vi.mocked(executeModule.runRegistryAction).mockClear();
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client, {
      actionCtx: { shopId: "shop-1", conversationId: "conv-1" },
    });
    const res = await dispatch("pause_campaign", { campaign_id: "c1" }, "tu-9");
    expect(vi.mocked(executeModule.runRegistryAction)).toHaveBeenCalledWith(
      "pause_campaign",
      { campaign_id: "c1" },
      { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "assistant:conv-1:tu-9" },
    );
    expect(res.isError).toBeFalsy();
    expect(res.receipt?.auditId).toBe("a1");
  });
});
