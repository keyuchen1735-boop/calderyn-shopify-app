import { useEffect, useMemo, useState, type ReactNode } from "react";
import { gradeFromRow } from "~/lib/campaign-grade";
import {
  Card,
  Btn,
  Segmented,
  Placeholder,
  CountMoney,
  Tooltip,
  TableSkeleton,
  PlatformMark,
} from "../ui";
import { scorePillStyle } from "../score-pill";
import { creativeEmptyText } from "./campaign-creative-status";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import { money, timeAgo } from "../format";
import { CDIcon } from "../icons";
import {
  fetchAnalytics,
  executeCampaignAction,
  pushCreativeDraft,
  DashboardApiError,
  fetchCampaignCreatives,
  regenerateCampaign,
  screenCampaignCreative,
  type CampaignCreativesDTO,
  type RegenerateDTO,
} from "~/lib/dashboard/client";
import {
  fetchCampaignDrafts,
  createCampaignDraft,
  type CampaignDraftRow,
} from "~/lib/dashboard/campaign-drafts-client";
import {
  CAMPAIGN_DRAFT_PLATFORM_LABELS,
  type CampaignDraftPlatform,
} from "~/lib/ads/campaign-draft-types";
import type { Variant, CreativeScreenRun, CreativeInput } from "~/lib/screener/types";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import { sortActiveFirst } from "~/lib/campaign-sort";
import type { DashboardCtx } from "../context";
import type { CampaignVM } from "../view-models";
import type { CampaignGradeRow } from "~/lib/types";

const PENDING_SCORE: CampaignCalderynScore = {
  value: null, band: "nodata", performance: null, creative: null, confidence: "low",
  weakDimensions: [], tips: [], adsCovered: 0, adsTotal: 0,
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

/** 75/55 composite bands for scored creatives (matches the score-chip bands). */
function compositeChip(composite: number): { color: string; background: string } {
  return composite >= 75 ? BAND_CHIP.strong : composite >= 55 ? BAND_CHIP.fair : BAND_CHIP.weak;
}

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

/** "Peak & Pine" → "P&P"-style initials for the ad-preview avatar. */
function storeInitials(label: string): string {
  const words = label.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w));
  const initials = words.map((w) => w[0].toUpperCase()).slice(0, 3).join("");
  return initials || "—";
}

/** Uppercased hostname of the ad's destination for the link box; "—" when the
 *  creative has no parseable destination. */
function destinationDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toUpperCase();
  } catch {
    return "—";
  }
}

/** "SHOP_NOW" → "Shop now" — presentational casing of the ad's real CTA enum. */
function ctaLabel(cta: string): string {
  const words = cta.replace(/_/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "—";
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

/* ---------- List rows ---------- */
function CampaignRow({ c, onClick }: { c: CampaignVM; onClick: () => void }) {
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
      <div className="min-w-0 flex items-center" style={{ gap: 11 }}>
        <PlatformMark platform={c.platform} />
        <div className="min-w-0">
          <div className="cd-row-title truncate">{c.name}</div>
          <div className="cd-caption">{c.platform}</div>
        </div>
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

/** An owned campaign_draft row. Not clickable — a draft has no spend, ROAS, or
 *  score yet, so there is no detail to open; the caption says what it is. */
function DraftRow({ d }: { d: CampaignDraftRow }) {
  return (
    <div
      style={{
        display: "grid",
        alignItems: "center",
        gridTemplateColumns: CAMP_GRID,
        gap: 12,
        padding: "14px 20px",
        borderTop: "0.5px solid var(--hairline)",
        fontSize: 13.5,
      }}
    >
      <div className="min-w-0 flex items-center" style={{ gap: 11 }}>
        <PlatformMark platform={CAMPAIGN_DRAFT_PLATFORM_LABELS[d.platform]} />
        <div className="min-w-0">
          <div className="cd-row-title truncate">{d.name}</div>
          <div className="cd-caption">
            {CAMPAIGN_DRAFT_PLATFORM_LABELS[d.platform]} · Draft · created {timeAgo(d.createdAt)}
          </div>
        </div>
      </div>
      <div>
        <span className="cd-badge" style={BADGE_NEUTRAL}>Draft</span>
      </div>
      <div className="tabular-nums" style={{ color: "var(--text-3)" }}>—</div>
      <div className="cd-row-num tabular-nums" style={{ color: "var(--text-3)" }}>—</div>
      <div className="text-right">
        <span className="cd-score" style={BAND_CHIP.nodata}>—</span>
      </div>
      <div />
    </div>
  );
}

/* ---------- Screen-new-creative card (list) ---------- */
// The design's one-row card, made real against the existing screening flow
// (screenCampaignCreative → POST /screen). That flow requires the actual ad
// image (the server 422s without media), so the card carries an image-URL
// field alongside the hook input — a deliberate deviation that keeps the
// button honest instead of always-failing. Results render inline below.
function ScreenNewCreativeCard({
  app,
  campaigns,
}: {
  app: DashboardCtx;
  campaigns: CampaignVM[];
}) {
  const [campaignId, setCampaignId] = useState<string>(campaigns[0]?.id ?? "");
  const [brief, setBrief] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<CreativeScreenRun | null>(null);

  // Keep the selection valid if campaigns refresh underneath us.
  useEffect(() => {
    if (!campaigns.some((c) => c.id === campaignId)) {
      setCampaignId(campaigns[0]?.id ?? "");
    }
  }, [campaigns, campaignId]);

  if (campaigns.length === 0) return null;

  const submit = async () => {
    if (busy || !campaignId || !brief.trim() || !imageUrl.trim()) return;
    setBusy(true);
    try {
      setRun(
        await screenCampaignCreative(campaignId, {
          headline: brief.trim(),
          primaryText: "",
          cta: "SHOP_NOW",
          destinationUrl: "",
          audience: "",
          assumedSpendCents: DEFAULT_SPEND_CENTS,
          mediaKind: "image",
          imageUrl: imageUrl.trim(),
        }),
      );
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't screen that creative — check the image URL and try again.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  const sc = run?.scorecard ?? null;

  return (
    <Card>
      <div className="flex items-center" style={{ gap: 12, flexWrap: "wrap" }}>
        <h2 className="cd-h2" style={{ flex: "0 0 auto" }}>Screen new creative</h2>
        <select
          className="cd-input"
          aria-label="Campaign"
          value={campaignId}
          onChange={(e) => setCampaignId(e.target.value)}
          style={{ flex: "0 1 200px", minWidth: 140 }}
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input
          className="cd-input"
          type="text"
          placeholder="Summit Down · cold-weather hook"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <input
          className="cd-input"
          type="text"
          placeholder="Image URL (https)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <span
          title={
            !campaignId
              ? "Pick a campaign to score against"
              : !brief.trim()
                ? "Write the hook or headline to score"
                : !imageUrl.trim()
                  ? "Screening needs the creative image's URL"
                  : undefined
          }
        >
          <Btn
            kind="primary"
            small
            disabled={busy || !campaignId || !brief.trim() || !imageUrl.trim()}
            onClick={submit}
          >
            {/* "Score", not "Generate": this flow screens the supplied creative;
                generation lives behind Regenerate on the campaign detail. */}
            {busy ? "Scoring…" : "Score creative"}
          </Btn>
        </span>
      </div>
      {sc && (
        <div
          className="flex items-center"
          style={{ gap: 12, marginTop: 14, paddingTop: 14, borderTop: "0.5px solid var(--hairline)" }}
        >
          <span className="cd-score" style={compositeChip(sc.composite)}>{sc.composite}</span>
          <div className="min-w-0">
            <div className="cd-row-title truncate">{run?.creativeInput?.headline ?? brief}</div>
            <div className="cd-caption">{sc.summary}</div>
          </div>
        </div>
      )}
      {run && run.status === "error" && (
        <div className="cd-caption" style={{ marginTop: 10 }}>
          Couldn&apos;t score: {run.error}
        </div>
      )}
    </Card>
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
  const [pushing, setPushing] = useState(false);
  useEffect(() => {
    setStatus(c.status);
  }, [c.status]);

  const [creativeData, setCreativeData] = useState<CampaignCreativesDTO | null>(null);
  // Distinct from `creativeData == null` (still loading): a fetch failure must
  // not masquerade as "not connected" — that would show misleading Meta-connect
  // guidance on a transient network/5xx error (rule 12, fail visibly).
  const [creativesLoadError, setCreativesLoadError] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [regenBusy, setRegenBusy] = useState(false);
  const narrow = useNarrowViewport();

  useEffect(() => {
    let live = true;
    setCreativesLoadError(false);
    fetchCampaignCreatives(c.id)
      .then((d) => { if (live) setCreativeData(d); })
      .catch(() => { if (live) setCreativesLoadError(true); });
    return () => { live = false; };
  }, [c.id]);

  const runRegen = async () => {
    const adIds = (creativeData?.creatives ?? []).map((x) => x.adId).filter(Boolean);
    if (adIds.length === 0) { app.toast("No creatives to regenerate yet.", "x", "critical"); return; }
    setRegenBusy(true);
    try {
      const res: RegenerateDTO = await regenerateCampaign(c.id, adIds, creativeData?.assumedSpendCents ?? DEFAULT_SPEND_CENTS);
      if (res.ok) {
        setVariants(res.variants);
        app.toast(res.variants.length > 0 ? `Generated ${res.variants.length} stronger variant(s).` : "No variant beat the original.", "sparkle", "success");
      } else {
        // Say which precondition failed — the old blanket "score first" pointed
        // at a per-ad scoring control this surface no longer renders.
        const msg =
          res.reason === "no_scored_ads"
            ? "This campaign's ads haven't been scored yet, so there's nothing to improve from."
            : res.reason === "no_seed_run"
              ? "No screening run yet — score a creative from the Campaigns screen first."
              : res.reason === "generator_unavailable"
                ? "The creative generator is unavailable right now — try again shortly."
                : "Regenerate is unavailable for this campaign right now.";
        app.toast(msg, "x", "critical");
      }
    } catch {
      app.toast("Regenerate failed — try again.", "x", "critical");
    } finally {
      setRegenBusy(false);
    }
  };

  const pushVariant = async (v: Variant) => {
    setPushing(true);
    try {
      const r = await pushCreativeDraft(c.id, v.input);
      app.toast(r.outcome === "succeeded" ? "Draft pushed to Meta (paused)" : "Push parked for retry");
    } catch {
      app.toast("Couldn't push the draft — check the action history");
    } finally {
      setPushing(false);
    }
  };

  // Header "Push to Meta" targets the strongest regenerated variant; disabled
  // (with an honest tooltip) until one exists — nothing is pushed blind.
  const bestVariant = variants.length > 0
    ? variants.reduce((a, b) => (b.composite > a.composite ? b : a))
    : null;

  const losing = c.roas_7d < c.breakeven_roas;
  const paused = status === "paused";

  const run = async (
    type: "pause_campaign" | "resume_campaign" | "reduce_campaign_budget",
    successText: string,
    nextStatus: string,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, {
        type,
        ...(type === "reduce_campaign_budget"
          ? { dailyBudgetCents: Math.round(c.daily_budget_cents * 0.7) }
          : {}),
      });
      setStatus(nextStatus);
      app.refresh();
      app.toast(
        successText,
        type === "pause_campaign" ? "pause" : type === "resume_campaign" ? "play" : "reduce",
      );
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Action failed — please try again.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  const s = c.calderynScore ?? PENDING_SCORE;

  // The REAL first creative on this campaign (null while loading, on error,
  // when Meta isn't connected, or when the campaign has no ads yet).
  const firstAd = creativeData?.creatives[0] ?? null;
  const cre: CreativeInput | null = firstAd?.creative ?? null;
  const creFormat =
    cre?.mediaKind === "video" ? "Video" : cre?.mediaKind === "image" || cre?.imageUrl ? "Image" : "—";
  // Live creative preview + regeneration are Meta-only (the only platform with a
  // creative fetcher), so a TikTok/Google campaign never shows Meta-connect
  // guidance or the Meta-only creative tools.
  const isMeta = c.platform === "Meta";
  // Honest message for the empty creative slot, by cause.
  const creEmptyText = creativeEmptyText(c.platform, {
    loadError: creativesLoadError,
    data: creativeData,
  });

  const creativeCard = (
    <Card pad={false}>
      <div
        className="flex items-center justify-between"
        style={{ padding: "14px 16px", borderBottom: "0.5px solid var(--hairline-strong)" }}
      >
        <div className="cd-anh" style={{ margin: 0 }}>
          <CDIcon name="image" size={15} />
          Creative
        </div>
        <span className="cd-caption">{creFormat}</span>
      </div>
      <div style={{ padding: 16 }}>
        <div className="flex items-center" style={{ gap: 9, marginBottom: 12 }}>
          <span className="cd-acct-av">{storeInitials(app.storeLabel)}</span>
          <div className="min-w-0">
            <div style={{ fontSize: 13, fontWeight: 640 }}>{app.storeLabel}</div>
            <div className="cd-caption">Sponsored · {c.platform}</div>
          </div>
        </div>
        <p style={{ fontSize: 13.5, lineHeight: 1.5, color: cre?.primaryText ? "var(--text-1)" : "var(--text-3)", marginBottom: 12 }}>
          {cre?.primaryText || creEmptyText}
        </p>
        {cre?.imageUrl ? (
          <img
            src={cre.imageUrl}
            alt={cre.headline || "Ad creative"}
            style={{ display: "block", width: "100%", height: 300, objectFit: "cover", borderRadius: 12 }}
          />
        ) : (
          <div
            className="cd-nc-empty"
            style={{ height: 300, background: "var(--gray-bg)", borderRadius: 12 }}
          >
            {creEmptyText}
          </div>
        )}
        <div
          className="flex items-center justify-between"
          style={{ gap: 12, marginTop: 12, padding: "11px 14px", background: "var(--gray-bg)", borderRadius: 12 }}
        >
          <div className="min-w-0">
            <div className="cd-caption" style={{ letterSpacing: "0.04em" }}>
              {cre?.destinationUrl ? destinationDomain(cre.destinationUrl) : "—"}
            </div>
            <div className="truncate" style={{ fontSize: 14, fontWeight: 640, letterSpacing: "-0.01em" }}>
              {cre?.headline || "—"}
            </div>
          </div>
          {/* Static preview of the ad's own CTA — part of the creative, not an app control. */}
          <span className="cd-btn cd-btn-secondary cd-btn-sm" style={{ flexShrink: 0, pointerEvents: "none" }}>
            {cre?.cta ? ctaLabel(cre.cta) : "—"}
          </span>
        </div>
      </div>
    </Card>
  );

  // Regenerated variants (design-language rows under the creative card). The
  // regenerate flow returns scored Variant[]s, not score-card dims, so they
  // surface here; the header Push to Meta targets the strongest one.
  const variantsCard = variants.length > 0 && (
    <Card pad={false}>
      <div
        className="flex items-center justify-between"
        style={{ padding: "14px 16px", borderBottom: "0.5px solid var(--hairline-strong)" }}
      >
        <div className="cd-anh" style={{ margin: 0 }}>
          <CDIcon name="sparkle" size={15} />
          Regenerated variants
        </div>
        <span className="cd-caption">scored vs current creative</span>
      </div>
      {variants.map((v, i) => (
        <div
          key={`${i}:${v.input.headline}`}
          className="flex items-center"
          style={{ gap: 12, padding: "13px 16px", borderTop: i > 0 ? "0.5px solid var(--hairline)" : undefined }}
        >
          <span className="cd-score" style={compositeChip(v.composite)}>{v.composite}</span>
          <div className="min-w-0" style={{ flex: 1 }}>
            <div className="cd-row-title truncate">{v.input.headline}</div>
            <div className="cd-caption truncate">{v.rationale}</div>
          </div>
          <b className="tabular-nums" style={{ color: "var(--green)", fontSize: 13, flexShrink: 0 }}>
            +{v.delta}
          </b>
        </div>
      ))}
    </Card>
  );

  // No per-campaign daily spend/revenue series exists yet, so the chart card
  // ships the design's honest no-data state rather than a fabricated series.
  const chartCard = (
    <Card>
      <div className="cd-anh-wrap">
        <div className="cd-anh">
          <CDIcon name="arrowUpRight" size={15} />
          Spend vs revenue · 12 days
        </div>
      </div>
      <div className="cd-nc-empty" style={{ minHeight: 120 }}>
        No data yet · launch to start collecting
      </div>
    </Card>
  );

  const scoreCard = (
    <Card>
      <div className="cd-caption" style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Score
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
      <div className="cd-caption" style={{ marginTop: 4 }}>
        Confidence: {s.confidence} · Ads scored {s.adsCovered}/{s.adsTotal}
      </div>
    </Card>
  );

  // Delivery: rows render from REAL fields only — the daily budget is the one
  // per-campaign delivery number the sync carries today; every metric with no
  // source renders the design's "—" (never a fabricated number). Objective /
  // Audience have no real fields, so those rows are omitted.
  const deliveryCard = (
    <Card>
      <div className="cd-anh" style={{ marginBottom: 10 }}>
        <CDIcon name="scan" size={15} />
        Delivery
      </div>
      <MetricRow k="Impressions" v="—" />
      <MetricRow k="Clicks" v="—" />
      <MetricRow k="CTR" v="—" />
      <MetricRow k="CPA" v="—" />
      <MetricRow k="CPM" v="—" />
      <MetricRow k="Frequency" v="—" />
      <MetricRow k="Reach" v="—" />
      <MetricRow
        k="Budget"
        v={c.daily_budget_cents > 0 ? `${money(c.daily_budget_cents)}/day` : "—"}
      />
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
          </span>
        </div>
        <div className="flex items-center flex-wrap" style={{ gap: 8, flexShrink: 0 }}>
          {/* Pause/resume + cut-budget are real operator actions with no other
              home — kept beyond the design's two header buttons (deliberate). */}
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
          {/* 0.7 × nothing is nothing: the action route rejects a zero budget,
              so never offer a cut that cannot succeed. */}
          <span title={c.daily_budget_cents <= 0 ? "No daily budget set on this campaign" : undefined}>
            <Btn
              small
              icon="reduce"
              disabled={busy || c.daily_budget_cents <= 0}
              onClick={() =>
                run("reduce_campaign_budget", "Budget reduced 30% — logged to action history.", status)
              }
            >
              Cut budget 30%
            </Btn>
          </span>
          {/* Regenerate + Push to Meta are Meta-only creative tools — hidden on
              Google/TikTok campaigns, which have no creative fetcher to draft from. */}
          {isMeta && (
            <>
              <Btn small icon="sparkle" disabled={regenBusy} onClick={runRegen}>
                {regenBusy ? "Generating…" : "Regenerate"}
              </Btn>
              {metaCanPushDrafts ? (
                bestVariant ? (
                  <Btn
                    small
                    kind="primary"
                    icon="arrowUpRight"
                    disabled={pushing}
                    onClick={() => pushVariant(bestVariant)}
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
            </>
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
          marginTop: 14,
        }}
      >
        <div className="flex flex-col" style={{ gap: 14, minWidth: 0 }}>
          {creativeCard}
          {variantsCard}
          {chartCard}
        </div>
        <div className="flex flex-col" style={{ gap: 14, minWidth: 0 }}>
          {scoreCard}
          {deliveryCard}
        </div>
      </div>
    </div>
  );
}

/* ---------- New campaign (create draft) ---------- */
const PLATFORM_OPTIONS: Array<{ value: CampaignDraftPlatform; label: string }> = [
  { value: "meta", label: "Meta" },
  { value: "google", label: "Google" },
  { value: "tiktok", label: "TikTok" },
];

// The design's Create-campaign screen: name + platform on the right, the honest
// empty stat grid on the left (a draft has no data yet), Create draft in the
// header. Shareable-links / auto-match / activities cards are omitted — no
// backend exists for them, and a dead "+" button would be dishonest.
function CampaignNew({ app }: { app: DashboardCtx }) {
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<CampaignDraftPlatform>("meta");
  const [saving, setSaving] = useState(false);
  const narrow = useNarrowViewport();

  const create = async () => {
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await createCampaignDraft({ name: name.trim(), platform });
      app.toast("Draft created.", "check", "success");
      app.navigate("campaigns");
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't create the draft — try again.";
      app.toast(message, "x", "critical");
      setSaving(false);
    }
  };

  const emptyStat = (label: string) => (
    <Card className="cd-stat">
      <span className="cd-stat-label">{label}</span>
      <span className="cd-nc-empty">No data</span>
    </Card>
  );
  const emptyChart = (label: string) => (
    <div className="cd-card cd-pad" style={{ minHeight: 180, display: "flex", flexDirection: "column" }}>
      <span className="cd-stat-label">{label}</span>
      <span className="cd-nc-empty" style={{ flex: 1 }}>No data</span>
    </div>
  );

  return (
    <div className="cd-screen" data-screen-label="Create campaign">
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 10 }}>
          <Btn small icon="chevronLeft" onClick={() => app.navigate("campaigns")}>
            Back
          </Btn>
          <h1 className="cd-h1" style={{ fontSize: 24 }}>Create campaign</h1>
          <span className="cd-badge" style={BADGE_NEUTRAL}>Draft</span>
        </div>
        <Btn kind="primary" small disabled={saving || !name.trim()} onClick={create}>
          {saving ? "Creating…" : "Create draft"}
        </Btn>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "minmax(0,1fr)" : "minmax(0,1fr) 280px",
          gap: 18,
          alignItems: "start",
        }}
      >
        <div className="flex flex-col" style={{ gap: 14 }}>
          <div className="cd-stat-grid">
            {emptyStat("Sessions")}
            {emptyStat("Total sales")}
            {emptyStat("Orders")}
            {emptyStat("Avg order value")}
          </div>
          <div className="cd-grid-duo">
            {emptyChart("Sessions by channel")}
            {emptyChart("Sales by channel")}
          </div>
          <div className="cd-grid-duo">
            {emptyChart("New vs returning")}
            {emptyChart("Sessions by device")}
          </div>
        </div>

        <Card>
          <input
            className="cd-input"
            type="text"
            placeholder="Campaign name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: "100%" }}
          />
          <div style={{ marginTop: 12 }}>
            <Segmented
              small
              value={platform}
              onChange={(v) => setPlatform(v as CampaignDraftPlatform)}
              options={PLATFORM_OPTIONS}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------- List ---------- */
function CampaignList({
  app,
  joined,
}: {
  app: DashboardCtx;
  joined: CampaignVM[];
}) {
  // Owned campaign drafts render alongside synced campaigns. Fetched on mount —
  // this component remounts on return from the create screen, so a fresh draft
  // shows up immediately.
  const [drafts, setDrafts] = useState<CampaignDraftRow[]>([]);
  useEffect(() => {
    let live = true;
    fetchCampaignDrafts()
      .then((rows) => { if (live) setDrafts(rows); })
      .catch(() => {
        // Non-fatal: the list still renders the synced campaigns.
      });
    return () => { live = false; };
  }, []);

  // Active campaigns sort to the top; within each status group, highest 7d
  // spend first. Paused rows still render (dimmed), just below the active ones.
  const shown = sortActiveFirst(joined, (a, b) => b.spend_7d - a.spend_7d);

  const loading = app.loading && joined.length === 0;

  // Restrained, plain-language readout of the whole account: which platforms are
  // connected, how many campaigns are live, the combined daily spend, and how
  // many are spending without earning their keep. Derived from real fields only.
  const active = shown.filter((c) => c.status !== "paused");
  // Only live campaigns spend, so paused budgets stay out of the $/day figure.
  const perDayCents = active.reduce(
    (sum, c) =>
      sum +
      (c.daily_budget_cents > 0
        ? c.daily_budget_cents
        : c.spend_7d > 0
          ? Math.round(c.spend_7d / 7)
          : 0),
    0,
  );
  // A campaign with no spend yet (just launched, ad in review) isn't "losing
  // money" — require real spend before judging, matching trueRoas().
  const losers = active.filter((c) => c.spend_7d > 0 && c.roas_7d < c.breakeven_roas);
  const platforms = Array.from(new Set(shown.map((c) => c.platform)));

  return (
    <div className="cd-screen">
      <ScreenHeader title="Campaigns" sub="Every ad platform, in one place.">
        <Btn kind="primary" small onClick={() => app.navigate("campaigns", "new")}>
          New campaign
        </Btn>
      </ScreenHeader>
      {shown.length > 0 && (
        <div
          className="flex items-center"
          style={{ gap: 14, flexWrap: "wrap", fontSize: 13, color: "var(--text-2)", margin: "-8px 2px 0" }}
        >
          <div className="flex items-center" style={{ gap: 5 }}>
            {platforms.map((p) => (
              <PlatformMark key={p} platform={p} />
            ))}
          </div>
          <span>
            <b style={{ color: "var(--text-1)", fontWeight: 600 }}>{active.length}</b> live{" "}
            {active.length === 1 ? "campaign" : "campaigns"}
          </span>
          <span className="tabular-nums">
            <b style={{ color: "var(--text-1)", fontWeight: 600 }}>{money(perDayCents)}</b>/day
          </span>
          {losers.length > 0 && (
            <span className="cd-badge" style={{ color: "var(--red)", background: "var(--red-bg)" }}>
              {losers.length} losing money
            </span>
          )}
        </div>
      )}
      <div className="cd-card" style={{ overflow: "hidden" }}>
        {loading ? (
          <TableSkeleton />
        ) : shown.length === 0 && drafts.length === 0 ? (
          <Placeholder
            icon="megaphone"
            title="No campaigns yet"
            sub="Connect an ad account and your campaigns will appear here."
            actionLabel="Connect ad account"
            onAction={() => app.navigate("settings", null, "connectors")}
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
            {shown.map((c) => (
              <CampaignRow key={c.id} c={c} onClick={() => app.navigate("campaigns", c.id)} />
            ))}
            {drafts.map((d) => (
              <DraftRow key={d.id} d={d} />
            ))}
          </>
        )}
      </div>
      <ScreenNewCreativeCard app={app} campaigns={shown} />
    </div>
  );
}

/* ---------- Screen ---------- */
export default function Campaigns({ app }: { app: DashboardCtx }) {
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

  // Join the live grades onto each campaign (grade + break-even).
  const gradeFor = (id: string) => grades.find((g) => g.campaign_id === id);
  const joined: CampaignVM[] = useMemo(
    () =>
      app.campaigns.map((c) => {
        const g = grades.find((row) => row.campaign_id === c.id);
        if (!g) return c;
        // Resolve via the shared grader so a no-revenue grade row shows "no data"
        // not "poor" (P1-6) — same logic adaptCampaign uses for the initial load.
        return { ...c, grade: gradeFromRow(g, c.roas_7d), breakeven_roas: g.break_even_roas };
      }),
    [app.campaigns, grades],
  );

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

  return <CampaignList app={app} joined={joined} />;
}
