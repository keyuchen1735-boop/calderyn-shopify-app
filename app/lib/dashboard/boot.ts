// Progressive boot for the dashboard shell's shared data.
//
// The shell used to await Promise.all over all ten boot endpoints and set
// every state slice at once — so the Home sat on its "Connecting to the
// engine" pre-fetch render until the SLOWEST call returned (usually the
// campaigns→alerts two-hop). Here each slice applies through its sink the
// moment its own fetch resolves, so the deck, gauge and strip fill in as
// their data lands. The returned promise resolves once every fetch has, and
// rejects at the FIRST failure (fail-fast, like the old Promise.all) so the
// shell's error toast isn't held hostage by an unrelated hanging endpoint;
// sinks for still-pending fetches keep applying as they land either way.
//
// Two deliberate couplings:
// - The action queue applies only once alerts are in: the deck acts on queue
//   items through their alert (one-click gating, snooze routing), so applying
//   the queue earlier would render actionable cards missing their context.
// - The live-engine slice degrades to null on failure (a hero card must not
//   blank the dashboard).
import * as client from "./client";
import type { LiveEnginePageData } from "~/lib/calibration/live-engine-types";
import type {
  AlertVM,
  AuditVM,
  CampaignVM,
  GuardrailVM,
  IntegrationVM,
  OverviewVM,
  QueueProposalVM,
} from "~/components/dashboard/view-models";
import type { CampaignWindow } from "~/lib/types";

export interface DashboardBootSlices {
  campaigns: CampaignVM[];
  overview: OverviewVM;
  alerts: AlertVM[];
  audit: AuditVM[];
  guardrails: GuardrailVM;
  integrations: IntegrationVM[];
  consent: boolean;
  calibration: { pct: number | null; updated_at: string | null; nearGraduation: number };
  actionQueue: QueueProposalVM[];
  liveEngine: LiveEnginePageData | null;
}

/** One sink per slice — the shell passes its setState functions directly. */
export type DashboardBootSinks = {
  [K in keyof DashboardBootSlices]: (value: DashboardBootSlices[K]) => void;
};

/** The subset of the API client the boot consumes — Pick keeps the signatures
 *  in lockstep with client.ts; injectable for tests. */
export type DashboardBootFetchers = Pick<
  typeof client,
  | "fetchCampaigns"
  | "fetchOverview"
  | "fetchAlerts"
  | "fetchAudit"
  | "fetchGuardrails"
  | "fetchIntegrations"
  | "fetchConsent"
  | "fetchCalibration"
  | "fetchActionQueue"
  | "fetchLiveEngine"
>;

export async function bootDashboardData(
  sinks: DashboardBootSinks,
  fetchers: DashboardBootFetchers = client,
  campaignWindow: CampaignWindow = 30,
): Promise<void> {
  // Only fetchAlerts needs campaigns (to derive campaign_id), so it chains off
  // the in-flight campaigns promise instead of a full extra round-trip.
  const campsP = fetchers.fetchCampaigns(campaignWindow);
  const alertsP = campsP.then((c) => fetchers.fetchAlerts(undefined, c));
  // Promise.all subscribes to every branch up front, so a second failure after
  // the fail-fast rejection is still handled (no unhandled-rejection noise).
  await Promise.all([
    campsP.then(sinks.campaigns),
    fetchers.fetchOverview().then(sinks.overview),
    alertsP.then(sinks.alerts),
    fetchers.fetchAudit().then(sinks.audit),
    fetchers.fetchGuardrails().then(sinks.guardrails),
    fetchers.fetchIntegrations().then(sinks.integrations),
    fetchers.fetchConsent().then(sinks.consent),
    fetchers.fetchCalibration().then(sinks.calibration),
    Promise.all([fetchers.fetchActionQueue(), alertsP]).then(([queue]) =>
      sinks.actionQueue(queue),
    ),
    fetchers
      .fetchLiveEngine()
      .catch(() => null)
      .then(sinks.liveEngine),
  ]);
}
