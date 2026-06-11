// Calderyn DashV2 — the live engine.
//
// Drives the dashboard's "live sync" without the prototype's fabricated
// order/spend ticks. While `liveOn`, it polls the real /dashboard/api/*
// endpoints every POLL_MS and surfaces changes:
//   - overview   → onOverview(overview)
//   - campaigns  → onCampaigns(campaigns)          (status/budget edits land live)
//   - guardrails → onGuardrails(guardrails)        (action-budget usage lands live)
//   - audit      → onNewAudit(entry) per new row   (newest-first, diffed by id)
//   - alerts     → onNewAlerts(alerts) per new row (diffed by id)
//
// TODO: Supabase Realtime via getRealtimeToken() — push instead of poll. Polling
// is the implementation now; the realtime token endpoint already exists.
import { useEffect, useRef } from "react";
import {
  fetchOverview,
  fetchAudit,
  fetchAlerts,
  fetchCampaigns,
  fetchGuardrails,
} from "~/lib/dashboard/client";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  GuardrailVM,
  OverviewVM,
} from "./view-models";

const POLL_MS = 15_000;

/** Seen-id sets, primed on the first successful tick so the existing backlog
 * is never replayed as "new". Mutated in place across ticks. */
export interface LivePollState {
  seenAudit: Set<string> | null;
  seenAlerts: Set<string> | null;
}

export interface LivePollFetchers {
  fetchOverview: () => Promise<OverviewVM>;
  fetchAlerts: (
    filters?: undefined,
    campaigns?: CampaignVM[],
  ) => Promise<AlertVM[]>;
  fetchAudit: () => Promise<AuditVM[]>;
  fetchCampaigns: () => Promise<CampaignVM[]>;
  fetchGuardrails: () => Promise<GuardrailVM>;
}

export interface LivePollCallbacks {
  onOverview?: (overview: OverviewVM) => void;
  onCampaigns?: (campaigns: CampaignVM[]) => void;
  onGuardrails?: (guardrails: GuardrailVM) => void;
  onNewAudit?: (entry: AuditVM) => void;
  onNewAlerts?: (alert: AlertVM) => void;
}

/**
 * One poll tick: fetch everything, replace snapshot state (overview, campaigns,
 * guardrails) and emit genuinely new audit/alert rows. Actions executed in the
 * embedded extension write to the shared database, so they surface here within
 * one tick. Errors are swallowed — a transient failure (network blip, 401
 * during logout) skips the tick and the next interval retries.
 */
export async function pollLiveTick(
  state: LivePollState,
  fetchers: LivePollFetchers,
  cb: LivePollCallbacks,
): Promise<void> {
  try {
    // Everything fetches in parallel; only alerts wait on campaigns, so they
    // can derive campaign_id from the freshest campaign list.
    const campaignsP = fetchers.fetchCampaigns();
    const [overview, audit, campaigns, alerts, guardrails] = await Promise.all([
      fetchers.fetchOverview(),
      fetchers.fetchAudit(),
      campaignsP,
      campaignsP.then((cs) => fetchers.fetchAlerts(undefined, cs)),
      fetchers.fetchGuardrails(),
    ]);

    cb.onOverview?.(overview);
    cb.onCampaigns?.(campaigns);
    cb.onGuardrails?.(guardrails);

    if (state.seenAudit === null) {
      state.seenAudit = new Set(audit.map((e) => e.id));
    } else {
      // audit arrives newest-first; emit oldest-new-first so the feed order
      // matches arrival order after we unshift.
      for (const e of [...audit].reverse()) {
        if (!state.seenAudit.has(e.id)) {
          state.seenAudit.add(e.id);
          cb.onNewAudit?.(e);
        }
      }
    }

    if (state.seenAlerts === null) {
      state.seenAlerts = new Set(alerts.map((a) => a.id));
    } else {
      for (const a of [...alerts].reverse()) {
        if (!state.seenAlerts.has(a.id)) {
          state.seenAlerts.add(a.id);
          cb.onNewAlerts?.(a);
        }
      }
    }
  } catch {
    // Transient poll failure — skip this tick; the next interval retries.
  }
}

export interface UseLiveFeedOptions extends LivePollCallbacks {
  liveOn: boolean;
}

export function useLiveFeed({ liveOn, ...callbacks }: UseLiveFeedOptions): void {
  // Keep the latest callbacks in a ref so the polling effect depends only on
  // `liveOn` and never tears down/re-creates intervals mid-flight.
  const cbRef = useRef<LivePollCallbacks>(callbacks);
  cbRef.current = callbacks;

  useEffect(() => {
    if (!liveOn) return;

    let alive = true;
    const state: LivePollState = { seenAudit: null, seenAlerts: null };
    const fetchers: LivePollFetchers = {
      fetchOverview,
      fetchAudit,
      fetchAlerts,
      fetchCampaigns,
      fetchGuardrails,
    };
    const guarded: LivePollCallbacks = {
      onOverview: (o) => alive && cbRef.current.onOverview?.(o),
      onCampaigns: (c) => alive && cbRef.current.onCampaigns?.(c),
      onGuardrails: (g) => alive && cbRef.current.onGuardrails?.(g),
      onNewAudit: (e) => alive && cbRef.current.onNewAudit?.(e),
      onNewAlerts: (a) => alive && cbRef.current.onNewAlerts?.(a),
    };

    const tick = () => void pollLiveTick(state, fetchers, guarded);
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveOn]);
}
