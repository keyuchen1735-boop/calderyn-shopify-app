// Calderyn DashV2 — Settings screen (LIVE).
// Ported from the "Settings" section of the prototype's screen-ops.jsx, wired to
// the live data layer. Two sections:
//   • Guardrails (editable) — autopilot toggle + caps, daily action budget,
//     dollar cap, cooldown, autopilot daily cap, min spend, max budget-cut %,
//     and business-hours display. Edits call putGuardrails({ ...changedFields })
//     with ONLY the changed field, then app.refresh() + a success toast. On a
//     DashboardApiError the optimistic local value reverts and an error toast
//     shows.
//   • Connections (read-only) — from app.integrations. No OAuth flow here.
import { useEffect, useState, type ReactNode } from "react";
import { Card, SectionTitle, Toggle, Segmented, Pill, Placeholder } from "../ui";
import { money } from "../format";
import {
  putConsent,
  putGuardrails,
  fetchShipCost,
  setShipCostMode,
  DashboardApiError,
} from "~/lib/dashboard/client";
import type { DashboardCtx } from "../context";
import type { GuardrailVM } from "../view-models";
import type { GuardrailConfig } from "~/lib/types";
import { McpGuide } from "../McpGuide";

type PillTone = "neutral" | "success" | "critical" | "accent" | "warn";

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
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

/* ---------- Setting row (mirrors the prototype's SettingRow) ---------- */
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
};
const CONNECTION_LABEL: Record<string, string> = {
  connected: "Connected",
  pending: "Pending",
  disconnected: "Disconnected",
};
const CONNECTION_ICON: Record<string, string> = {
  connected: "check",
  pending: "clock",
  disconnected: "x",
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
              <SettingRow label="Daily action cap" sub="Maximum automated actions per day.">
                <Segmented
                  small
                  value={String(g.autopilot_daily_action_cap)}
                  onChange={(v) => commit("autopilot_daily_action_cap", Number(v))}
                  options={["3", "6", "12"]}
                />
              </SettingRow>
              <SettingRow
                label="Max budget cut"
                sub="Autopilot never reduces a campaign budget by more than this."
              >
                <Segmented
                  small
                  value={String(g.autopilot_max_budget_cut_pct)}
                  onChange={(v) => commit("autopilot_max_budget_cut_pct", Number(v))}
                  options={[
                    { value: "15", label: "15%" },
                    { value: "30", label: "30%" },
                    { value: "50", label: "50%" },
                  ]}
                />
              </SettingRow>
              <SettingRow
                label="Minimum spend to act"
                sub="Autopilot only touches a campaign once it has spent at least this much."
              >
                <Segmented
                  small
                  value={String(g.autopilot_min_spend_cents)}
                  onChange={(v) => commit("autopilot_min_spend_cents", Number(v))}
                  options={[
                    { value: "5000", label: "$50" },
                    { value: "10000", label: "$100" },
                    { value: "25000", label: "$250" },
                  ]}
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
            <Segmented
              small
              value={String(g.daily_action_budget_cents)}
              onChange={(v) => commit("daily_action_budget_cents", Number(v))}
              options={[
                { value: "25000", label: "$250" },
                { value: "50000", label: "$500" },
                { value: "100000", label: "$1,000" },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Per-action dollar cap"
            sub="The most a single action is allowed to move."
          >
            <Segmented
              small
              value={String(g.dollar_cap_cents)}
              onChange={(v) => commit("dollar_cap_cents", Number(v))}
              options={[
                { value: "10000", label: "$100" },
                { value: "25000", label: "$250" },
                { value: "50000", label: "$500" },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Cooldown between actions"
            sub="Minimum gap before another action can touch the same campaign or SKU."
          >
            <Segmented
              small
              value={String(g.cooldown_minutes)}
              onChange={(v) => commit("cooldown_minutes", Number(v))}
              options={[
                { value: "15", label: "15m" },
                { value: "30", label: "30m" },
                { value: "60", label: "1h" },
              ]}
            />
          </SettingRow>
          <SettingRow
            label="Business hours only"
            sub={`Actions execute ${g.business_hours.start}–${g.business_hours.end} ${g.business_hours.tz}. Outside that window they queue for review.`}
          >
            {/* business_hours editing is supported by the PUT but not surfaced
                here yet; we display the configured window. TODO: business-hours
                editor (start/end/tz). */}
            <Pill tone={g.in_business_hours ? "success" : "neutral"} icon="clock">
              {g.in_business_hours ? "In window now" : "Outside window"}
            </Pill>
          </SettingRow>
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
          {/* Read-only here. TODO: connect/disconnect flows live in the embedded app. */}
          {integrations.length === 0 ? (
            <Placeholder icon="bolt" title="No connections" sub="Connect Shopify and your ad accounts from the embedded app." />
          ) : (
            integrations.map((it) => {
              const tone = CONNECTION_TONE[it.status] ?? "neutral";
              const label = CONNECTION_LABEL[it.status] ?? it.status;
              const icon = CONNECTION_ICON[it.status] ?? "clock";
              return (
                <SettingRow key={it.key} label={it.name} sub={it.detail}>
                  <Pill tone={tone} icon={icon}>
                    {label}
                  </Pill>
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
    </div>
  );
}
