import type { CalderynClient } from "../calderyn.server";

const MAX_SNAPSHOT_ALERTS = 10;

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

/** A compact, cheap-to-tokenize snapshot of the shop's open state for the system prompt. */
export async function buildSnapshot(client: CalderynClient): Promise<string> {
  // Best-effort: this is background context, not the answer. One source erroring
  // (a provider outage surfacing as a CalderynError) must not fail the whole
  // turn — the user's message has already been persisted. Degrade to empty.
  const settle = <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => [] as T[]);
  const [alerts, campaigns, skus] = await Promise.all([
    settle(client.alerts.list({ status: "open" })),
    settle(client.campaigns.list()),
    settle(client.skus.list()),
  ]);

  const bySeverity: Record<string, number> = {};
  for (const a of alerts) bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
  const severitySummary =
    Object.entries(bySeverity)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ") || "none";

  // alerts.list already orders by claude_rank ascending, so slice = top N.
  const top = alerts
    .slice(0, MAX_SNAPSHOT_ALERTS)
    .map(
      (a) =>
        `- [#${a.claude_rank}] ${a.title} (${a.detector_id}, ${dollars(a.dollar_impact)}/30d, ${a.severity})`,
    );

  return [
    "Shop snapshot (live):",
    `Open alerts: ${alerts.length} (${severitySummary})`,
    `Campaigns: ${campaigns.length}. SKUs: ${skus.length}.`,
    top.length ? `Top open alerts by rank:\n${top.join("\n")}` : "No open alerts.",
  ].join("\n");
}
