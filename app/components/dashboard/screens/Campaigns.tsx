// Calderyn DashV2 — Campaigns screen (LIVE).
// Ported from the prototype's screen-campaigns.jsx, wired to the live DashboardCtx.
// List (from app.campaigns, grade-joined from fetchAnalytics) + detail (stats,
// break-even sparkline, guardrailed pause / resume / cut-budget actions).
// CD.* globals → live imports: money (format), CDIcon (icons),
// Card/GradePill/PlatformMark/Sparkline/Pill/Btn/Segmented/Placeholder/CountMoney (ui).
import { useEffect, useState, type ReactNode } from "react";
import {
  Card,
  SectionTitle,
  GradePill,
  PlatformMark,
  Sparkline,
  Pill,
  Btn,
  Segmented,
  Placeholder,
  CountMoney,
  Tooltip,
} from "../ui";
import { money } from "../format";
import { CDIcon } from "../icons";
import { fetchAnalytics, executeCampaignAction, DashboardApiError, fetchCampaignDirection, type CampaignDirectionDTO } from "~/lib/dashboard/client";
import { sortActiveFirst } from "~/lib/campaign-sort";
import { scaleReason as buildScaleReason } from "~/lib/scale-reason";
import type { DashboardCtx } from "../context";
import type { CampaignVM, Platform } from "../view-models";
import type { CampaignGradeRow } from "~/lib/types";

const DIR_PILL: Record<string, { label: string; tone: "success" | "warn" | "critical" | "neutral"; icon?: string }> = {
  scale_up: { label: "Scale up", tone: "success", icon: "arrowUpRight" },
  keep: { label: "Keep", tone: "neutral" },
  scale_down: { label: "Scale down", tone: "warn", icon: "reduce" },
  pause: { label: "Pause", tone: "critical", icon: "pause" },
};

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
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

/* ---------- List row ---------- */
function CampaignRow({
  c,
  onClick,
  scaleReason,
}: {
  c: CampaignVM;
  onClick: () => void;
  /** Plain-language "why scale" reason; null = no suggestion (no pill). */
  scaleReason: string | null;
}) {
  const losing = c.roas_7d < c.breakeven_roas;
  return (
    <button className="cd-row" onClick={onClick} data-dim={c.status === "paused" ? "1" : "0"}>
      <PlatformMark platform={c.platform} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="cd-row-title truncate">{c.name}</span>
          {c.status === "paused" ? <Pill icon="pause">Paused</Pill> : <GradePill grade={c.grade} />}
          {scaleReason && (
            <Tooltip content={scaleReason}>
              <Pill icon="arrowUpRight">Scale</Pill>
            </Tooltip>
          )}
        </div>
        <div className="cd-caption tabular-nums">
          {money(c.daily_budget_cents)}/day · {money(c.spend_7d)} spent (7d) · break-even{" "}
          {c.breakeven_roas.toFixed(1)}×
        </div>
      </div>
      {/* Only draw the break-even sparkline when a real per-campaign series exists. */}
      {c.trend && c.trend.length > 1 && (
        <Sparkline
          data={c.trend}
          refLine={c.breakeven_roas}
          stroke={losing ? "var(--red)" : "var(--green)"}
        />
      )}
      <div className="text-right whitespace-nowrap" style={{ width: 64 }}>
        <div
          className="cd-row-num tabular-nums"
          style={{ color: losing ? "var(--red)" : "var(--green)" }}
        >
          {c.roas_7d.toFixed(1)}×
        </div>
        <div className="cd-caption">ROAS 7d</div>
      </div>
      <CDIcon name="chevronRight" size={16} style={{ color: "var(--text-3)", flexShrink: 0 }} />
    </button>
  );
}

/* ---------- Detail ---------- */
function CampaignDetail({
  app,
  c,
  onBack,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  onBack: () => void;
}) {
  // The live status can drift from app.campaigns until the next refresh lands,
  // so hold the optimistic status locally and prefer it for rendering.
  const [status, setStatus] = useState(c.status);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<CampaignDirectionDTO | null>(null);
  useEffect(() => {
    let live = true;
    fetchCampaignDirection(c.id)
      .then((d) => { if (live) setDirection(d); })
      .catch(() => { if (live) setDirection(null); });
    return () => { live = false; };
  }, [c.id]);
  // Keep in sync if app.campaigns refreshes underneath us with a new value.
  useEffect(() => {
    setStatus(c.status);
  }, [c.status]);

  const losing = c.roas_7d < c.breakeven_roas;
  const paused = status === "paused";

  const scaleAlert = app.alerts.find(
    (a) => a.campaign_id === c.id && a.status === "open" && a.detector_id === "campaign_scaling_opportunity",
  );
  const scalePct = app.guardrails?.autopilot_max_budget_increase_pct ?? 20;
  const scaleTarget = Math.round(c.daily_budget_cents * (1 + scalePct / 100));

  const run = async (
    type: "pause_campaign" | "resume_campaign" | "reduce_campaign_budget" | "increase_campaign_budget",
    successText: string,
    nextStatus: string,
    dailyBudgetCents?: number,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, {
        type,
        ...(type === "reduce_campaign_budget"
          ? { dailyBudgetCents: dailyBudgetCents ?? Math.round(c.daily_budget_cents * 0.7) }
          : type === "increase_campaign_budget"
            ? { dailyBudgetCents: dailyBudgetCents ?? Math.round(c.daily_budget_cents * 1.2) }
            : {}),
      });
      setStatus(nextStatus);
      app.refresh();
      app.toast(
        successText,
        type === "pause_campaign"
          ? "pause"
          : type === "resume_campaign"
            ? "play"
            : type === "increase_campaign_budget"
              ? "arrowUpRight"
              : "reduce",
      );
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Action failed — please try again.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  const directionActable =
    direction != null &&
    direction.actionKind != null &&
    (direction.actionKind === "pause_campaign" || direction.suggestedBudgetCents != null);

  const runDirection = () => {
    if (!direction?.actionKind) return;
    const verb =
      direction.direction === "scale_up" ? "Budget scaled"
      : direction.direction === "scale_down" ? "Budget reduced"
      : direction.direction === "keep" ? "No action taken"
      : "Campaign paused";
    const nextStatus = direction.actionKind === "pause_campaign" ? "paused" : status;
    run(direction.actionKind, `${verb} — logged to action history.`, nextStatus, direction.suggestedBudgetCents ?? undefined);
  };

  return (
    <div className="cd-screen" data-screen-label="Campaign detail">
      <button className="cd-back" onClick={onBack}>
        <CDIcon name="chevronLeft" size={15} />
        Campaigns
      </button>
      <header className="cd-screen-head" style={{ marginTop: 4 }}>
        <div>
          <div className="flex items-center gap-2 mb-2">
            <PlatformMark platform={c.platform} />
            <span className="cd-caption">
              {c.platform} · {paused ? "Paused" : "Active"}
            </span>
            <GradePill grade={c.grade} />
          </div>
          <h1 className="cd-h1" style={{ maxWidth: "24ch" }}>
            {c.name}
          </h1>
        </div>
        <div className="flex items-center gap-2.5">
          {paused ? (
            <Btn
              icon="play"
              disabled={busy}
              onClick={() => run("resume_campaign", "Campaign resumed.", "active")}
            >
              Resume
            </Btn>
          ) : (
            <Btn
              icon="pause"
              disabled={busy}
              onClick={() =>
                run("pause_campaign", `Campaign paused — syncing to ${c.platform}.`, "paused")
              }
            >
              Pause
            </Btn>
          )}
          <Btn
            icon="reduce"
            disabled={busy}
            onClick={() =>
              run(
                "reduce_campaign_budget",
                "Budget reduced 30% — logged to action history.",
                status,
              )
            }
          >
            Cut budget 30%
          </Btn>
          {!paused && scaleAlert && (
            <Btn
              icon="arrowUpRight"
              disabled={busy}
              onClick={() =>
                run(
                  "increase_campaign_budget",
                  `Budget scaled +${scalePct}% — logged to action history.`,
                  status,
                  scaleTarget,
                )
              }
            >
              Scale +{scalePct}%
            </Btn>
          )}
        </div>
      </header>

      {direction && (
        <Card>
          <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
            <span className="cd-h2">Recommended direction</span>
            <Pill tone={DIR_PILL[direction.direction].tone} icon={DIR_PILL[direction.direction].icon}>
              {DIR_PILL[direction.direction].label}
            </Pill>
          </div>
          <p className="cd-body">{direction.reason}</p>
          {directionActable && (
            <div style={{ marginTop: 10 }}>
              <Btn icon={DIR_PILL[direction.direction].icon} disabled={busy} onClick={runDirection}>
                {DIR_PILL[direction.direction].label}
              </Btn>
            </div>
          )}
        </Card>
      )}

      <div className="cd-stat-grid">
        <Card className="cd-stat">
          <span className="cd-stat-label">ROAS (7d)</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: losing ? "var(--red)" : "var(--green)" }}
          >
            {c.roas_7d.toFixed(1)}×
          </span>
          <span className="cd-caption">break-even {c.breakeven_roas.toFixed(1)}×</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Spend (7d)</span>
          <span className="cd-stat-value">
            <CountMoney cents={c.spend_7d} />
          </span>
          <span className="cd-caption tabular-nums">{money(c.daily_budget_cents)}/day budget</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Contribution margin</span>
          <span className="cd-stat-value tabular-nums">
            {Math.round(c.contribution_margin * 100)}%
          </span>
          <span className="cd-caption">
            margin-adjusted ROAS {(c.roas_7d * c.contribution_margin).toFixed(1)}×
          </span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Break-even ROAS</span>
          <span className="cd-stat-value tabular-nums">{c.breakeven_roas.toFixed(1)}×</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Profit ROAS (POAS)</span>
          <span className="cd-stat-value tabular-nums">
            {c.roas_7d > 0 && c.contribution_margin > 0 ? `${(c.roas_7d * c.contribution_margin).toFixed(1)}×` : "—"}
          </span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">7-day trend</span>
          {/* No per-campaign roas series exists yet. TODO(api): per-campaign trend. */}
          {c.trend && c.trend.length > 1 ? (
            <>
              <div style={{ marginTop: 6 }}>
                <Sparkline
                  data={c.trend}
                  width={150}
                  height={40}
                  refLine={c.breakeven_roas}
                  stroke={losing ? "var(--red)" : "var(--green)"}
                />
              </div>
              <span className="cd-caption">dashed = break-even</span>
            </>
          ) : (
            <span className="cd-caption">No daily series yet.</span>
          )}
        </Card>
      </div>

      {!paused && scaleAlert && (
        <Card>
          <SectionTitle>Scale opportunity</SectionTitle>
          <p className="cd-body" style={{ margin: "8px 0 12px" }}>
            This campaign is winning — earning{" "}
            <b className="tabular-nums">{c.roas_7d.toFixed(1)}×</b> on ad spend. Raising its daily
            budget {scalePct}% (
            <span className="tabular-nums">
              {money(c.daily_budget_cents)} → {money(scaleTarget)}
            </span>
            ) projects about{" "}
            <b className="tabular-nums" style={{ color: "var(--green)" }}>
              +{money(scaleAlert.dollar_impact)}/mo
            </b>{" "}
            more profit if it keeps performing.
          </p>
          <Btn
            icon="arrowUpRight"
            disabled={busy}
            onClick={() =>
              run(
                "increase_campaign_budget",
                `Budget scaled +${scalePct}% — logged to action history.`,
                status,
                scaleTarget,
              )
            }
          >
            Scale +{scalePct}%
          </Btn>
        </Card>
      )}

      {(() => {
        // Open alerts attributed to this campaign (live source: app.alerts).
        const open = app.alerts.filter(
          (a) => a.campaign_id === c.id && a.status === "open",
        );
        if (open.length === 0) return null;
        return (
          <Card pad={false}>
            <div className="cd-pad-x cd-pad-t">
              <SectionTitle>Open alerts on this campaign</SectionTitle>
            </div>
            <div className="cd-rows">
              {open.map((a) => (
                <button
                  key={a.id}
                  className="cd-row"
                  onClick={() => app.navigate("alerts", a.id)}
                >
                  <span className={`cd-sev-bar sev-${a.severity}`} />
                  <span className="cd-row-title flex-1">{a.title}</span>
                  <span className="cd-row-num tabular-nums">{money(a.dollar_impact)}/wk</span>
                  <CDIcon name="chevronRight" size={14} />
                </button>
              ))}
            </div>
          </Card>
        );
      })()}

      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="shield" size={13} /> Guardrails apply — every action is reversible and logged
        to your action history.
      </p>
    </div>
  );
}

/* ---------- Screen ---------- */
type PlatformFilter = "All" | Platform;

export default function Campaigns({ app }: { app: DashboardCtx }) {
  const [platform, setPlatform] = useState<PlatformFilter>("All");
  // Real grades + break-even come from fetchAnalytics(); join by campaign_id.
  // While this is in flight the campaigns render with whatever grade they carry.
  const [grades, setGrades] = useState<CampaignGradeRow[]>([]);

  useEffect(() => {
    let alive = true;
    fetchAnalytics()
      .then((res) => {
        if (alive) setGrades(res.grades);
      })
      .catch(() => {
        // Non-fatal: the list still renders with default grades.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Join the live grades onto each campaign (grade + break-even). Memo-free: the
  // join is cheap and keeps the map fresh whenever grades or campaigns change.
  const gradeFor = (id: string) => grades.find((g) => g.campaign_id === id);
  const joined: CampaignVM[] = app.campaigns.map((c) => {
    const g = gradeFor(c.id);
    if (!g) return c;
    const grade = (["winning", "okay", "poor"] as const).includes(g.grade as never)
      ? (g.grade as CampaignVM["grade"])
      : c.grade;
    return { ...c, grade, breakeven_roas: g.break_even_roas };
  });

  // Row-click / deep-link: nav.param carries the selected campaign id.
  const selected = app.nav.param ? joined.find((c) => c.id === app.nav.param) : null;
  if (selected) {
    return <CampaignDetail app={app} c={selected} onBack={() => app.navigate("campaigns")} />;
  }

  // Active campaigns sort to the top; within each status group, highest 7d
  // spend first. Paused rows still render (dimmed via CampaignRow's data-dim),
  // just pushed below the active ones.
  const shown = sortActiveFirst(
    joined.filter((c) => platform === "All" || c.platform === platform),
    (a, b) => b.spend_7d - a.spend_7d,
  );

  const totalSpend = joined.reduce((s, c) => s + c.spend_7d, 0);
  const withData = joined.filter((c) => c.spend_7d > 0 && c.status === "active");
  const trueRoas =
    withData.reduce((s, c) => s + c.spend_7d * c.roas_7d * c.contribution_margin, 0) /
    Math.max(1, withData.reduce((s, c) => s + c.spend_7d, 0));

  const loading = app.loading && app.campaigns.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Campaigns"
        sub={
          loading
            ? "Loading campaigns from your ad accounts…"
            : `${money(totalSpend)} spent across 7 days · true ROAS ${trueRoas.toFixed(
                1,
              )}× (margin-adjusted)`
        }
      >
        <Segmented
          small
          value={platform}
          onChange={(v) => setPlatform(v as PlatformFilter)}
          options={["All", "Meta", "Google", "TikTok"]}
        />
      </ScreenHeader>
      <Card pad={false}>
        {loading ? (
          <Placeholder icon="megaphone" title="Loading campaigns" sub="Pulling spend and ROAS from Meta, Google and TikTok." />
        ) : shown.length === 0 ? (
          <Placeholder
            icon="megaphone"
            title={app.campaigns.length === 0 ? "No campaigns yet" : "Nothing here"}
            sub={
              app.campaigns.length === 0
                ? "Connect an ad account and your campaigns will appear here."
                : "No campaigns match this platform filter."
            }
          />
        ) : (
          <div className="cd-rows">
            {shown.map((c) => {
              const scaleAlert = app.alerts.find(
                (a) =>
                  a.campaign_id === c.id &&
                  a.status === "open" &&
                  a.detector_id === "campaign_scaling_opportunity",
              );
              const hint = scaleAlert
                ? buildScaleReason(
                    c.roas_7d > 0 ? c.roas_7d : null,
                    app.guardrails?.autopilot_max_budget_increase_pct ?? 20,
                    scaleAlert.dollar_impact,
                  )
                : null;
              return (
                <CampaignRow
                  key={c.id}
                  c={c}
                  onClick={() => app.navigate("campaigns", c.id)}
                  scaleReason={hint}
                />
              );
            })}
          </div>
        )}
      </Card>
      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="chart" size={13} /> True ROAS weights each campaign&apos;s return by spend and
        contribution margin — what&apos;s left after product costs.
      </p>
    </div>
  );
}
