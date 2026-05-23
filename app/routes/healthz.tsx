import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { calderynClient } from "~/lib/calderyn.server";

const DEMO_SHOP = "calderyn-shop-tester.myshopify.com";

export const loader = async ({ request: _ }: LoaderFunctionArgs) => {
  const started = Date.now();
  const result: Record<string, unknown> = {
    ok: false,
    demo_shop: DEMO_SHOP,
    checks: {} as Record<string, unknown>,
  };

  try {
    const client = calderynClient(DEMO_SHOP);
    const [alerts, audit, campaigns, skus, guardrails] = await Promise.all([
      client.alerts.list({}),
      client.audit.list(),
      client.campaigns.list(),
      client.skus.list(),
      client.guardrails.get(),
    ]);

    const topAlert = [...alerts].sort((a, b) => a.claude_rank - b.claude_rank)[0];

    result.ok = true;
    result.checks = {
      alerts: { count: alerts.length, top: topAlert ? { title: topAlert.title, severity: topAlert.severity, dollar_impact: topAlert.dollar_impact } : null },
      audit: { count: audit.length, latest_action: audit[0]?.action_kind ?? null },
      campaigns: { count: campaigns.length, total_spend_7d_cents: campaigns.reduce((s, c) => s + c.spend_7d, 0) },
      skus: { count: skus.length, with_stock: skus.filter((s) => s.on_hand > 0).length },
      guardrails: { daily_budget_cents: guardrails.daily_action_budget_cents },
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    result.ok = false;
    result.error = { code: e.code ?? "ERROR", message: e.message ?? String(err) };
  }

  result.elapsed_ms = Date.now() - started;
  return json(result, { headers: { "Cache-Control": "no-store" } });
};
