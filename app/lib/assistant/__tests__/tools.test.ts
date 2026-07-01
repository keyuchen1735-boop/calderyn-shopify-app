import { describe, it, expect, vi } from "vitest";
import { ASSISTANT_TOOLS, makeToolDispatcher } from "../tools.server";
import { CalderynError } from "../../calderyn.server";
import type { CalderynClient } from "../../calderyn.server";
import * as commerceTools from "../commerce-tools.server";

vi.mock("../commerce-tools.server", () => ({
  COMMERCE_TOOL_NAMES: ["get_catalog", "create_quote", "get_quote", "place_order"],
  COMMERCE_TOOLS: [],
  handleCommerceTool: vi.fn(async () => ({
    content: JSON.stringify({ order_id: "ord1", pay_url: "https://stripe/cs_1", status: "awaiting_payment" }),
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
  it("exposes the expected tool names", () => {
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
        "propose_action",
      ].sort(),
    );
  });
});

describe("makeToolDispatcher", () => {
  it("list_alerts maps detector_id input to the client 'detector' filter", async () => {
    const { client, listSpy } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("list_alerts", { detector_id: "cogs_drift", status: "open" });
    expect(listSpy).toHaveBeenCalledWith({ status: "open", severity: undefined, detector: "cogs_drift" });
    expect(JSON.parse(res.content).alerts).toHaveLength(2);
    expect(res.isError).toBeFalsy();
  });

  it("propose_action returns a draftedAction for a valid alert+kind", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", { alert_id: "a1", action_kind: "pause_campaign" });
    expect(res.isError).toBeFalsy();
    expect(res.draftedAction).toEqual({
      alertId: "a1",
      actionKind: "pause_campaign",
      label: "Pause campaign",
      dollarImpact: 123400,
    });
  });

  it("propose_action rejects a kind not allowed for the detector", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", { alert_id: "a1", action_kind: "exclude_geo" });
    expect(res.isError).toBe(true);
    expect(res.draftedAction).toBeUndefined();
    expect(JSON.parse(res.content).code).toBe("ACTION_NOT_ALLOWED");
  });

  it("propose_action surfaces a missing alert as a tool error", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client);
    const res = await dispatch("propose_action", { alert_id: "missing", action_kind: "pause_campaign" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ALERT_NOT_FOUND");
  });

  it("flag_alert acknowledges via the injected callback and reports the flagged alert", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "a1" });
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
    const res = await dispatch("flag_alert", { alert_id: "a1" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_UNAVAILABLE");
  });

  it("flag_alert reports a no-op acknowledge as FLAG_FAILED", async () => {
    const { client } = fakeClient();
    const dispatch = makeToolDispatcher(client, { flagAlert: async () => false });
    const res = await dispatch("flag_alert", { alert_id: "a1" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("FLAG_FAILED");
  });

  it("flag_alert never flags an unknown alert (shop-scoped get throws first)", async () => {
    const { client } = fakeClient();
    const flagAlert = vi.fn(async () => true);
    const dispatch = makeToolDispatcher(client, { flagAlert });
    const res = await dispatch("flag_alert", { alert_id: "missing" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("ALERT_NOT_FOUND");
    expect(flagAlert).not.toHaveBeenCalled();
  });

  it("returns COMMERCE_UNAVAILABLE when a commerce tool is called with no commerceCtx", async () => {
    const dispatch = makeToolDispatcher({} as never);
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("COMMERCE_UNAVAILABLE");
  });

  it("routes a commerce tool to the handler when commerceCtx is present (no scope needed)", async () => {
    vi.mocked(commerceTools.handleCommerceTool).mockClear();
    const ctx = { shopId: "s1", clientId: "c1" };
    const dispatch = makeToolDispatcher({} as never, { commerceCtx: ctx });
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content).pay_url).toBe("https://stripe/cs_1");
    expect(vi.mocked(commerceTools.handleCommerceTool)).toHaveBeenCalledWith(
      "place_order",
      { quote_id: "q1", email: "b@x.com" },
      ctx,
    );
  });
});
