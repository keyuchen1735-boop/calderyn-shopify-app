import { useEffect, useMemo, useState, type ReactNode } from "react";
import { IMPACT_SUFFIX } from "~/lib/impact-window";
import { trueRoas } from "~/lib/roas";
import { gradeFromRow } from "~/lib/campaign-grade";
import { isSourceDisconnected } from "~/lib/integration-status";
import {
  Card,
  SectionTitle,
  Sparkline,
  Pill,
  Btn,
  Segmented,
  Placeholder,
  CountMoney,
  Tooltip,
} from "../ui";
import { scorePillStyle } from "../score-pill";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import { money } from "../format";
import { CDIcon } from "../icons";
import { fetchAnalytics, executeCampaignAction, pushCreativeDraft, DashboardApiError, fetchCampaignDirection, fetchCampaignCreatives, scoreCampaignAd, regenerateCampaign, screenCampaignCreative, type CampaignDirectionDTO, type CampaignCreativesDTO, type CampaignCreativeDTO, type AdScorecardDTO, type RegenerateDTO, type ScreenCreativePayload } from "~/lib/dashboard/client";
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

/** Shared column template for the campaigns table (header + rows). */
const CAMP_GRID = "minmax(0,1fr) 72px 96px 68px 54px 22px";

const BADGE_ACTIVE = { color: "var(--green)", background: "var(--green-bg)" } as const;
const BADGE_NEUTRAL = { color: "var(--text-2)", background: "var(--gray-bg)" } as const;

/** Band-tinted styles for the numeric score chip (mirrors ScorePill tones). */
const BAND_CHIP: Record<CampaignCalderynScore["band"], { color: string; background: string }> = {
  strong: { color: "var(--green)", background: "var(--green-bg)" },
  fair: { color: "var(--orange)", background: "var(--orange-bg)" },
  weak: { color: "var(--red)", background: "var(--red-bg)" },
  nodata: { color: "var(--text-2)", background: "var(--gray-bg)" },
};

/** Numeric Calderyn-score chip; blank scores render an em dash, never a made-up
 *  number. The label ScorePill shows ("82 · Strong") rides a plain title attr —
 *  the shared Tooltip wrapper is focusable, which would nest an interactive
 *  element inside the row button. */
function ScoreChip({ score }: { score: CampaignCalderynScore }) {
  const { label } = scorePillStyle(score);
  return (
    <span className="cd-score" style={BAND_CHIP[score.band]} title={label}>
      {score.value ?? "—"}
    </span>
  );
}

/** 75/50 band tones for score-dimension bars (matches the score-chip bands). */
function barTone(v: number): string {
  return v >= 75 ? "var(--green)" : v < 50 ? "var(--red)" : "var(--text-2)";
}

/** Label + value + tinted progress bar for one 0–100 score dimension. */
function ScoreDim({ label, value }: { label: string; value: number | null }) {
  const tone = value == null ? "var(--text-3)" : barTone(value);
  return (
    <div style={{ marginBottom: 11 }}>
      <div className="flex justify-between" style={{ fontSize: 13 }}>
        <span>{label}</span>
        <b className="tabular-nums" style={{ color: tone }}>{value ?? "—"}</b>
      </div>
      <div className="cd-trust-bar" style={{ marginTop: 5 }}>
        <i style={{ width: `${value ?? 0}%`, background: tone }} />
      </div>
    </div>
  );
}

/** Key/value line in the detail right rail. */
function MetricRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "7px 0", fontSize: 13 }}>
      <span className="cd-caption">{k}</span>
      <b className="tabular-nums" style={{ fontWeight: 600 }}>{v}</b>
    </div>
  );
}

/** Collapse breakpoint for the detail two-column grid. */
function useNarrowViewport(maxWidth = 1024): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [maxWidth]);
  return narrow;
}

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
  const paused = c.status === "paused";
  // Spend/day prefers the real daily budget; falls back to the 7-day average
  // when no budget is set. The caption says which one is shown.
  const hasBudget = c.daily_budget_cents > 0;
  const perDay = hasBudget
    ? c.daily_budget_cents
    : c.spend_7d > 0
      ? Math.round(c.spend_7d / 7)
      : null;
  return (
    <button
      className="cd-camp-row"
      onClick={onClick}
      data-dim={paused ? "1" : "0"}
      style={{ gridTemplateColumns: CAMP_GRID, padding: "14px 20px", opacity: paused ? 0.55 : undefined }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="cd-row-title truncate">{c.name}</span>
          {/* Plain title attrs, not <Tooltip>: its wrapper is focusable and
              this whole row is a button — no nested interactive elements. */}
          {staleSource && (
            <span title="This ad platform is disconnected — its data may be out of date.">
              <Pill tone="warn" icon="clock">Stale</Pill>
            </span>
          )}
          {scaleReason && (
            <span title={scaleReason}>
              <Pill icon="arrowUpRight">Scale</Pill>
            </span>
          )}
        </div>
        <div className="cd-caption">{c.platform}</div>
      </div>
      <div>
        <span className="cd-badge" style={paused ? BADGE_NEUTRAL : BADGE_ACTIVE}>
          {paused ? "Paused" : "Active"}
        </span>
      </div>
      <div className="tabular-nums">
        {perDay == null ? (
          "—"
        ) : (
          <>
            <div>{money(perDay)}</div>
            <div className="cd-caption">{hasBudget ? "budget" : "7d avg"}</div>
          </>
        )}
      </div>
      <div
        className="cd-row-num tabular-nums"
        style={{ color: losing ? "var(--red)" : "var(--green)" }}
      >
        {c.roas_7d.toFixed(1)}×
      </div>
      <div className="text-right">
        <ScoreChip score={c.calderynScore ?? PENDING_SCORE} />
      </div>
      <div className="flex" style={{ justifyContent: "flex-end", color: "var(--text-3)" }}>
        <CDIcon name="chevronRight" size={15} />
      </div>
    </button>
  );
}

/* ---------- Detail ---------- */
function CampaignDetail({
  app,
  c,
  grade,
  onBack,
  metaCanPushDrafts,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  /** Latest grade row for this campaign (attributed revenue); undefined until
   *  analytics loads or when the campaign has no grade yet. */
  grade?: CampaignGradeRow;
  onBack: () => void;
  metaCanPushDrafts: boolean;
}) {
  // The live status can drift from app.campaigns until the next refresh lands,
  // so hold the optimistic status locally and prefer it for rendering.
  const [status, setStatus] = useState(c.status);
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState<string | null>(null);
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
  const narrow = useNarrowViewport();

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

  const pushVariant = async (pushKey: string, v: Variant) => {
    setPushing(pushKey);
    try {
      const r = await pushCreativeDraft(c.id, v.input);
      app.toast(r.outcome === "succeeded" ? "Draft pushed to Meta (paused)" : "Push parked for retry");
    } catch {
      app.toast("Couldn't push the draft — check the action history");
    } finally {
      setPushing(null);
    }
  };

  // Header "Push to Meta" targets the strongest regenerated variant; disabled
  // (with an honest tooltip) until one exists — nothing is pushed blind.
  const bestVariant = variants.length > 0
    ? variants.reduce((a, b) => (b.composite > a.composite ? b : a))
    : null;

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

  const s = c.calderynScore ?? PENDING_SCORE;

  const directionCard = direction && (
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
  );

  const creativesCard = (
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
  );

  const regenerateCard = (
    <Card>
      <SectionTitle>Regenerate copy</SectionTitle>
      <p className="cd-body">Rewrites the campaign&apos;s weakest creative, re-scores each rewrite, and keeps only ones that beat it. Run it from the Regenerate button above.</p>
      {variants.length > 0 && (
        <div className="flex flex-col gap-2" style={{ marginTop: 12 }}>
          {variants.map((v, i) => {
            const pushKey = `${i}:${v.input.headline}`;
            return (
            <div key={pushKey} style={{ background: "var(--cd-surface-2, #f5f5f5)", borderRadius: 12, padding: "12px 14px" }}>
              <div className="flex items-center gap-2">
                <Pill tone="accent">{v.mode}</Pill>
                <span style={{ fontWeight: 600 }}>{v.composite}</span>
                <span className="cd-caption" style={{ color: "var(--cd-success, #1a7f37)" }}>+{v.delta}</span>
              </div>
              <p className="cd-body" style={{ marginTop: 6 }}>&ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}</p>
              <p className="cd-caption">{v.rationale}</p>
              <div style={{ marginTop: 8 }}>
                {metaCanPushDrafts ? (
                  <Btn
                    icon="arrowUpRight"
                    // Single-flight across ALL push buttons (incl. the header's
                    // best-variant push) — two concurrent pushes of the same
                    // creative would land duplicate paused drafts on Meta.
                    disabled={pushing !== null}
                    onClick={() => pushVariant(pushKey, v)}
                  >
                    Push to Meta as paused draft
                  </Btn>
                ) : (
                  <Tooltip content="Reconnect Meta with ad-management access to enable drafts">
                    <Btn icon="lock" disabled>
                      Reconnect Meta to enable drafts
                    </Btn>
                  </Tooltip>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </Card>
  );

  const screenCard = (
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
  );

  const scaleCard = !paused && scaleAlert && (
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
  );

  const openAlerts = app.alerts.filter((a) => a.campaign_id === c.id && a.status === "open");
  const alertsCard = openAlerts.length > 0 && (
    <Card pad={false}>
      <div className="cd-pad-x cd-pad-t">
        <SectionTitle>Open alerts on this campaign</SectionTitle>
      </div>
      <div className="cd-rows">
        {openAlerts.map((a) => (
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

  const scoreCard = (
    <Card>
      <div className="cd-caption" style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Calderyn score
      </div>
      <div className="flex items-baseline" style={{ gap: 7, marginTop: 2 }}>
        <span
          className="tabular-nums"
          style={{ fontSize: 34, fontWeight: 680, lineHeight: 1, color: BAND_CHIP[s.band].color }}
        >
          {s.value ?? "—"}
        </span>
        <span className="cd-caption">/ 100</span>
      </div>
      <div style={{ marginTop: 16 }}>
        <ScoreDim label="Performance" value={s.performance} />
        <ScoreDim label="Creative" value={s.creative} />
      </div>
      <div className="flex items-center flex-wrap gap-2" style={{ marginTop: 4 }}>
        <Pill>{`Confidence: ${s.confidence}`}</Pill>
        <span className="cd-caption">{`Ads scored ${s.adsCovered}/${s.adsTotal}`}</span>
      </div>
      {(s.performance == null || s.creative == null) && (
        <p className="cd-caption" style={{ marginTop: 8 }}>
          {s.performance == null ? "Performance pending — attribution." : ""}
          {" "}
          {s.creative == null ? "Connect your Meta integration to score this campaign's creatives." : ""}
        </p>
      )}
    </Card>
  );

  const improveCard = (s.weakDimensions.length > 0 || s.tips.length > 0) && (
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

  const metricsCard = (
    <Card>
      <div className="cd-anh" style={{ marginBottom: 10 }}>
        <CDIcon name="chart" size={15} />
        Metrics
      </div>
      <MetricRow
        k="Budget"
        v={c.daily_budget_cents > 0 ? `${money(c.daily_budget_cents)}/day` : "Not set"}
      />
      <MetricRow k="Spend (7d)" v={money(c.spend_7d)} />
      <MetricRow k="Break-even ROAS" v={`${c.breakeven_roas.toFixed(1)}×`} />
      <MetricRow k="Contribution margin" v={`${Math.round(c.contribution_margin * 100)}%`} />
      <MetricRow
        k="Profit ROAS (POAS)"
        v={
          c.roas_7d > 0 && c.contribution_margin > 0
            ? `${(c.roas_7d * c.contribution_margin).toFixed(1)}×`
            : "—"
        }
      />
      <div style={{ height: 0.5, background: "var(--hairline)", margin: "8px 0" }} />
      <div className="cd-caption" style={{ marginBottom: 6 }}>7-day trend</div>
      {c.trend && c.trend.length > 1 ? (
        <>
          <Sparkline
            data={c.trend}
            width={252}
            height={44}
            refLine={c.breakeven_roas}
            stroke={losing ? "var(--red)" : "var(--green)"}
          />
          <div className="cd-caption">dashed = break-even</div>
        </>
      ) : (
        <div className="cd-caption">No daily series yet.</div>
      )}
    </Card>
  );

  return (
    <div className="cd-screen" data-screen-label="Campaign detail">
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 10, minWidth: 0 }}>
          <Btn small icon="chevronLeft" onClick={onBack}>
            Back
          </Btn>
          <h1 className="cd-h1 truncate" style={{ fontSize: 24, minWidth: 0 }}>
            {c.name}
          </h1>
          <span className="cd-badge" style={BADGE_NEUTRAL}>{c.platform}</span>
          <span className="cd-badge" style={paused ? BADGE_NEUTRAL : BADGE_ACTIVE}>
            {paused ? "Paused" : "Active"}
            {!paused && direction ? ` · ${DIR_PILL[direction.direction].label}` : ""}
          </span>
        </div>
        <div className="flex items-center flex-wrap" style={{ gap: 8, flexShrink: 0 }}>
          {paused ? (
            <Btn
              small
              icon="play"
              disabled={busy}
              onClick={() => run("resume_campaign", "Campaign resumed.", "active")}
            >
              Resume
            </Btn>
          ) : (
            <Btn
              small
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
            small
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
          <Btn small icon="sparkle" disabled={regenBusy} onClick={runRegen}>
            {regenBusy ? "Generating…" : "Regenerate"}
          </Btn>
          {metaCanPushDrafts ? (
            bestVariant ? (
              <Btn
                small
                kind="primary"
                icon="arrowUpRight"
                disabled={pushing !== null}
                onClick={() => pushVariant(`best:${bestVariant.input.headline}`, bestVariant)}
              >
                Push to Meta
              </Btn>
            ) : (
              <Tooltip content="Run Regenerate first — the strongest variant pushes to Meta as a paused draft.">
                <Btn small kind="primary" icon="arrowUpRight" disabled>
                  Push to Meta
                </Btn>
              </Tooltip>
            )
          ) : (
            <Tooltip content="Reconnect Meta with ad-management access to enable drafts">
              <Btn small icon="lock" disabled>
                Push to Meta
              </Btn>
            </Tooltip>
          )}
        </div>
      </header>

      <div className="cd-stat-grid">
        <Card className="cd-stat">
          <span className="cd-stat-label">Spend (7d)</span>
          <span className="cd-stat-value">
            <CountMoney cents={c.spend_7d} />
          </span>
          <span className="cd-caption tabular-nums">
            {c.daily_budget_cents > 0 ? `${money(c.daily_budget_cents)}/day budget` : "No daily budget set"}
          </span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Revenue</span>
          {grade ? (
            <>
              <span className="cd-stat-value">
                <CountMoney cents={grade.revenue_cents} />
              </span>
              <span className="cd-caption">attributed · latest grading</span>
            </>
          ) : (
            <>
              <span className="cd-stat-value" style={{ color: "var(--text-3)" }}>—</span>
              <span className="cd-caption">No attributed revenue yet</span>
            </>
          )}
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">ROAS (7d)</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: losing ? "var(--red)" : "var(--green)" }}
          >
            {c.roas_7d.toFixed(1)}×
          </span>
          <span className="cd-caption tabular-nums">break-even {c.breakeven_roas.toFixed(1)}×</span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Conversions</span>
          <span className="cd-stat-value" style={{ color: "var(--text-3)" }}>—</span>
          <span className="cd-caption">Not tracked per campaign yet</span>
        </Card>
      </div>

      <div
        className="cd-grid-camp"
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "minmax(0,1fr)" : "minmax(0,1fr) 300px",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div className="flex flex-col" style={{ gap: 14, minWidth: 0 }}>
          {directionCard}
          {creativesCard}
          {regenerateCard}
          {screenCard}
          {scaleCard}
          {alertsCard}
        </div>
        <div className="flex flex-col" style={{ gap: 14, minWidth: 0 }}>
          {scoreCard}
          {improveCard}
          {metricsCard}
        </div>
      </div>

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

// The "New campaign" surface. Calderyn manages campaigns that live on the ad
// platforms — it doesn't create them from scratch — so this screen routes to
// the real starting points rather than staging a form that can't submit.
function CampaignNew({ app }: { app: DashboardCtx }) {
  const meta = app.integrations.find((i) => i.key === "meta_ads");
  const google = app.integrations.find((i) => i.key === "google_ads");
  const connected = app.integrations.filter((i) => i.status === "connected").length;
  return (
    <div className="cd-screen">
      <header className="cd-screen-head" data-screen-label="Create campaign">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Btn small icon="chevronLeft" onClick={() => app.navigate("campaigns")}>
            Back
          </Btn>
          <div>
            <h1 className="cd-h1" style={{ fontSize: 24 }}>
              Create campaign
            </h1>
          </div>
        </div>
      </header>
      <Card>
        <p className="cd-emptyhint" style={{ marginBottom: 14 }}>
          Campaigns are created in your ad platform (Meta, Google, TikTok) and sync into
          Calderyn automatically — usually within the hour. From there Calderyn grades them,
          screens new creative, and manages budgets inside your guardrails.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn
            kind="primary"
            small
            onClick={() => window.open("https://adsmanager.facebook.com/adsmanager/manage/campaigns", "_blank", "noopener")}
          >
            Open Meta Ads Manager
          </Btn>
          <Btn small onClick={() => window.open("https://ads.google.com/aw/campaigns", "_blank", "noopener")}>
            Open Google Ads
          </Btn>
          <Btn small onClick={() => app.navigate("settings", null, "connectors")}>
            {connected > 0 ? "Manage connections" : "Connect an ad account"}
          </Btn>
        </div>
        {(meta || google) && (
          <p className="cd-caption" style={{ marginTop: 12 }}>
            {[meta && `Meta: ${meta.status}`, google && `Google: ${google.status}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </Card>
      <Card>
        <SectionTitle>Screen new creative first</SectionTitle>
        <p className="cd-caption" style={{ margin: "8px 0 12px", maxWidth: "56ch" }}>
          Already have a campaign running? Open it and use Screen creative to generate and
          score variants before spending — winners can push to Meta as paused drafts.
        </p>
        <Btn small icon="sparkle" onClick={() => app.navigate("campaigns")}>
          Pick a campaign
        </Btn>
      </Card>
    </div>
  );
}

export default function Campaigns({ app }: { app: DashboardCtx }) {
  const [platform, setPlatform] = useState<PlatformFilter>("All");
  // Real grades + break-even come from fetchAnalytics(); join by campaign_id.
  // While this is in flight the campaigns render with whatever grade they carry.
  const [grades, setGrades] = useState<CampaignGradeRow[]>([]);
  const [metaCanPushDrafts, setMetaCanPushDrafts] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchAnalytics()
      .then((res) => {
        if (alive) {
          setGrades(res.grades);
          setMetaCanPushDrafts(res.metaCanPushDrafts);
        }
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

  // /dashboard/campaigns/new — campaigns are created on the ad platforms and
  // synced in; this surface says so honestly and routes to the real levers
  // (connectors, creative screening) instead of a fake create form.
  if (app.nav.param === "new") {
    return <CampaignNew app={app} />;
  }

  // Row-click / deep-link: nav.param carries the selected campaign id.
  const selected = app.nav.param ? joined.find((c) => c.id === app.nav.param) : null;
  if (selected) {
    return (
      <CampaignDetail
        app={app}
        c={selected}
        grade={gradeFor(selected.id)}
        onBack={() => app.navigate("campaigns")}
        metaCanPushDrafts={metaCanPushDrafts}
      />
    );
  }

  // Active campaigns sort to the top; within each status group, highest 7d
  // spend first. Paused rows still render (dimmed), just below the active ones.
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
        <Btn kind="primary" small icon="plus" onClick={() => app.navigate("campaigns", "new")}>
          New campaign
        </Btn>
      </ScreenHeader>
      <div className="cd-card" style={{ overflow: "hidden" }}>
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
          <>
            <div
              className="cd-tablehd"
              style={{ gridTemplateColumns: CAMP_GRID, gap: 12, padding: "13px 20px" }}
            >
              <span>Campaign</span>
              {/* No per-campaign autopilot flag exists in the data, so this
                  column shows the real status instead of an Auto/Manual state. */}
              <span>Status</span>
              <span>Spend/day</span>
              <span>ROAS</span>
              <span className="text-right">Score</span>
              <span />
            </div>
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
          </>
        )}
      </div>
      <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <CDIcon name="chart" size={13} /> True ROAS weights each campaign&apos;s return by spend and
        contribution margin — what&apos;s left after product costs.
      </p>
    </div>
  );
}
