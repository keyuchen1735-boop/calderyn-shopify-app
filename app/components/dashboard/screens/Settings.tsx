import { useEffect, useState, type ReactNode } from "react";
import { Btn, Card, SectionTitle, Toggle, Segmented, Pill, Placeholder } from "../ui";
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
  DashboardApiError,
  type UnmatchedShipCharges,
} from "~/lib/dashboard/client";
import type { DashboardCtx } from "../context";
import type { GuardrailVM, IntegrationVM } from "../view-models";
import type { GuardrailConfig } from "~/lib/types";
import {
  isApiKeyConnect,
  isConnectable,
  isOauthPending,
  isPaired,
  kindToProvider,
} from "~/lib/integrations";
import { McpGuide } from "../McpGuide";
import { GuardrailField } from "../GuardrailField";
import { BusinessHoursEditor } from "../BusinessHoursEditor";

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

/* ---------- Header ---------- */
function ScreenHeader({ title, sub }: { title: ReactNode; sub?: ReactNode }) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
    </header>
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

export default function Settings({ app }: { app: DashboardCtx }) {
  // Local editable copy of guardrails, seeded from app.guardrails and re-synced
  // whenever the shell refreshes it. Optimistic edits write here first; a failed
  // PUT reverts the touched field back to the server value.
  const [g, setG] = useState<GuardrailVM | null>(app.guardrails);
  const [saving, setSaving] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

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
  const [shipMode, setShipMode] = useState<string | null>(null);
  const [missingWeight, setMissingWeight] = useState(0);
  const [savingMode, setSavingMode] = useState(false);

  useEffect(() => {
    let active = true;
    fetchShipCost()
      .then((d) => {
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
  // ship-cost above (not in the shell context). When unreachable or zero, the block hides.
  const [unmatchedShip, setUnmatchedShip] = useState<UnmatchedShipCharges | null>(null);
  useEffect(() => {
    let active = true;
    fetchUnmatchedShipCharges()
      .then((d) => {
        if (active) setUnmatchedShip(d);
      })
      .catch(() => {
        /* leave null → the block renders nothing until reachable */
      });
    return () => {
      active = false;
    };
  }, []);

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

  // Guardrails not loaded yet — show the placeholder per the spec.
  if (!g) {
    return (
      <div className="cd-screen" style={{ maxWidth: 760 }}>
        <ScreenHeader
          title="Settings"
          sub="Guardrails keep every automated action small, slow, and reversible."
        />
        <Card pad={false}>
          <Placeholder icon="shield" title="Loading guardrails" sub="Reading your autopilot limits and connections." />
        </Card>
      </div>
    );
  }

  const integrations = app.integrations;

  return (
    <div className="cd-screen" style={{ maxWidth: 760 }}>
      <ScreenHeader
        title="Settings"
        sub="Guardrails keep every automated action small, slow, and reversible."
      />

      <section>
        <SectionTitle>Shipping cost</SectionTitle>
        <Card pad={false}>
          <SettingRow
            label="Cost source"
            sub="How Calderyn estimates each order's shipping cost. Automatic picks the most trustworthy source per order. Enter period totals, carrier invoices, and per-order overrides in the Shopify admin."
          >
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
          </SettingRow>
          {missingWeight > 0 && (
            <SettingRow
              label="Weight coverage"
              sub="Orders missing product weight get degraded shipping estimates. Add weights in Shopify to improve per-order accuracy."
            >
              <Pill tone="warn">{`${missingWeight}% missing`}</Pill>
            </SettingRow>
          )}
          {unmatchedShip && unmatchedShip.count > 0 && (
            <>
              <SettingRow
                label="Unmatched carrier charges"
                sub="Carrier charges we couldn't tie to an order, so they aren't in margin yet. Map them to orders in the Shopify admin."
              >
                <Pill tone="warn">{`${unmatchedShip.count} unmatched`}</Pill>
              </SettingRow>
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
            </>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>Autopilot</SectionTitle>
        <Card pad={false}>
          <SettingRow
            label="Autopilot"
            sub="Let Calderyn execute recommended actions on its own, within the guardrails below."
          >
            <Toggle
              value={g.autopilot_enabled}
              disabled={saving}
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
        </Card>
      </section>

      <section>
        <SectionTitle>Guardrails</SectionTitle>
        <Card pad={false}>
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
        </Card>
      </section>

      <section>
        <SectionTitle>Privacy</SectionTitle>
        <Card pad={false}>
          <SettingRow
            label="Peer baseline"
            sub="Contribute anonymized, hashed metrics so Calderyn can benchmark you against peer shops in your category. Withdraw anytime — your contribution is purged within 30 days."
          >
            <Toggle
              value={app.consent ?? false}
              disabled={savingConsent || app.consent === null}
              onChange={(v) => commitConsent(v)}
            />
          </SettingRow>
        </Card>
      </section>

      <section>
        <SectionTitle>Connections</SectionTitle>
        <Card pad={false}>
          {integrations.length === 0 ? (
            <Placeholder icon="bolt" title="No connections" sub="Your ad, finance, and shipping accounts will appear here." />
          ) : (
            integrations.map((it) => {
              const tone = CONNECTION_TONE[it.status] ?? "neutral";
              const label = CONNECTION_LABEL[it.status] ?? it.status;
              const icon = CONNECTION_ICON[it.status] ?? "clock";
              return (
                <SettingRow key={it.key} label={it.name} sub={it.detail}>
                  <div className="flex items-center gap-2">
                    <Pill tone={tone} icon={icon}>
                      {label}
                    </Pill>
                    <ConnectionActions it={it} app={app} />
                  </div>
                </SettingRow>
              );
            })
          )}
        </Card>
      </section>

      <section>
        <SectionTitle>Claude connector</SectionTitle>
        <Card>
          <McpGuide />
        </Card>
      </section>

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
