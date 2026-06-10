// Calderyn DashV2 — the live engine.
//
// Drives the dashboard's "live sync" without the prototype's fabricated
// order/spend ticks. While `liveOn`, it polls the real /dashboard/api/*
// endpoints every POLL_MS and surfaces changes:
//   - overview  → onOverview(overview)            (shell maps it to today's totals)
//   - audit     → onNewAudit(entry) per new row   (newest-first, diffed by id)
//   - alerts    → onNewAlerts(alerts) per new row (diffed by id)
//
// TODO: Supabase Realtime via getRealtimeToken() — push instead of poll. Polling
// is the implementation now; the realtime token endpoint already exists.
import { useEffect, useRef } from "react";
import { fetchOverview, fetchAudit, fetchAlerts } from "~/lib/dashboard/client";
import type { AlertVM, AuditVM, CampaignVM, OverviewVM } from "./view-models";

const POLL_MS = 15_000;

export interface UseLiveFeedOptions {
  liveOn: boolean;
  /** Campaigns are needed so polled alerts derive their campaign_id. */
  campaigns: CampaignVM[];
  onOverview?: (overview: OverviewVM) => void;
  onNewAudit?: (entry: AuditVM) => void;
  onNewAlerts?: (alert: AlertVM) => void;
}

export function useLiveFeed({
  liveOn,
  campaigns,
  onOverview,
  onNewAudit,
  onNewAlerts,
}: UseLiveFeedOptions): void {
  // Keep the latest callbacks/campaigns in refs so the polling effect depends
  // only on `liveOn` and never tears down/re-creates intervals mid-flight.
  const onOverviewRef = useRef(onOverview);
  const onNewAuditRef = useRef(onNewAudit);
  const onNewAlertsRef = useRef(onNewAlerts);
  const campaignsRef = useRef(campaigns);
  onOverviewRef.current = onOverview;
  onNewAuditRef.current = onNewAudit;
  onNewAlertsRef.current = onNewAlerts;
  campaignsRef.current = campaigns;

  useEffect(() => {
    if (!liveOn) return;

    let alive = true;
    // Seen-id sets are primed on the first poll so we only emit genuinely new
    // rows after live sync starts (no replaying the existing backlog as "new").
    let seenAudit: Set<string> | null = null;
    let seenAlerts: Set<string> | null = null;

    const poll = async () => {
      try {
        const [overview, audit, alerts] = await Promise.all([
          fetchOverview(),
          fetchAudit(),
          fetchAlerts(undefined, campaignsRef.current),
        ]);
        if (!alive) return;

        onOverviewRef.current?.(overview);

        if (seenAudit === null) {
          seenAudit = new Set(audit.map((e) => e.id));
        } else {
          // audit arrives newest-first; emit oldest-new-first so the feed order
          // matches arrival order after we unshift.
          for (const e of [...audit].reverse()) {
            if (!seenAudit.has(e.id)) {
              seenAudit.add(e.id);
              onNewAuditRef.current?.(e);
            }
          }
        }

        if (seenAlerts === null) {
          seenAlerts = new Set(alerts.map((a) => a.id));
        } else {
          for (const a of [...alerts].reverse()) {
            if (!seenAlerts.has(a.id)) {
              seenAlerts.add(a.id);
              onNewAlertsRef.current?.(a);
            }
          }
        }
      } catch {
        // Transient poll failure (network blip, 401 during logout) — skip this
        // tick; the next interval retries.
      }
    };

    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveOn]);
}

/**
 * Map an overview's newest roas_series point to today's revenue/spend totals.
 * `daysAgo === 0` is today; fall back to the last array element.
 */
export function todayFromOverview(overview: OverviewVM): {
  revenue_cents: number;
  spend_cents: number;
} {
  const rows = overview.roas_series;
  if (!rows.length) return { revenue_cents: 0, spend_cents: 0 };
  const today = rows.find((r) => r.daysAgo === 0) ?? rows[rows.length - 1];
  return { revenue_cents: today.revenue_cents, spend_cents: today.spend_cents };
}
