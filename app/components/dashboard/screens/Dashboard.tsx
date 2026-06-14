// Calderyn DashV2 — Overview screen (LIVE).
// Ported from the prototype's screen-dashboard.jsx, wired to the live DashboardCtx.
// CD.* globals → live imports: money/DETECTOR_TERMS/ACTION_LABELS (format),
// CDIcon/CD_ACTION_ICON (icons), RingGauge/GradePill/etc. (ui). Charts/cards reuse ui.tsx.
import type { ReactNode } from "react";
import {
  Card,
  SectionTitle,
  CountMoney,
  AreaChart,
  SevBadge,
  Pill,
  Btn,
  Meter,
  Placeholder,
  RingGauge,
  GradePill,
} from "../ui";
import { money, DETECTOR_TERMS, ACTION_LABELS, timeAgo } from "../format";
import { trueRoas } from "~/lib/roas";
import { recoveredWithin } from "~/lib/recovered";
import { CDIcon, CD_ACTION_ICON } from "../icons";
import type { ActionKind, DashboardCtx } from "../context";
import type { AlertVM } from "../view-models";

/* ---------- Header pieces ---------- */
function ScreenHeader({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="cd-screen-head" data-screen-label={title}>
      <div>
        <h1 className="cd-h1">{title}</h1>
        {sub && <p className="cd-sub">{sub}</p>}
      </div>
      {children && <div className="flex items-center gap-2.5">{children}</div>}
    </header>
  );
}

function LiveBadge({ on, onToggle }: { on: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      className="cd-live-pill"
      data-on={on ? "1" : "0"}
      onClick={onToggle}
      aria-pressed={on}
      title={on ? "Live sync on — click to pause" : "Paused — click to resume"}
    >
      <span className={"cd-live-dot" + (on ? " on" : "")}></span>
      {on ? "Live" : "Paused"}
    </button>
  );
}

/* ---------- Focus (top-priority alert) ---------- */
function FocusCard({ app }: { app: DashboardCtx }) {
  const open = app.alerts
    .filter((a) => a.status === "open")
    .sort((a, b) => a.claude_rank - b.claude_rank);
  const focus = open[0];
  if (!focus) {
    return (
      <Card className="cd-focus">
        <Placeholder
          icon="check"
          title="All clear"
          sub="No open alerts. Calderyn keeps watching ad spend and inventory together."
        />
      </Card>
    );
  }
  return (
    <Card className="cd-focus" pad={false}>
      <div className="cd-pad flex flex-col gap-3.5">
        <div className="flex items-center gap-2">
          <SevBadge severity={focus.severity} />
          <span className="cd-caption">
            {DETECTOR_TERMS[focus.detector_id] || focus.detector_id} · {timeAgo(focus.created_at)}
          </span>
          <span className="cd-caption ml-auto">Top priority</span>
        </div>
        <div>
          <h3 className="cd-focus-title">{focus.title}</h3>
          <p className="cd-body mt-1.5" style={{ maxWidth: "56ch" }}>
            {focus.narrative}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <div className="cd-kv">
            <span>At risk</span>
            <b className="tabular-nums" style={{ color: "var(--red)" }}>
              {money(focus.dollar_impact)}/wk
            </b>
          </div>
          {focus.campaign && (
            <div className="cd-kv">
              <span>Campaign</span>
              <b>{focus.campaign}</b>
            </div>
          )}
          {focus.sku && (
            <div className="cd-kv">
              <span>SKU</span>
              <b>{focus.sku}</b>
            </div>
          )}
        </div>
      </div>
      <div className="cd-focus-foot">
        {focus.recommended && (
          <Btn
            kind="primary"
            icon={CD_ACTION_ICON[focus.recommended]}
            onClick={() => app.executeAction(focus, focus.recommended as ActionKind)}
          >
            {ACTION_LABELS[focus.recommended] || "Resolve"}
          </Btn>
        )}
        <Btn icon="chevronRight" onClick={() => app.navigate("alerts", focus.id)}>
          Review
        </Btn>
        {focus.rec_detail && (
          <span className="cd-caption flex-1 text-right">{focus.rec_detail}</span>
        )}
      </div>
    </Card>
  );
}

/* ---------- Activity feed ---------- */
function ActivityFeed({ app, limit = 8, tall }: { app: DashboardCtx; limit?: number; tall?: boolean }) {
  return (
    <Card pad={false} className={"flex flex-col " + (tall ? "h-full" : "")}>
      <div className="cd-pad-x cd-pad-t flex items-center justify-between">
        <h2 className="cd-h2">Activity</h2>
        <LiveBadge on={app.liveOn} onToggle={() => app.setLiveOn(!app.liveOn)} />
      </div>
      <div className="cd-feed">
        {app.feed.length === 0 ? (
          <div className="cd-pad">
            <Placeholder
              icon="scan"
              title="No activity yet"
              sub="Detections, actions, and inventory shifts will stream in here."
            />
          </div>
        ) : (
          app.feed.slice(0, limit).map((ev, i) => (
            <div key={ev.id ?? i} className={"cd-feed-row" + (i === 0 ? " cd-feed-new" : "")}>
              <span className="cd-feed-icon" data-tone={ev.tone}>
                <CDIcon name={ev.icon} size={14} strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="cd-feed-text truncate">{ev.text}</div>
                <div className="cd-caption truncate">{ev.sub}</div>
              </div>
              {ev.ts != null && (
                <span className="cd-caption whitespace-nowrap">{app.relTime(ev.ts)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

/* ---------- Predictor teaser ---------- */
// NOTE: the Predictor screen is simulated/owned by another agent — there is no live
// scorecard in DashboardCtx yet, so this card keeps the prototype's static teaser copy
// and simply links into the predictor route.
// TODO(api): wire to a live `app.overview.predictor` / scorecard summary when available.
function PredictorCard({ app }: { app: DashboardCtx }) {
  return (
    <Card pad={false} className="flex flex-col" onClick={() => app.navigate("predictor")}>
      <div className="cd-pad flex items-center gap-4">
        <RingGauge value={82} size={86} label="score" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h2 className="cd-h2">Creative Predictor</h2>
            <GradePill grade="winning" />
          </div>
          <p className="cd-caption" style={{ maxWidth: "42ch" }}>
            Score a new ad creative before you spend — Calderyn predicts ROAS against your
            break-even and flags weak hooks, offers, and CTAs.
          </p>
          <div className="cd-link mt-2">
            Screen a new creative
            <CDIcon name="chevronRight" size={13} style={{ display: "inline", verticalAlign: "-2px" }} />
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ---------- Autopilot / guardrails ---------- */
function GuardrailCard({ app }: { app: DashboardCtx }) {
  const g = app.guardrails;
  if (!g) {
    return (
      <Card className="flex flex-col gap-3">
        <h2 className="cd-h2">Autopilot</h2>
        <Placeholder icon="shield" title="Loading guardrails" sub="Autopilot limits will appear here." />
      </Card>
    );
  }
  const cap = g.daily_action_budget_cents || 0;
  const used = g.daily_action_budget_used_cents || 0;
  const usedPct = cap > 0 ? (used / cap) * 100 : 0;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="cd-h2">Autopilot</h2>
        <Pill
          tone={g.autopilot_enabled ? "success" : "neutral"}
          icon={g.autopilot_enabled ? "check" : "pause"}
        >
          {g.autopilot_enabled ? "On" : "Off"}
        </Pill>
        <button className="cd-link ml-auto" onClick={() => app.navigate("settings")}>
          Guardrails
          <CDIcon name="chevronRight" size={13} style={{ display: "inline", verticalAlign: "-2px" }} />
        </button>
      </div>
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="cd-caption">Daily action budget</span>
          <span className="cd-caption tabular-nums">
            <b style={{ color: "var(--text-1)" }}>{money(used)}</b> of {money(cap)}
          </span>
        </div>
        <Meter pct={usedPct} tone={usedPct > 85 ? "warn" : "accent"} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="cd-mini-stat">
          <b>
            {g.autopilot_actions_today}/{g.autopilot_daily_action_cap}
          </b>
          <span>actions today</span>
        </div>
        <div className="cd-mini-stat">
          <b>{g.cooldown_minutes}m</b>
          <span>cooldown</span>
        </div>
        <div className="cd-mini-stat">
          <b>{g.autopilot_max_budget_cut_pct}%</b>
          <span>max budget cut</span>
        </div>
      </div>
    </Card>
  );
}

/* ---------- Screen ---------- */
export default function Dashboard({ app }: { app: DashboardCtx }) {
  const open = app.alerts.filter((a) => a.status === "open");
  const critical = open.filter((a) => a.severity === "critical");

  // Recovered (7d) — same shared computation as the extension home
  // (app/lib/recovered.ts): succeeded actions, undo rows excluded, windowed to
  // the trailing 7 days so the number matches the "(7d)" label.
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recovered7d = recoveredWithin(app.audit, sinceIso);

  // Daily action budget — same guardrail numbers the embedded extension shows.
  const g = app.guardrails;
  const budgetCap = g?.daily_action_budget_cents ?? 0;
  const budgetUsed = g?.daily_action_budget_used_cents ?? 0;
  const budgetLeft = Math.max(0, budgetCap - budgetUsed);
  const budgetPct = budgetCap > 0 ? (budgetUsed / budgetCap) * 100 : 0;

  const topAlerts: AlertVM[] = [...open]
    .sort((a, b) => a.claude_rank - b.claude_rank)
    .slice(1, 4);

  const series = app.overview?.roas_series ?? [];

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="cd-screen">
      <ScreenHeader title={greet} sub="Watching ad spend and inventory — together.">
        <LiveBadge on={app.liveOn} onToggle={() => app.setLiveOn(!app.liveOn)} />
        <Btn icon="bell" onClick={() => app.navigate("alerts")} small>
          All alerts
        </Btn>
      </ScreenHeader>

      {/* Stat row */}
      <div className="cd-stat-grid">
        <Card hover onClick={() => app.navigate("alerts")} className="cd-stat">
          <span className="cd-stat-label">Open alerts</span>
          <span className="cd-stat-value" style={critical.length ? { color: "var(--red)" } : undefined}>
            {open.length}
          </span>
          <span className="cd-caption">
            {critical.length ? `${critical.length} critical` : "clear of critical"}
          </span>
        </Card>
        <Card hover onClick={() => app.navigate("audit")} className="cd-stat">
          <span className="cd-stat-label">Recovered (7d)</span>
          <span className="cd-stat-value" style={{ color: "var(--green)" }}>
            <CountMoney cents={recovered7d.cents} />
          </span>
          <span className="cd-caption">
            across {recovered7d.count} action{recovered7d.count === 1 ? "" : "s"}
          </span>
        </Card>
        <Card hover onClick={() => app.navigate("settings")} className="cd-stat">
          <span className="cd-stat-label">Daily action budget</span>
          {g ? (
            <>
              <Meter pct={budgetPct} tone={budgetPct > 85 ? "warn" : "accent"} />
              <span className="cd-caption tabular-nums">
                {money(budgetLeft)} left today
              </span>
            </>
          ) : (
            <span className="cd-caption">unavailable</span>
          )}
        </Card>
        <Card hover onClick={() => app.navigate("campaigns")} className="cd-stat">
          <span className="cd-stat-label">Real ad return (7d)</span>
          <span className="cd-stat-value tabular-nums">{trueRoas(app.campaigns)}</span>
          <span className="cd-caption">margin-adjusted ROAS, all campaigns</span>
        </Card>
      </div>

      {/* Focus + feed */}
      <div className="cd-grid-main">
        <div className="flex flex-col gap-4 min-w-0">
          <FocusCard app={app} />
          <Card pad={false}>
            <div className="cd-pad-x cd-pad-t flex items-center justify-between">
              <h2 className="cd-h2">Revenue vs ad spend</h2>
              <span className="cd-caption">30 days · blended</span>
            </div>
            <div className="cd-pad" style={{ paddingTop: 8 }}>
              {series.length > 1 ? (
                <AreaChart rows={series} live={app.liveOn} />
              ) : (
                <Placeholder
                  icon="chart"
                  title={app.overview === null ? "Loading chart" : "No history yet"}
                  sub="Revenue and ad spend for the last 30 days will plot here once data is in."
                />
              )}
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <ActivityFeed app={app} limit={7} tall />
        </div>
      </div>

      {/* Needs attention */}
      {topAlerts.length > 0 && (
        <section>
          <SectionTitle action="All alerts" onAction={() => app.navigate("alerts")}>
            Needs attention
          </SectionTitle>
          <div className="cd-attn-grid">
            {topAlerts.map((a) => (
              <Card
                key={a.id}
                hover
                onClick={() => app.navigate("alerts", a.id)}
                className="flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <SevBadge severity={a.severity} />
                  <span className="cd-caption truncate">
                    {DETECTOR_TERMS[a.detector_id] || a.detector_id}
                  </span>
                </div>
                <div className="cd-h3">{a.title}</div>
                <div className="cd-caption truncate">{a.sku || a.campaign}</div>
                <div className="cd-kv mt-auto">
                  <span>At risk</span>
                  <b className="tabular-nums" style={{ color: "var(--red)" }}>
                    {money(a.dollar_impact)}/wk
                  </b>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Predictor + autopilot */}
      <div className="cd-grid-duo">
        <PredictorCard app={app} />
        <GuardrailCard app={app} />
      </div>
    </div>
  );
}
