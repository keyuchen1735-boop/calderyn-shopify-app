import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IMPACT_SUFFIX } from "~/lib/impact-window";
import { trueRoas } from "~/lib/roas";
import { gradeFromRow } from "~/lib/campaign-grade";
import { isSourceDisconnected } from "~/lib/integration-status";
import {
  Card,
  SectionTitle,
  ScorePill,
  PlatformMark,
  Sparkline,
  Pill,
  Btn,
  Segmented,
  Placeholder,
  CountMoney,
  Tooltip,
} from "../ui";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import { money } from "../format";
import { CDIcon } from "../icons";
import { fetchAnalytics, executeCampaignAction, DashboardApiError, fetchCampaignDirection, fetchCampaignCreatives, scoreCampaignAd, regenerateCampaign, screenCampaignCreative, type CampaignDirectionDTO, type CampaignCreativesDTO, type CampaignCreativeDTO, type AdScorecardDTO, type RegenerateDTO, type ScreenCreativePayload } from "~/lib/dashboard/client";
import AdScorecardPanel from "../AdScorecardPanel";
import type { Variant, CreativeScreenRun } from "~/lib/screener/types";
import { sortActiveFirst } from "~/lib/campaign-sort";
import { scaleReason as buildScaleReason } from "~/lib/scale-reason";
import type { DashboardCtx } from "../context";
import type { CampaignVM, Platform } from "../view-models";
import type { CampaignGradeRow } from "~/lib/types";

const PENDING_SCORE: CampaignCalderynScore = {
  value: null, band: "nodata", performance: null, creative: null, confidence: "low",
  weakDimensions: [], tips: [], adsCovered: 0, adsTotal: 0,
};

const DIR_PILL: Record<string, { label: string; tone: "success" | "warn" | "critical" | "neutral"; icon?: string }> = {
  scale_up: { label: "Scale up", tone: "success", icon: "arrowUpRight" },
  keep: { label: "Keep", tone: "neutral" },
  scale_down: { label: "Scale down", tone: "warn", icon: "reduce" },
  pause: { label: "Pause", tone: "critical", icon: "pause" },
};

/* ---------- Header ---------- */
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
  staleSource,
}: {
  c: CampaignVM;
  onClick: () => void;
  /** Plain-language "why scale" reason; null = no suggestion (no pill). */
  scaleReason: string | null;
  /** The campaign's ad platform is disconnected — its data may be stale (P2-16). */
  staleSource?: boolean;
}) {
  const losing = c.roas_7d < c.breakeven_roas;
  return (
    <button className="cd-row" onClick={onClick} data-dim={c.status === "paused" ? "1" : "0"}>
      <PlatformMark platform={c.platform} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="cd-row-title truncate">{c.name}</span>
          {c.status === "paused" ? (
            <Pill icon="pause">Paused</Pill>
          ) : (
            <ScorePill score={c.calderynScore ?? PENDING_SCORE} />
          )}
          {staleSource && (
            <Tooltip content="This ad platform is disconnected — its data may be out of date.">
              <Pill tone="warn" icon="clock">Stale</Pill>
            </Tooltip>
          )}
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

  const [creativeData, setCreativeData] = useState<CampaignCreativesDTO | null>(null);
  // Distinct from `creativeData == null` (still loading): a fetch failure must
  // not masquerade as "not connected" — that would show misleading Meta-connect
  // guidance on a transient network/5xx error (rule 12, fail visibly).
  const [creativesLoadError, setCreativesLoadError] = useState(false);
  const [scored, setScored] = useState<Record<string, AdScorecardDTO>>({});
  const [scoring, setScoring] = useState<string | null>(null);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [regenBusy, setRegenBusy] = useState(false);
  const [screenRun, setScreenRun] = useState<CreativeScreenRun | null>(null);
  const [screenBusy, setScreenBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setCreativesLoadError(false);
    fetchCampaignCreatives(c.id)
      .then((d) => { if (live) setCreativeData(d); })
      .catch(() => { if (live) setCreativesLoadError(true); });
    return () => { live = false; };
  }, [c.id]);

  const cachedByAd = useMemo(() => {
    const m: Record<string, AdScorecardDTO> = {};
    for (const s of creativeData?.scorecards ?? []) m[s.adId] = s;
    return m;
  }, [creativeData?.scorecards]);

  const scoreAd = async (ad: CampaignCreativeDTO) => {
    setScoring(ad.adId);
    try {
      const sc = await scoreCampaignAd(c.id, {
        adId: ad.adId,
        headline: ad.creative.headline,
        primaryText: ad.creative.primaryText,
        cta: ad.creative.cta,
        destinationUrl: ad.creative.destinationUrl,
        audience: ad.creative.audience,
        imageUrl: ad.creative.imageUrl,
        assumedSpendCents: creativeData?.assumedSpendCents ?? 50000,
      });
      setScored((m) => ({ ...m, [ad.adId]: sc }));
    } catch {
      app.toast("Couldn't score this ad — try again.", "x", "critical");
    } finally {
      setScoring(null);
    }
  };

  const runRegen = async () => {
    const adIds = (creativeData?.creatives ?? []).map((x) => x.adId).filter(Boolean);
    if (adIds.length === 0) { app.toast("No creatives to regenerate yet.", "x", "critical"); return; }
    setRegenBusy(true);
    try {
      const res: RegenerateDTO = await regenerateCampaign(c.id, adIds, creativeData?.assumedSpendCents ?? 50000);
      if (res.ok) {
        setVariants(res.variants);
        app.toast(res.variants.length > 0 ? `Generated ${res.variants.length} stronger variant(s).` : "No variant beat the original.", "sparkle", "success");
      } else {
        app.toast("Regenerate unavailable — score this campaign's ads first.", "x", "critical");
      }
    } catch {
      app.toast("Regenerate failed — try again.", "x", "critical");
    } finally {
      setRegenBusy(false);
    }
  };

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
            <ScorePill score={c.calderynScore ?? PENDING_SCORE} />
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

      {/* Creatives — per-ad predictive scorecards (cached now; score on demand) */}
      <Card pad={false}>
        <SectionTitle>Creatives</SectionTitle>
        <div style={{ padding: 16 }}>
          {creativesLoadError ? (
            <Placeholder icon="megaphone" title="Couldn't load creatives" sub="Refresh to retry." />
          ) : !creativeData ? (
            <Placeholder icon="scan" title="Loading creatives…" />
          ) : !creativeData.metaConnected ? (
            <Placeholder icon="megaphone" title="Connect Meta to score creatives" sub="No score is fabricated until your ad account is connected." />
          ) : creativeData.creatives.length === 0 ? (
            <Placeholder icon="megaphone" title="No ads on this campaign yet" />
          ) : (
            <div className="flex flex-col gap-6">
              {creativeData.creatives.map((ad) => {
                const sc = scored[ad.adId] ?? cachedByAd[ad.adId];
                return (
                  <div key={ad.adId} className="flex flex-col gap-2">
                    <span style={{ fontWeight: 600 }}>{ad.adName || ad.adId}</span>
                    {sc && sc.status === "done" && sc.scorecard ? (
                      <AdScorecardPanel card={sc.scorecard} />
                    ) : sc && sc.status === "error" ? (
                      <span className="cd-caption">Analysis unavailable: {sc.error}</span>
                    ) : (
                      <Btn icon="scan" disabled={!!scoring} onClick={() => scoreAd(ad)}>
                        {scoring === ad.adId ? "Scoring…" : "Score this ad"}
                      </Btn>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Regenerate — copy variants seeded from the weakest scored ad */}
      <Card>
        <SectionTitle>Regenerate copy</SectionTitle>
        <p className="cd-body">Rewrites the campaign&apos;s weakest creative, re-scores each rewrite, and keeps only ones that beat it.</p>
        <div style={{ marginTop: 10 }}>
          <Btn icon="sparkle" kind="primary" disabled={regenBusy} onClick={runRegen}>
            {regenBusy ? "Generating…" : "Regenerate"}
          </Btn>
        </div>
        {variants.length > 0 && (
          <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
            {variants.map((v) => (
              <div key={v.mode + v.input.headline} style={{ background: "var(--cd-surface-2, #f5f5f5)", borderRadius: 12, padding: "12px 14px" }}>
                <div className="flex items-center gap-2">
                  <Pill tone="accent">{v.mode}</Pill>
                  <span style={{ fontWeight: 600 }}>{v.composite}</span>
                  <span className="cd-caption" style={{ color: "var(--cd-success, #1a7f37)" }}>+{v.delta}</span>
                </div>
                <p className="cd-body" style={{ marginTop: 6 }}>&ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}</p>
                <p className="cd-caption">{v.rationale}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Screen a new creative — drop-in scoring scoped to this campaign */}
      <Card>
        <SectionTitle>Screen a new creative</SectionTitle>
        <ScreenNewCreative
          busy={screenBusy}
          run={screenRun}
          onSubmit={async (payload) => {
            setScreenBusy(true);
            try {
              setScreenRun(await screenCampaignCreative(c.id, payload));
            } catch {
              app.toast("Couldn't screen that creative — check the image URL and try again.", "x", "critical");
            } finally {
              setScreenBusy(false);
            }
          }}
        />
      </Card>

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
                  <span className="cd-row-num tabular-nums">{money(a.dollar_impact)}{IMPACT_SUFFIX}</span>
                  <CDIcon name="chevronRight" size={14} />
                </button>
              ))}
            </div>
          </Card>
        );
      })()}

      {(() => {
        const s = c.calderynScore ?? PENDING_SCORE;
        return (
          <Card>
            <SectionTitle>Calderyn score</SectionTitle>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
              <ScorePill score={s} />
              <span className="cd-caption">Performance {s.performance != null ? s.performance : "—"}</span>
              <span className="cd-caption">Creative {s.creative != null ? s.creative : "—"}</span>
              <Pill>{`Confidence: ${s.confidence}`}</Pill>
              <span className="cd-caption">{`Ads scored ${s.adsCovered}/${s.adsTotal}`}</span>
            </div>
            {(s.performance == null || s.creative == null) && (
              <p className="cd-caption">
                {s.performance == null ? "Performance pending — attribution." : ""}
                {" "}
                {s.creative == null ? "Connect your Meta integration to score this campaign's creatives." : ""}
              </p>
            )}
          </Card>
        );
      })()}

      {(() => {
        const s = c.calderynScore ?? PENDING_SCORE;
        if (s.weakDimensions.length === 0 && s.tips.length === 0) return null;
        return (
          <Card pad={false}>
            <div className="cd-pad-x cd-pad-t">
              <SectionTitle>How to improve</SectionTitle>
            </div>
            <div className="cd-rows">
              {s.weakDimensions.map((d, i) => (
                <div key={`wd-${d.adId}-${i}`} className="cd-row">
                  <span>{d.label}</span>
                  <Pill tone="warn">{d.score}</Pill>
                </div>
              ))}
              {s.tips.map((t, i) => (
                <div key={`tip-${i}`} className="cd-row">
                  <CDIcon name="sparkle" size={14} />
                  <span>{t}</span>
                </div>
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

function ScreenNewCreative({
  busy,
  run,
  onSubmit,
}: {
  busy: boolean;
  run: CreativeScreenRun | null;
  onSubmit: (payload: ScreenCreativePayload) => void;
}) {
  const [f, setF] = useState({ headline: "", primaryText: "", cta: "SHOP_NOW", destinationUrl: "", audience: "", imageUrl: "" });
  return (
    <div className="flex flex-col gap-3">
      <label className="cd-field"><span>Headline</span><input className="cd-input" value={f.headline} onChange={(e) => setF({ ...f, headline: e.target.value })} /></label>
      <label className="cd-field"><span>Primary text</span><textarea className="cd-input" rows={3} value={f.primaryText} onChange={(e) => setF({ ...f, primaryText: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="cd-field"><span>Call to action</span><input className="cd-input" value={f.cta} onChange={(e) => setF({ ...f, cta: e.target.value })} /></label>
        <label className="cd-field"><span>Audience</span><input className="cd-input" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></label>
      </div>
      <label className="cd-field"><span>Where the click goes</span><input className="cd-input" value={f.destinationUrl} onChange={(e) => setF({ ...f, destinationUrl: e.target.value })} /></label>
      <label className="cd-field"><span>Image URL (https)</span><input className="cd-input" value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} /></label>
      <div>
        <Btn icon="scan" kind="primary" disabled={busy || !f.imageUrl} onClick={() => onSubmit({ ...f, mediaKind: "image", assumedSpendCents: 50000 })}>
          {busy ? "Scoring…" : "Score creative"}
        </Btn>
      </div>
      {run?.scorecard && <AdScorecardPanel card={run.scorecard} />}
      {run && run.status === "error" && <span className="cd-caption">Couldn&apos;t score: {run.error}</span>}
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
    // Resolve via the shared grader so a no-revenue grade row shows "no data"
    // not "poor" (P1-6) — same logic adaptCampaign uses for the initial load.
    return { ...c, grade: gradeFromRow(g, c.roas_7d), breakeven_roas: g.break_even_roas };
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
  // Margin-adjusted "true ROAS" via the shared helper so this header matches the
  // Overview "Real ad return" exactly — it was a divergent inline formula here
  // (different filter: active-only, kept the margin===0 no-data sentinel), which
  // is why the same metric read differently per page (P1-3).
  const trueRoasLabel = trueRoas(app.campaigns);

  const loading = app.loading && app.campaigns.length === 0;

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Campaigns"
        sub={
          loading
            ? "Loading campaigns from your ad accounts…"
            : `${money(totalSpend)} spent across 7 days · true ROAS ${trueRoasLabel} (margin-adjusted)`
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
                  staleSource={isSourceDisconnected(c.platform, app.integrations)}
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
