// The dashboard boot must fill state progressively: each slice applies the
// moment its own fetch resolves, never gated on the slowest of the ten boot
// endpoints. (The old shell awaited Promise.all and set every slice at once,
// so the whole Home sat on "Connecting to the engine" until the last call —
// typically the campaigns→alerts two-hop — came back.) Two exceptions are
// contractual: the action queue waits for alerts (the deck acts on queue items
// through their alert), and a live-engine failure degrades to null.
import { describe, expect, it } from "vitest";
import { bootDashboardData } from "./boot";
import type { DashboardBootFetchers, DashboardBootSinks } from "./boot";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks so .then chains run before we assert. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// Slice payloads only flow through — identity stubs are enough.
const CAMPAIGNS = [{ id: "c1" }] as never;
const OVERVIEW = { revenue: 1 } as never;
const ALERTS = [{ id: "a1" }] as never;
const AUDIT = [{ id: "au1" }] as never;
const GUARDRAILS = { autopilot_enabled: true } as never;
const INTEGRATIONS = [{ id: "shopify" }] as never;
const CALIBRATION = { pct: 40, updated_at: null, nearGraduation: 0 } as never;
const QUEUE = [{ alertId: "a1" }] as never;
const ENGINE = { calibrationPct: 40 } as never;

function harness() {
  const d = {
    campaigns: deferred<never>(),
    overview: deferred<never>(),
    alerts: deferred<never>(),
    audit: deferred<never>(),
    guardrails: deferred<never>(),
    integrations: deferred<never>(),
    consent: deferred<boolean>(),
    calibration: deferred<never>(),
    actionQueue: deferred<never>(),
    liveEngine: deferred<never>(),
  };
  const alertsSawCampaigns: unknown[] = [];
  const fetchers: DashboardBootFetchers = {
    fetchCampaigns: () => d.campaigns.promise,
    fetchOverview: () => d.overview.promise,
    fetchAlerts: (_filters, campaigns) => {
      alertsSawCampaigns.push(campaigns);
      return d.alerts.promise;
    },
    fetchAudit: () => d.audit.promise,
    fetchGuardrails: () => d.guardrails.promise,
    fetchIntegrations: () => d.integrations.promise,
    fetchConsent: () => d.consent.promise,
    fetchCalibration: () => d.calibration.promise,
    fetchActionQueue: () => d.actionQueue.promise,
    fetchLiveEngine: () => d.liveEngine.promise,
  };
  const applied = new Map<string, unknown>();
  const sink =
    (key: string) =>
    (value: unknown): void => {
      applied.set(key, value);
    };
  const sinks: DashboardBootSinks = {
    campaigns: sink("campaigns"),
    overview: sink("overview"),
    alerts: sink("alerts"),
    audit: sink("audit"),
    guardrails: sink("guardrails"),
    integrations: sink("integrations"),
    consent: sink("consent"),
    calibration: sink("calibration"),
    actionQueue: sink("actionQueue"),
    liveEngine: sink("liveEngine"),
  };
  return { d, fetchers, sinks, applied, alertsSawCampaigns };
}

function resolveAll(d: ReturnType<typeof harness>["d"]) {
  d.campaigns.resolve(CAMPAIGNS);
  d.overview.resolve(OVERVIEW);
  d.alerts.resolve(ALERTS);
  d.audit.resolve(AUDIT);
  d.guardrails.resolve(GUARDRAILS);
  d.integrations.resolve(INTEGRATIONS);
  d.consent.resolve(true);
  d.calibration.resolve(CALIBRATION);
  d.actionQueue.resolve(QUEUE);
  d.liveEngine.resolve(ENGINE);
}

describe("bootDashboardData — progressive fill", () => {
  it("applies each slice as its own fetch resolves, before slower ones finish", async () => {
    const { d, fetchers, sinks, applied } = harness();
    const boot = bootDashboardData(sinks, fetchers);

    // The fast trio lands; audit/alerts/etc. are still in flight.
    d.calibration.resolve(CALIBRATION);
    d.overview.resolve(OVERVIEW);
    d.liveEngine.resolve(ENGINE);
    await tick();
    expect(applied.get("calibration")).toBe(CALIBRATION);
    expect(applied.get("overview")).toBe(OVERVIEW);
    expect(applied.get("liveEngine")).toBe(ENGINE);
    expect(applied.has("audit")).toBe(false);
    expect(applied.has("campaigns")).toBe(false);

    resolveAll(d);
    await boot;
    expect(applied.get("audit")).toBe(AUDIT);
    expect(applied.get("alerts")).toBe(ALERTS);
    expect(applied.get("consent")).toBe(true);
  });

  it("chains alerts off the in-flight campaigns result", async () => {
    const { d, fetchers, sinks, alertsSawCampaigns } = harness();
    const boot = bootDashboardData(sinks, fetchers);
    resolveAll(d);
    await boot;
    expect(alertsSawCampaigns).toEqual([CAMPAIGNS]);
  });

  it("fetches campaigns for the selected reporting window", async () => {
    const { d, fetchers, sinks } = harness();
    const windows: unknown[] = [];
    fetchers.fetchCampaigns = (window) => {
      windows.push(window);
      return d.campaigns.promise;
    };

    const boot = bootDashboardData(sinks, fetchers, 90);
    resolveAll(d);
    await boot;

    expect(windows).toEqual([90]);
  });

  it("holds the action queue until alerts land — the deck must never act without alert context", async () => {
    const { d, fetchers, sinks, applied } = harness();
    const boot = bootDashboardData(sinks, fetchers);
    d.actionQueue.resolve(QUEUE);
    await tick();
    expect(applied.has("actionQueue")).toBe(false);
    d.campaigns.resolve(CAMPAIGNS);
    d.alerts.resolve(ALERTS);
    await tick();
    expect(applied.get("alerts")).toBe(ALERTS);
    expect(applied.get("actionQueue")).toBe(QUEUE);
    resolveAll(d);
    await boot;
  });

  it("fails fast on the first error while still applying slices that land afterward", async () => {
    const { d, fetchers, sinks, applied } = harness();
    const boot = bootDashboardData(sinks, fetchers);
    const boom = new Error("audit down");
    d.audit.reject(boom);
    d.guardrails.resolve(GUARDRAILS);
    // Rejects without waiting for the other eight fetches to settle.
    await expect(boot).rejects.toBe(boom);
    expect(applied.get("guardrails")).toBe(GUARDRAILS);
    expect(applied.has("audit")).toBe(false);
    // A slice resolving after the fail-fast rejection still applies.
    d.calibration.resolve(CALIBRATION);
    await tick();
    expect(applied.get("calibration")).toBe(CALIBRATION);
  });

  it("a live-engine failure degrades to null instead of failing the boot", async () => {
    const { d, fetchers, sinks, applied } = harness();
    const boot = bootDashboardData(sinks, fetchers);
    d.liveEngine.reject(new Error("engine 500"));
    resolveAll(d);
    await boot;
    expect(applied.get("liveEngine")).toBe(null);
  });
});
