import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Btn, Card, Toggle, Segmented, Pill, Placeholder } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import {
  putConsent,
  putGuardrails,
  fetchShipCost,
  setShipCostMode,
  fetchUnmatchedShipCharges,
  startIntegrationConnect,
  connectIntegrationKey,
  disconnectIntegration,
  fetchLearnedRules,
  undoRule,
  fetchBilling,
  startPayoutOnboarding,
  fetchPayoutLoginLink,
  DashboardApiError,
  type UnmatchedShipCharges,
  type BillingStatus,
  type ShipCostSettings,
} from "~/lib/dashboard/client";
import { cacheScreenData, cachedScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import type { DashboardCtx } from "../context";
import type { GuardrailVM, IntegrationVM, LearnedRuleVM } from "../view-models";
import { payoutsCardState } from "../view-models";
import type { GuardrailConfig } from "~/lib/types";
import {
  isApiKeyConnect,
  isConnectable,
  isOauthPending,
  isPaired,
  kindToProvider,
} from "~/lib/integrations";
import {
  MCP_CONNECTOR_URL,
  CLI_COMMAND,
  CLI_NOTE,
  CONNECTOR_STEPS,
} from "~/lib/mcp-connect-guide";
import { GuardrailField } from "../GuardrailField";
import { BusinessHoursEditor } from "../BusinessHoursEditor";
import { SettingsSubTabs } from "../subtabs";

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

/* ---------- Header ---------- */
function ScreenHeader({ title }: { title: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
      </div>
    </header>
  );
}

/* ---------- Card shells (settings design language) ---------- */
function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <div className="cd-card" style={{ overflow: "hidden" }}>
      {children}
    </div>
  );
}

/** Uppercase in-card group label ("Connected" / "Available"). */
function CardLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="cd-caption"
      style={{
        padding: "16px 20px 4px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        fontWeight: 650,
      }}
    >
      {children}
    </div>
  );
}

/* ---------- Setting row ---------- */
function SettingRow({
  label,
  sub,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="cd-setting">
      <div className="min-w-0 flex-1">
        <div className="cd-row-title">{label}</div>
        {sub && (
          <div className="cd-caption" style={{ maxWidth: "46ch" }}>
            {sub}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** Connection mechanism caption on a connector row ("OAuth", "API key", …). */
function Mech({ children }: { children: ReactNode }) {
  return (
    <span className="cd-caption" style={{ flexShrink: 0 }}>
      {children}
    </span>
  );
}

/** Fold opener with proper disclosure semantics. */
function FoldBtn({
  open,
  controls,
  onClick,
  children,
}: {
  open: boolean;
  controls: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cd-btn cd-btn-secondary cd-btn-sm"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const CONNECTION_TONE: Record<string, PillTone> = {
  connected: "success",
  pending: "warn",
  disconnected: "critical",
  reauth: "warn",
};
const CONNECTION_LABEL: Record<string, string> = {
  connected: "Connected",
  pending: "Pending",
  disconnected: "Disconnected",
  reauth: "Reconnect needed",
};
const CONNECTION_ICON: Record<string, string> = {
  connected: "check",
  pending: "clock",
  disconnected: "x",
  reauth: "warn",
};

// What the merchant pastes for each API-key connector (contract C8).
const KEY_PLACEHOLDER: Record<string, string> = {
  easypost: "EasyPost API key",
  shipbob: "ShipBob token",
  shiphero: "ShipHero refresh token",
};

/** Row caption for how a provider pairs, derived from its real connect flow. */
function integrationMech(key: string): string | null {
  const provider = kindToProvider(key);
  if (isApiKeyConnect(key)) {
    if (provider === "shipbob") return "PAT";
    if (provider === "shiphero") return "Refresh token";
    return "API key";
  }
  if (isConnectable(key)) return "OAuth";
  return null;
}

/**
 * Connect / Disconnect / key-paste affordance for one Connections row.
 * OAuth providers round-trip a full page load (the callback returns to
 * /dashboard?<provider>=connected); disconnect and key connects mutate in
 * place and write the refreshed rows to the shared shell state, so every
 * consumer of app.integrations sees the new pairing, not just this screen.
 */
function ConnectionActions({ it, app }: { it: IntegrationVM; app: DashboardCtx }) {
  const provider = kindToProvider(it.key);
  const paired = isPaired(it.status);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");

  const fail = (err: unknown, fallback: string) => {
    app.toast(err instanceof DashboardApiError ? err.message : fallback, "x", "critical");
  };

  if (paired && (isConnectable(it.key) || isApiKeyConnect(it.key))) {
    return (
      <Btn
        small
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            app.setIntegrations(await disconnectIntegration(provider));
            app.toast(`Disconnected ${it.name}`, "check");
          } catch (err) {
            fail(err, `Couldn't disconnect ${it.name}.`);
          } finally {
            setBusy(false);
          }
        }}
      >
        Disconnect
      </Btn>
    );
  }

  if (isConnectable(it.key)) {
    return (
      <Btn
        small
        kind="primary"
        disabled={busy || isOauthPending(it.key)}
        onClick={async () => {
          setBusy(true);
          try {
            const { url } = await startIntegrationConnect(provider);
            window.location.assign(url);
          } catch (err) {
            fail(err, `Couldn't start the ${it.name} connection.`);
            setBusy(false);
          }
        }}
      >
        {it.status === "reauth" ? "Reconnect" : "Connect"}
      </Btn>
    );
  }

  if (isApiKeyConnect(it.key)) {
    return (
      <div className="flex items-center gap-2">
        <input
          className="cd-input"
          type="password"
          placeholder={KEY_PLACEHOLDER[provider] ?? "API key"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          disabled={busy}
          aria-label={`${it.name} credential`}
        />
        <Btn
          small
          kind="primary"
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              app.setIntegrations(await connectIntegrationKey(provider, key));
              setKey("");
              app.toast(`${it.name} connected`, "check");
            } catch (err) {
              fail(err, `Couldn't connect ${it.name}.`);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </Btn>
      </div>
    );
  }

  // No native connect mechanism from here (e.g. the Shopify row).
  return null;
}

// Human-readable reason a carrier charge stayed unmatched (Phase 3 Part C, rule 12).
const UNMATCHED_REASON_LABEL: Record<string, string> = {
  no_ref: "No order ref or tracking",
  no_tracking_match: "Ref / tracking didn't match",
  carrier_adjustment_no_link: "Carrier adjustment, no link",
};

/** Monospace command/URL row with a working copy affordance. */
function CodeRow({ text, app }: { text: string; app: DashboardCtx }) {
  return (
    <div className="cd-code">
      <span style={{ minWidth: 0, wordBreak: "break-all" }}>{text}</span>
      <button
        type="button"
        className="cd-btn cd-btn-secondary cd-btn-sm"
        style={{ flexShrink: 0 }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            app.toast("Copied to clipboard", "check");
          } catch {
            app.toast("Couldn't copy — select the text manually.", "x", "critical");
          }
        }}
      >
        Copy
      </button>
    </div>
  );
}

export default function Settings({ app }: { app: DashboardCtx }) {
  // Local editable copy of guardrails, seeded from app.guardrails and re-synced
  // whenever the shell refreshes it. Optimistic edits write here first; a failed
  // PUT reverts the touched field back to the server value.
  const [g, setG] = useState<GuardrailVM | null>(app.guardrails);
  const [saving, setSaving] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  // Disclosure state for the General tab's folds.
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);
  const [unmatchedOpen, setUnmatchedOpen] = useState(false);
  const [learnedOpen, setLearnedOpen] = useState(false);
  const guardrailsFoldId = useId();
  const unmatchedFoldId = useId();
  const learnedFoldId = useId();

  useEffect(() => {
    setG(app.guardrails);
  }, [app.guardrails]);

  // Commit a single changed field: optimistic local update → PUT just that
  // field → refresh + success toast. On error, revert to the server value.
  const commit = async <K extends keyof GuardrailConfig>(
    key: K,
    value: GuardrailVM[K & keyof GuardrailVM],
    successText = "Guardrails updated",
  ) => {
    if (!g || saving) return;
    const prev = g;
    setG({ ...g, [key]: value } as GuardrailVM);
    setSaving(true);
    try {
      await putGuardrails({ [key]: value } as Partial<GuardrailConfig>);
      app.refresh();
      app.toast(successText, "check");
    } catch (err) {
      // Revert the optimistic value and surface the failure.
      setG(prev);
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't update guardrails.";
      app.toast(message, "x", "critical");
    } finally {
      setSaving(false);
    }
  };

  // Peer-baseline consent toggle. Mirrors the embedded Settings control; writes
  // through the dashboard consent route, then refresh + toast. There is no
  // optimistic local copy — app.consent is re-read on refresh().
  const commitConsent = async (value: boolean) => {
    if (savingConsent || app.consent === null) return;
    setSavingConsent(true);
    try {
      await putConsent(value);
      app.refresh();
      app.toast(
        value ? "Peer baseline enabled" : "Consent withdrawn — purged within 30 days",
        "check",
      );
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't update consent.";
      app.toast(message, "x", "critical");
    } finally {
      setSavingConsent(false);
    }
  };

  // Ship-cost mode + weight-coverage nudge. Loaded from /dashboard/api/ship-cost
  // (not in the shell context). Mode is the dashboard control; detailed inputs
  // (period total, invoice CSV, per-order override) live in the Shopify admin.
  // Ship-cost/unmatched/rules/billing below seed from the session cache so a
  // return visit paints instantly; each mount fetch revalidates + writes back.
  // The cache holds the endpoint's whole payload (same rule as every screen),
  // so the prefetch warm-up can reuse fetchShipCost verbatim.
  const seededShipCost = cachedScreenData<ShipCostSettings>(SCREEN_CACHE_KEYS.shipCost);
  const [shipMode, setShipMode] = useState<string | null>(() => seededShipCost?.ship_mode ?? null);
  const [missingWeight, setMissingWeight] = useState(() => seededShipCost?.missing_weight_pct ?? 0);
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    let active = true;
    fetchShipCost()
      .then((d) => {
        cacheScreenData(SCREEN_CACHE_KEYS.shipCost, d);
        if (!active) return;
        setShipMode(d.ship_mode);
        setMissingWeight(d.missing_weight_pct);
      })
      .catch(() => {
        /* leave defaults; the section just shows 'auto' until reachable */
      });
    return () => {
      active = false;
    };
  }, []);

  // Unmatched carrier charges (Phase 3 Part C) — READ-ONLY on the dashboard. Loaded like
  // ship-cost above (not in the shell context). When unreachable or zero, the row hides.
  const [unmatchedShip, setUnmatchedShip] = useState<UnmatchedShipCharges | null>(() =>
    cachedScreenData<UnmatchedShipCharges>(SCREEN_CACHE_KEYS.unmatchedShip),
  );
  useEffect(() => {
    let active = true;
    fetchUnmatchedShipCharges()
      .then((d) => {
        cacheScreenData(SCREEN_CACHE_KEYS.unmatchedShip, d);
        if (active) setUnmatchedShip(d);
      })
      .catch(() => {
        /* leave null → the row renders nothing until reachable */
      });
    return () => {
      active = false;
    };
  }, []);

  // Learned calibration rules — what Calderyn learned from this shop's rejects.
  // Loaded like ship-cost above; removing one hands the decision back (the
  // suggestion returns to the Action Queue, never silently re-enables autonomy).
  const [learnedRules, setLearnedRules] = useState<LearnedRuleVM[] | null>(() =>
    cachedScreenData<LearnedRuleVM[]>(SCREEN_CACHE_KEYS.learnedRules),
  );
  const [learnedFailed, setLearnedFailed] = useState(false);
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);
  const loadLearnedRules = useCallback(() => {
    setLearnedFailed(false);
    fetchLearnedRules()
      .then((rules) => setLearnedRules(cacheScreenData(SCREEN_CACHE_KEYS.learnedRules, rules)))
      .catch(() => {
        // A failed read must look failed, not eternally loading (rule 12).
        setLearnedFailed(true);
      });
  }, []);
  useEffect(() => {
    loadLearnedRules();
  }, [loadLearnedRules]);

  const removeRule = async (rule: LearnedRuleVM) => {
    if (removingRuleId) return;
    setRemovingRuleId(rule.id);
    try {
      await undoRule(rule.id);
      setLearnedRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
      // Refresh the shell so the Action Queue / Live Engine reflect the
      // handed-back pair immediately — without this the queue keeps its
      // pre-undo cache and the toast reads as a lie.
      app.refresh();
      app.toast(
        rule.rule_kind === "muted_pair"
          ? "Handed back — Calderyn will suggest this again"
          : "Rule removed — Calderyn will bring this back for approval",
        "check",
      );
    } catch (err) {
      if (err instanceof DashboardApiError && err.code === "RULE_NOT_FOUND") {
        // Already removed elsewhere (another tab / the embedded app): treat as
        // done — drop the dead row instead of re-erroring forever.
        setLearnedRules((prev) => (prev ?? []).filter((r) => r.id !== rule.id));
        app.refresh();
        app.toast("That rule was already removed", "check");
        return;
      }
      const message = err instanceof DashboardApiError ? err.message : "Couldn't remove that rule.";
      app.toast(message, "x", "critical");
    } finally {
      setRemovingRuleId(null);
    }
  };

  const commitShipMode = async (mode: string) => {
    if (savingMode || mode === shipMode) return;
    const prev = shipMode;
    setShipMode(mode);
    setSavingMode(true);
    try {
      await setShipCostMode(mode);
      app.toast("Shipping cost mode saved", "check");
    } catch (err) {
      setShipMode(prev);
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't update shipping cost mode.";
      app.toast(message, "x", "critical");
    } finally {
      setSavingMode(false);
    }
  };

  // Stripe Connect payout pairing (real status via /dashboard/api/billing).
  // Drives which Connectors card the Stripe row sits in: Connected when the
  // Express account is fully active, Available (with a live onboarding CTA)
  // otherwise. Same start-onboarding / login-link calls as the Payments screen.
  const [billing, setBilling] = useState<BillingStatus | null>(() =>
    cachedScreenData<BillingStatus>(SCREEN_CACHE_KEYS.billing),
  );
  const [billingFailed, setBillingFailed] = useState(false);
  const [payoutBusy, setPayoutBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetchBilling()
      .then((d) => {
        cacheScreenData(SCREEN_CACHE_KEYS.billing, d);
        if (active) setBilling(d);
      })
      .catch(() => {
        if (active) setBillingFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const retryBilling = async () => {
    setBillingFailed(false);
    try {
      setBilling(await fetchBilling());
    } catch {
      setBillingFailed(true);
    }
  };

  const openPayoutOnboarding = async () => {
    if (payoutBusy) return;
    setPayoutBusy(true);
    try {
      const { url } = await startPayoutOnboarding();
      window.location.assign(url); // top-level hop to Stripe-hosted onboarding
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't start payout setup.";
      app.toast(message, "x", "critical");
      setPayoutBusy(false);
    }
  };

  const openStripeDashboard = async () => {
    if (payoutBusy) return;
    setPayoutBusy(true);
    try {
      // Login links are single-use; mint on click (in-tab nav — an async
      // window.open would trip popup blockers).
      const { url } = await fetchPayoutLoginLink();
      window.location.assign(url);
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't open the Stripe dashboard.";
      app.toast(message, "x", "critical");
      setPayoutBusy(false);
    }
  };

  // Guardrails not loaded yet — show the placeholder per the spec.
  if (!g) {
    return (
      <div className="cd-screen" style={{ maxWidth: 760 }}>
        <ScreenHeader title="Settings" />
        <Card pad={false}>
          <Placeholder icon="shield" title="Loading guardrails" sub="Reading your autopilot limits and connections." />
        </Card>
      </div>
    );
  }

  const integrations = app.integrations;
  const sub = app.nav.screen === "settings" ? (app.nav.sub ?? "general") : "general";

  const payouts = billing ? payoutsCardState(billing) : null;
  const stripeActive = payouts?.phase === "active";
  const stripeBalance = billing?.balance?.available?.[0];
  const shopifyRow = integrations.find((it) => it.key === "shopify") ?? null;

  return (
    <div className="cd-screen" style={{ maxWidth: 760 }}>
      <ScreenHeader title="Settings" />

      <SettingsSubTabs app={app} />

      {sub === "general" && (
        <SettingsCard>
          <SettingRow label="Dark mode" sub="Persisted across sessions.">
            <Toggle
              value={!!app.t.dark}
              onChange={(v) => app.setNightMode(v)}
              ariaLabel="Dark mode"
            />
          </SettingRow>
          <SettingRow label="Guardrails" sub="Spend caps, cooldowns, hours.">
            <FoldBtn
              open={guardrailsOpen}
              controls={guardrailsFoldId}
              onClick={() => setGuardrailsOpen((v) => !v)}
            >
              Configure
            </FoldBtn>
          </SettingRow>
          {guardrailsOpen && (
            <div id={guardrailsFoldId}>
              <SettingRow
                label="Autopilot"
                sub="Let Calderyn execute recommended actions on its own, within the guardrails below."
              >
                <Toggle
                  value={g.autopilot_enabled}
                  disabled={saving}
                  ariaLabel="Autopilot"
                  onChange={(v) =>
                    commit(
                      "autopilot_enabled",
                      v,
                      v ? "Autopilot enabled." : "Autopilot turned off.",
                    )
                  }
                />
              </SettingRow>
              {/* Limits only appear once autopilot is on — mirrors the embedded
                  settings page, reinforcing that autopilot is off by default. */}
              {g.autopilot_enabled && (
                <>
                  <SettingRow
                    label="Bypass guardrails"
                    sub="DANGER: ignore every limit below (daily cap, min spend, approval $ cap, cooldown, business hours) and act on every candidate immediately. Change sizes still follow the cut/raise % below."
                  >
                    <Toggle
                      value={g.autopilot_bypass_guardrails}
                      disabled={saving}
                      ariaLabel="Bypass guardrails"
                      onChange={(v) =>
                        commit(
                          "autopilot_bypass_guardrails",
                          v,
                          v
                            ? "Guardrails bypassed — autopilot acts without limits."
                            : "Guardrails re-enabled.",
                        )
                      }
                    />
                  </SettingRow>
                  <SettingRow label="Daily action cap" sub="Maximum automated actions per day. Unlimited removes the daily cap.">
                    <GuardrailField
                      value={g.autopilot_daily_action_cap}
                      presets={[
                        { value: 3, label: "3" },
                        { value: 6, label: "6" },
                        { value: 12, label: "12" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
                      }}
                      suffix="per day"
                      unlimited={{ label: "Unlimited" }}
                      disabled={saving}
                      onCommit={(v) => commit("autopilot_daily_action_cap", v)}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Max budget cut"
                    sub="Autopilot never reduces a campaign budget by more than this."
                  >
                    <GuardrailField
                      value={g.autopilot_max_budget_cut_pct}
                      presets={[
                        { value: 15, label: "15%" },
                        { value: 30, label: "30%" },
                        { value: 50, label: "50%" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
                      }}
                      suffix="%"
                      disabled={saving}
                      onCommit={(v) => {
                        if (v !== null) commit("autopilot_max_budget_cut_pct", v);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Max price change"
                    sub="Adjust-price never moves a product price by more than this in one step."
                  >
                    <GuardrailField
                      value={g.max_price_change_pct}
                      presets={[
                        { value: 10, label: "10%" },
                        { value: 15, label: "15%" },
                        { value: 25, label: "25%" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
                      }}
                      suffix="%"
                      disabled={saving}
                      onCommit={(v) => {
                        if (v !== null) commit("max_price_change_pct", v);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Most a price can move on its own (%)"
                    sub="When autopilot adjusts a price without you, it never moves it more than this in one step."
                  >
                    <GuardrailField
                      value={g.autopilot_max_price_change_pct}
                      presets={[
                        { value: 5, label: "5%" },
                        { value: 10, label: "10%" },
                        { value: 15, label: "15%" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
                      }}
                      suffix="%"
                      disabled={saving}
                      onCommit={(v) => {
                        if (v !== null) commit("autopilot_max_price_change_pct", v);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Most stock Calderyn can move on its own (units)"
                    sub="When autopilot reallocates inventory without you, it never moves more than this many units at once. Leave unset for no limit."
                  >
                    <GuardrailField
                      value={g.autopilot_max_inventory_units_per_move}
                      presets={[
                        { value: 10, label: "10" },
                        { value: 50, label: "50" },
                        { value: 100, label: "100" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
                      }}
                      unlimited={{ label: "No limit" }}
                      disabled={saving}
                      onCommit={(v) => commit("autopilot_max_inventory_units_per_move", v)}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Max budget increase"
                    sub="Autopilot never raises a campaign budget by more than this in one step."
                  >
                    <GuardrailField
                      value={g.autopilot_max_budget_increase_pct}
                      presets={[
                        { value: 10, label: "10%" },
                        { value: 20, label: "20%" },
                        { value: 50, label: "50%" },
                      ]}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
                      }}
                      suffix="%"
                      disabled={saving}
                      onCommit={(v) => {
                        if (v !== null) commit("autopilot_max_budget_increase_pct", v);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    label="Daily budget ceiling"
                    sub="A hard cap on how high autopilot can push any one campaign's daily budget."
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Toggle
                        value={g.autopilot_max_daily_budget_cents !== null}
                        disabled={saving}
                        ariaLabel="Daily budget ceiling"
                        onChange={(on) =>
                          commit("autopilot_max_daily_budget_cents", on ? 50000 : null)
                        }
                      />
                      {g.autopilot_max_daily_budget_cents !== null && (
                        <GuardrailField
                          value={g.autopilot_max_daily_budget_cents}
                          presets={[
                            { value: 25000, label: "$250" },
                            { value: 50000, label: "$500" },
                            { value: 100000, label: "$1,000" },
                          ]}
                          toInput={(c) => String(Math.round(c / 100))}
                          fromInput={(raw) => {
                            const n = Number(raw);
                            return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
                          }}
                          suffix="USD/day"
                          disabled={saving}
                          onCommit={(v) => commit("autopilot_max_daily_budget_cents", v)}
                        />
                      )}
                    </div>
                  </SettingRow>
                  <SettingRow
                    label="Minimum spend to act"
                    sub="Autopilot only touches a campaign once it has spent at least this much."
                  >
                    <GuardrailField
                      value={g.autopilot_min_spend_cents}
                      presets={[
                        { value: 5000, label: "$50" },
                        { value: 10000, label: "$100" },
                        { value: 25000, label: "$250" },
                      ]}
                      toInput={(c) => String(Math.round(c / 100))}
                      fromInput={(raw) => {
                        const n = Number(raw);
                        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
                      }}
                      suffix="USD"
                      disabled={saving}
                      onCommit={(v) => {
                        if (v !== null) commit("autopilot_min_spend_cents", v);
                      }}
                    />
                  </SettingRow>
                </>
              )}
              <SettingRow
                label="Daily action budget"
                sub={`Dollar impact ceiling across all actions per day. ${money(
                  g.daily_action_budget_used_cents,
                )} used today.`}
              >
                <GuardrailField
                  value={g.daily_action_budget_cents}
                  presets={[
                    { value: 25000, label: "$250" },
                    { value: 50000, label: "$500" },
                    { value: 100000, label: "$1,000" },
                  ]}
                  toInput={(c) => String(Math.round(c / 100))}
                  fromInput={(raw) => {
                    const n = Number(raw);
                    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
                  }}
                  suffix="USD/day"
                  disabled={saving}
                  onCommit={(v) => {
                    if (v !== null) commit("daily_action_budget_cents", v);
                  }}
                />
              </SettingRow>
              <SettingRow
                label="Per-action dollar cap"
                sub="The most a single action is allowed to move."
              >
                <GuardrailField
                  value={g.dollar_cap_cents}
                  presets={[
                    { value: 10000, label: "$100" },
                    { value: 25000, label: "$250" },
                    { value: 50000, label: "$500" },
                  ]}
                  toInput={(c) => String(Math.round(c / 100))}
                  fromInput={(raw) => {
                    const n = Number(raw);
                    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
                  }}
                  suffix="USD"
                  disabled={saving}
                  onCommit={(v) => {
                    if (v !== null) commit("dollar_cap_cents", v);
                  }}
                />
              </SettingRow>
              <SettingRow
                label="Cooldown between actions"
                sub="Minimum gap before another action can touch the same campaign or SKU."
              >
                <GuardrailField
                  value={g.cooldown_minutes}
                  presets={[
                    { value: 15, label: "15m" },
                    { value: 30, label: "30m" },
                    { value: 60, label: "1h" },
                  ]}
                  fromInput={(raw) => {
                    const n = Number(raw);
                    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
                  }}
                  suffix="minutes"
                  disabled={saving}
                  onCommit={(v) => {
                    if (v !== null) commit("cooldown_minutes", v);
                  }}
                />
              </SettingRow>
              <BusinessHoursEditor
                enabled={g.business_hours_only}
                start={g.business_hours.start}
                end={g.business_hours.end}
                tz={g.business_hours.tz}
                disabled={saving}
                onToggle={(on) =>
                  commit("business_hours_only", on, on ? "Business-hours window on." : "Business-hours window off.")
                }
                onChangeWindow={(next) => commit("business_hours", next, "Business hours updated")}
              />
            </div>
          )}

          <SettingRow
            label="Shipping cost source"
            sub="How each order's shipping cost is estimated. Automatic picks the most trustworthy source per order; period totals, carrier invoices, and per-order overrides live in the Shopify admin."
          >
            <div className="flex items-center gap-2" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
              {missingWeight > 0 && <Pill tone="warn">{`${missingWeight}% missing weight`}</Pill>}
              <Segmented
                small
                value={shipMode ?? "auto"}
                onChange={(v) => commitShipMode(v)}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "force_measured", label: "Measured" },
                  { value: "force_reconciled", label: "Allocated" },
                ]}
              />
            </div>
          </SettingRow>

          {unmatchedShip && unmatchedShip.count > 0 && (
            <>
              <SettingRow
                label="Unmatched carrier charges"
                sub="Carrier charges we couldn't tie to an order, so they aren't in margin yet. Map them to orders in the Shopify admin."
              >
                <Pill tone="warn">{`${unmatchedShip.count} unmatched`}</Pill>
                <FoldBtn
                  open={unmatchedOpen}
                  controls={unmatchedFoldId}
                  onClick={() => setUnmatchedOpen((v) => !v)}
                >
                  Review
                </FoldBtn>
              </SettingRow>
              {unmatchedOpen && (
                <div id={unmatchedFoldId}>
                  {unmatchedShip.items.slice(0, 10).map((it) => (
                    <SettingRow
                      key={it.id}
                      label={`${money(it.costCents)}${it.provider ? ` · ${it.provider}` : ""}`}
                      sub={`${it.orderRef ? `Ref ${it.orderRef}` : "No ref"}${
                        it.trackingNo ? ` · Tracking ${it.trackingNo}` : ""
                      } — ${UNMATCHED_REASON_LABEL[it.reason] ?? it.reason}`}
                    >
                      <Pill tone="neutral">Resolve in admin</Pill>
                    </SettingRow>
                  ))}
                </div>
              )}
            </>
          )}

          <SettingRow
            label="Learned rules"
            sub="What Calderyn learned from your rejections. Remove one to hand the decision back."
          >
            {learnedRules !== null && learnedRules.length > 0 && (
              <Pill tone="neutral">
                {learnedRules.length === 1 ? "1 rule" : `${learnedRules.length} rules`}
              </Pill>
            )}
            <FoldBtn
              open={learnedOpen}
              controls={learnedFoldId}
              onClick={() => setLearnedOpen((v) => !v)}
            >
              View
            </FoldBtn>
          </SettingRow>
          {learnedOpen && (
            <div id={learnedFoldId}>
              {learnedFailed ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px" }}>
                  <span className="cd-caption">Couldn&apos;t load learned rules.</span>
                  <Btn small onClick={loadLearnedRules}>
                    Retry
                  </Btn>
                </div>
              ) : learnedRules === null ? (
                <Placeholder
                  icon="shield"
                  title="Loading learned rules"
                  sub="Reading what Calderyn learned from your decisions."
                />
              ) : learnedRules.length === 0 ? (
                <Placeholder
                  icon="shield"
                  title="Nothing learned yet"
                  sub="Reject a suggestion with a reason and the rule Calderyn learns appears here."
                />
              ) : (
                learnedRules.map((r) => (
                  <SettingRow
                    key={r.id}
                    label={r.summary}
                    sub={`Learned ${new Date(r.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })} — remove to hand the decision back`}
                  >
                    <button
                      type="button"
                      className="cd-btn"
                      disabled={removingRuleId !== null}
                      onClick={() => removeRule(r)}
                    >
                      {removingRuleId === r.id
                        ? "Removing…"
                        : r.rule_kind === "muted_pair"
                          ? "Hand it back"
                          : "Remove rule"}
                    </button>
                  </SettingRow>
                ))
              )}
            </div>
          )}

          <SettingRow
            label="Peer baseline"
            sub="Contribute anonymized, hashed metrics so Calderyn can benchmark you against peer shops in your category. Withdraw anytime — your contribution is purged within 30 days."
          >
            <Toggle
              value={app.consent ?? false}
              disabled={savingConsent || app.consent === null}
              ariaLabel="Peer baseline"
              onChange={(v) => commitConsent(v)}
            />
          </SettingRow>

          <SettingRow
            label="Go live"
            sub="Where your store is on the path from Shopify to Calderyn — checklist, dual run, and the switch."
          >
            <Btn small onClick={() => app.navigate("cutover")}>
              Open
            </Btn>
          </SettingRow>

          <SettingRow
            label="Locations"
            sub="Rank fulfillment locations, set allocator coordinates, and edit ship-from addresses."
          >
            <Btn small onClick={() => app.navigate("locations-settings")}>
              Open
            </Btn>
          </SettingRow>

          <SettingRow label="Collections" sub="Create and manage product collections.">
            <Btn small onClick={() => app.navigate("collections")}>
              Open
            </Btn>
          </SettingRow>
        </SettingsCard>
      )}

      {sub === "connectors" && (
        <>
          <SettingsCard>
            <CardLabel>Connected</CardLabel>
            {/* No status pill: accounts can be email+password only, and nothing
                on the session says whether Google is linked — a hardcoded
                "Connected" badge would be fabricated state. */}
            <SettingRow label="Google Sign-In" sub="Merchant login rail — used at sign-in when linked">
              <Mech>OAuth</Mech>
            </SettingRow>
            {billingFailed ? (
              <SettingRow label="Stripe Connect" sub="Payouts — status unavailable">
                <Mech>OAuth</Mech>
                <Btn small onClick={retryBilling}>
                  Retry
                </Btn>
              </SettingRow>
            ) : !payouts ? (
              <SettingRow label="Stripe Connect" sub="Payouts">
                <Mech>OAuth</Mech>
                <Pill tone="neutral" icon="clock">
                  Checking…
                </Pill>
              </SettingRow>
            ) : stripeActive ? (
              <SettingRow
                label="Stripe Connect"
                sub={`Payouts · ${payouts.feeLabel}${
                  stripeBalance ? ` · ${money(stripeBalance.amountCents)} available` : ""
                }`}
              >
                <Mech>OAuth</Mech>
                <Pill tone="success" icon="check">
                  Connected
                </Pill>
                <Btn small disabled={payoutBusy} onClick={openStripeDashboard}>
                  Open
                </Btn>
              </SettingRow>
            ) : null}
            <SettingRow label="Claude · MCP" sub="Agentic sales channel">
              <Mech>MCP</Mech>
              <Btn small onClick={() => app.navigate("settings", null, "mcp")}>
                View setup
              </Btn>
            </SettingRow>
            <SettingRow label="Shopify import" sub="Catalog, inventory, and orders migrated in">
              <Mech>One-click</Mech>
              {shopifyRow && isPaired(shopifyRow.status) && (
                <Pill tone="success" icon="check">
                  Connected
                </Pill>
              )}
              <Btn small onClick={() => app.navigate("import-shopify")}>
                Open
              </Btn>
            </SettingRow>
          </SettingsCard>

          <SettingsCard>
            <CardLabel>Available</CardLabel>
            {payouts && !stripeActive && (
              <SettingRow label="Stripe Connect" sub={`Payouts · ${payouts.feeLabel}`}>
                <Mech>OAuth</Mech>
                {payouts.phase === "onboarding" && (
                  <Pill tone="warn" icon="clock">
                    Onboarding incomplete
                  </Pill>
                )}
                <Btn small kind="primary" disabled={payoutBusy} onClick={openPayoutOnboarding}>
                  {payouts.phase === "onboarding" ? "Resume" : "Connect"}
                </Btn>
              </SettingRow>
            )}
            {integrations.filter((it) => it.key !== "shopify").length === 0 ? (
              <Placeholder
                icon="bolt"
                title="No connections"
                sub="Your ad, finance, and shipping accounts will appear here."
              />
            ) : (
              integrations
                .filter((it) => it.key !== "shopify")
                .map((it) => {
                  const tone = CONNECTION_TONE[it.status] ?? "neutral";
                  const label = CONNECTION_LABEL[it.status] ?? it.status;
                  const icon = CONNECTION_ICON[it.status] ?? "clock";
                  const mech = integrationMech(it.key);
                  return (
                    <SettingRow key={it.key} label={it.name} sub={it.detail}>
                      {mech && <Mech>{mech}</Mech>}
                      {it.status !== "disconnected" && (
                        <Pill tone={tone} icon={icon}>
                          {label}
                        </Pill>
                      )}
                      <ConnectionActions it={it} app={app} />
                    </SettingRow>
                  );
                })
            )}
          </SettingsCard>
        </>
      )}

      {sub === "mcp" && (
        <SettingsCard>
          <div style={{ padding: "18px 20px 2px" }}>
            <div className="cd-anh" style={{ margin: 0 }}>
              <CDIcon name="bolt" size={15} />
              Calderyn MCP &amp; CLI
            </div>
            <p className="cd-caption" style={{ marginTop: 5 }}>
              Connect your store to Claude — let it read your ads, inventory, and alerts and act
              within your guardrails.
            </p>
          </div>
          <div
            style={{ display: "flex", flexDirection: "column", gap: 14, padding: "14px 20px 20px" }}
          >
            {CONNECTOR_STEPS.map((s) => (
              <div key={s.n}>
                <div className="cd-mcp-substep">
                  <b>{s.n}</b>
                  {s.title}
                </div>
                <div className="cd-caption">{s.body}</div>
                {s.n === 2 && (
                  <div style={{ marginTop: 6 }}>
                    <CodeRow text={MCP_CONNECTOR_URL} app={app} />
                  </div>
                )}
              </div>
            ))}
            <div>
              <div className="cd-mcp-substep">
                <b>4</b>
                Claude Code (CLI)
              </div>
              <CodeRow text={CLI_COMMAND} app={app} />
              <div className="cd-caption" style={{ marginTop: 6 }}>
                {CLI_NOTE}
              </div>
            </div>
            <div className="cd-caption">
              Manage access keys &amp; connected workspaces from the Calderyn app in your Shopify
              admin.
            </div>
          </div>
        </SettingsCard>
      )}

      {/* Secret Calderyn Labs trigger — the dimmed hexagon next to the build
          string opens the hidden "Autopilot replay" demo (screens/Labs). The
          mark is the Calderyn logo (same inline hexagon as the sidebar brand),
          not a Lucide icon. */}
      <div className="cd-secret-foot">
        <span>Calderyn for Shopify · v2.4.1 · build 1180</span>
        <button
          type="button"
          className="cd-secret-dot"
          onClick={() => app.navigate("labs")}
          title="Calderyn Labs — Autopilot replay"
          aria-label="Calderyn Labs"
        >
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path
              d="M16 2 L28.12 9 L28.12 23 L16 30 L3.88 23 L3.88 9 Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
