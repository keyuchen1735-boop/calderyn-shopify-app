import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { gradeFromRow } from "~/lib/campaign-grade";
import {
  Card,
  Btn,
  Pan,
  Placeholder,
  CountMoney,
  Tooltip,
  TableSkeleton,
  PlatformMark,
  Sparkline,
} from "../ui";
import { scorePillStyle } from "../score-pill";
import { creativeEmptyText } from "./campaign-creative-status";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";
import { money, timeAgo } from "../format";
import { CDIcon } from "../icons";
import { EditBudgetModal } from "./EditBudgetModal";
import {
  fetchAnalytics,
  executeCampaignAction,
  pushCreativeDraft,
  DashboardApiError,
  fetchCampaignCreatives,
  fetchCampaignSeries,
  regenerateCampaign,
  type CampaignCreativesDTO,
  type RegenerateDTO,
} from "~/lib/dashboard/client";
import {
  fetchCampaignDrafts,
  deleteCampaignDraft,
  type CampaignDraftRow,
} from "~/lib/dashboard/campaign-drafts-client";
import { CampaignWizard } from "./CampaignWizard";
import { CAMPAIGN_DRAFT_PLATFORM_LABELS } from "~/lib/ads/campaign-draft-types";
import type { Variant, CreativeInput } from "~/lib/screener/types";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import { sortActiveFirst } from "~/lib/campaign-sort";
import type { DashboardCtx } from "../context";
import type { CampaignVM } from "../view-models";
import type { CampaignGradeRow, DailyRoasRow } from "~/lib/types";

gsap.registerPlugin(useGSAP, Flip);

const PENDING_SCORE: CampaignCalderynScore = {
  value: null,
  band: "nodata",
  performance: null,
  creative: null,
  confidence: "low",
  weakDimensions: [],
  tips: [],
  adsCovered: 0,
  adsTotal: 0,
};

/** Shared column template for the campaigns table (header + rows). */
const CAMP_GRID = "minmax(0,1fr) 72px 96px 68px 54px 104px 22px";

const BADGE_ACTIVE = {
  color: "var(--live)",
  background: "color-mix(in oklch, var(--live) 13%, transparent)",
} as const;
const BADGE_NEUTRAL = {
  color: "var(--text-2)",
  background: "var(--gray-bg)",
} as const;

function campaignPerDay(c: CampaignVM): {
  cents: number | null;
  label: "budget" | "7d avg";
} {
  if (c.daily_budget_cents > 0)
    return { cents: c.daily_budget_cents, label: "budget" };
  return {
    cents: c.spend_7d > 0 ? Math.round(c.spend_7d / 7) : null,
    label: "7d avg",
  };
}

/** Band-tinted styles for the numeric score chip (mirrors ScorePill tones). */
const BAND_CHIP: Record<
  CampaignCalderynScore["band"],
  { color: string; background: string }
> = {
  strong: { color: "var(--live)", background: "color-mix(in oklch, var(--live) 13%, transparent)" },
  fair: { color: "var(--text-1)", background: "var(--gray-bg)" },
  weak: { color: "var(--text-2)", background: "var(--gray-bg)" },
  nodata: { color: "var(--text-2)", background: "var(--gray-bg)" },
};

/** 75/55 composite bands for scored creatives (matches the score-chip bands). */
function compositeChip(composite: number): {
  color: string;
  background: string;
} {
  return composite >= 75
    ? BAND_CHIP.strong
    : composite >= 55
      ? BAND_CHIP.fair
      : BAND_CHIP.weak;
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
  return v >= 75 ? "var(--live)" : v < 50 ? "var(--text-3)" : "var(--text-2)";
}

/** Label + value + tinted progress bar for one 0–100 score dimension. */
function ScoreDim({ label, value }: { label: string; value: number | null }) {
  const tone = value == null ? "var(--text-3)" : barTone(value);
  return (
    <div style={{ marginBottom: 11 }}>
      <div className="flex justify-between" style={{ fontSize: 13 }}>
        <span>{label}</span>
        <b className="tabular-nums" style={{ color: tone }}>
          {value ?? "—"}
        </b>
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
    <div
      className="flex items-center justify-between"
      style={{ padding: "7px 0", fontSize: 13 }}
    >
      <span className="cd-caption">{k}</span>
      <b className="tabular-nums" style={{ fontWeight: 600 }}>
        {v}
      </b>
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
  const initials = words
    .map((w) => w[0].toUpperCase())
    .slice(0, 3)
    .join("");
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
/** Per-row quick actions: pause/resume (all platforms), edit budget + duplicate
 *  (Meta only — the only platform with those write paths today). Rendered as
 *  real <button>s, so the row itself can not be a <button> (invalid nesting);
 *  see CampaignRow below. */
function RowQuickActions({
  app,
  c,
  onEditBudget,
  onChanged,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  onEditBudget: () => void;
  onChanged: (patch: Partial<CampaignVM>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const paused = c.status === "paused";
  const isMeta = c.platform === "Meta";

  const run = async (
    type: "pause_campaign" | "resume_campaign" | "duplicate_campaign",
    done: string,
    patch: Partial<CampaignVM>,
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await executeCampaignAction(c.id, { type });
      app.toast(done, "check", "success");
      onChanged(patch);
      // Local patch is instant; also kick a background refresh so the next
      // full sync (e.g. duplicate's new row) reconciles for real.
      app.refresh();
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Action failed — try again.";
      app.toast(message, "x", "critical");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex items-center"
      style={{ gap: 6, justifyContent: "flex-end" }}
      onClick={(e) => e.stopPropagation()}
    >
      <Tooltip content={paused ? "Resume" : "Pause"}>
        <Btn
          small
          icon={paused ? "play" : "pause"}
          className="cd-btn-icon"
          ariaLabel={paused ? "Resume campaign" : "Pause campaign"}
          disabled={busy}
          onClick={() =>
            paused
              ? run("resume_campaign", "Campaign resumed.", {
                  status: "active",
                })
              : run("pause_campaign", "Campaign paused.", { status: "paused" })
          }
        >
          {""}
        </Btn>
      </Tooltip>
      {isMeta && (
        <>
          <Tooltip content="Edit daily budget">
            <Btn
              small
              icon="pencil"
              className="cd-btn-icon"
              ariaLabel="Edit daily budget"
              disabled={busy}
              onClick={onEditBudget}
            >
              {""}
            </Btn>
          </Tooltip>
          <Tooltip content="Duplicate (created paused)">
            <Btn
              small
              icon="copy"
              className="cd-btn-icon"
              ariaLabel="Duplicate campaign"
              disabled={busy}
              onClick={() =>
                run("duplicate_campaign", "Copy created on Meta (paused).", {})
              }
            >
              {""}
            </Btn>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function CampaignRow({
  app,
  c,
  onClick,
  onEditBudget,
  onChanged,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  onClick: () => void;
  onEditBudget: () => void;
  onChanged: (patch: Partial<CampaignVM>) => void;
}) {
  const hasPerformanceData = c.spend_7d > 0;
  const losing = hasPerformanceData && c.roas_7d < c.breakeven_roas;
  const paused = c.status === "paused";
  const perDay = campaignPerDay(c);
  return (
    // A div with button semantics rather than a real <button>: the row nests
    // the per-row action buttons (pause/resume, edit budget, duplicate),
    // which are invalid inside <button>.
    <div
      role="button"
      tabIndex={0}
      className="cd-camp-row cd-campaign-item"
      onClick={onClick}
      onKeyDown={(e) => {
        // Only when the row itself is focused — Enter/Space on a nested
        // action button must trigger that button, not open the detail.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      data-dim={paused ? "1" : "0"}
      data-attention={losing ? "1" : "0"}
      style={{ gridTemplateColumns: CAMP_GRID, padding: "10px 16px" }}
    >
      <div className="min-w-0 flex items-center" style={{ gap: 11 }}>
        <PlatformMark platform={c.platform} size={22} />
        <div className="min-w-0">
          <div className="cd-row-title truncate">{c.name}</div>
          <div className="cd-caption">{c.platform}</div>
        </div>
      </div>
      <div>
        <span
          className="cd-badge"
          style={paused ? BADGE_NEUTRAL : BADGE_ACTIVE}
        >
          {paused ? "Paused" : "Active"}
        </span>
      </div>
      <div className="tabular-nums">
        {perDay.cents == null ? (
          "—"
        ) : (
          <>
            <div>{money(perDay.cents)}</div>
            <div className="cd-caption">{perDay.label}</div>
          </>
        )}
      </div>
      <div
        className="cd-row-num tabular-nums"
        style={{
          color: !hasPerformanceData
            ? "var(--text-3)"
            : losing
              ? "var(--text-2)"
              : "var(--live)",
        }}
      >
        {c.roas_7d.toFixed(1)}×
      </div>
      <div className="text-right">
        <ScoreChip score={c.calderynScore ?? PENDING_SCORE} />
      </div>
      <RowQuickActions
        app={app}
        c={c}
        onEditBudget={onEditBudget}
        onChanged={onChanged}
      />
      <div
        className="flex"
        style={{ justifyContent: "flex-end", color: "var(--text-3)" }}
      >
        <CDIcon name="chevronRight" size={15} />
      </div>
    </div>
  );
}

/** An owned campaign_draft row. The row itself is not clickable — a draft has
 *  no spend, ROAS, or score yet, so there is nothing to open; instead it gets
 *  two actions: resume the wizard where it left off, or remove it. */
function DraftRow({
  d,
  onContinue,
  onDelete,
}: {
  d: CampaignDraftRow;
  onContinue: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="cd-draft-row cd-campaign-item"
      style={{
        display: "grid",
        alignItems: "center",
        gridTemplateColumns: CAMP_GRID,
        gap: 10,
        padding: "10px 16px",
        borderTop: "0.5px solid var(--hairline)",
        fontSize: 13.5,
      }}
    >
      <div className="min-w-0 flex items-center" style={{ gap: 11 }}>
        <PlatformMark platform={CAMPAIGN_DRAFT_PLATFORM_LABELS[d.platform]} size={22} />
        <div className="min-w-0">
          <div className="cd-row-title truncate">{d.name}</div>
          <div className="cd-caption">
            {CAMPAIGN_DRAFT_PLATFORM_LABELS[d.platform]} · Draft · updated{" "}
            {timeAgo(d.updatedAt)}
          </div>
        </div>
      </div>
      <div>
        <span className="cd-badge" style={BADGE_NEUTRAL}>
          Draft
        </span>
      </div>
      <div className="tabular-nums" style={{ color: "var(--text-3)" }}>
        —
      </div>
      <div
        className="cd-row-num tabular-nums"
        style={{ color: "var(--text-3)" }}
      >
        —
      </div>
      <div className="text-right">
        <span className="cd-score" style={BAND_CHIP.nodata}>
          —
        </span>
      </div>
      <div className="flex items-center justify-end" style={{ gap: 4 }}>
        <Btn small icon="arrowRight" onClick={onContinue}>
          Continue setup
        </Btn>
      </div>
      <div className="flex items-center justify-end">
        <Tooltip content="Delete draft">
          <Btn
            small
            icon="trash"
            className="cd-btn-icon"
            ariaLabel="Delete draft"
            onClick={onDelete}
          >
            {""}
          </Btn>
        </Tooltip>
      </div>
    </div>
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
  const detailRootRef = useRef<HTMLDivElement>(null);
  // The live status can drift from app.campaigns until the next refresh lands,
  // so hold the optimistic status locally and prefer it for rendering.
  const [status, setStatus] = useState(c.status);
  const [busy, setBusy] = useState(false);
  const [pushing, setPushing] = useState(false);
  useEffect(() => {
    setStatus(c.status);
  }, [c.status]);

  const [creativeData, setCreativeData] = useState<CampaignCreativesDTO | null>(
    null,
  );
  // Distinct from `creativeData == null` (still loading): a fetch failure must
  // not masquerade as "not connected" — that would show misleading Meta-connect
  // guidance on a transient network/5xx error (rule 12, fail visibly).
  const [creativesLoadError, setCreativesLoadError] = useState(false);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [regenBusy, setRegenBusy] = useState(false);
  const narrow = useNarrowViewport();

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const sections = detailRootRef.current?.querySelectorAll(
        ".cd-screen-head, .cd-stat-grid > .cd-card, .cd-grid-camp > div > .cd-card",
      );
      if (!sections?.length) return;
      gsap.fromTo(
        sections,
        { autoAlpha: 0, y: 8, scale: 0.992, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.3,
          stagger: 0.035,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform,willChange",
        },
      );
    },
    { scope: detailRootRef, dependencies: [c.id], revertOnUpdate: true },
  );

  useEffect(() => {
    let live = true;
    setCreativesLoadError(false);
    fetchCampaignCreatives(c.id)
      .then((d) => {
        if (live) setCreativeData(d);
      })
      .catch(() => {
        if (live) setCreativesLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [c.id]);

  // Spend + ROAS history for the chart card, below. Null while loading (the
  // card falls back to the existing empty state until it resolves). As with
  // creativesLoadError above, a fetch failure must not masquerade as "no
  // history yet" — that copy tells the merchant to wait for data that may
  // already exist (rule 12, fail visibly).
  const [series, setSeries] = useState<DailyRoasRow[] | null>(null);
  const [seriesLoadError, setSeriesLoadError] = useState(false);
  useEffect(() => {
    let live = true;
    setSeries(null);
    setSeriesLoadError(false);
    fetchCampaignSeries(c.id)
      .then((s) => {
        if (live) setSeries(s);
      })
      .catch(() => {
        if (live) setSeriesLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [c.id]);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const changed = [
        detailRootRef.current?.querySelector(
          ".cd-campaign-creative-card > div:last-child",
        ),
        detailRootRef.current?.querySelector(
          ".cd-campaign-chart-card > div:last-child",
        ),
        detailRootRef.current?.querySelector(".cd-campaign-variants-card"),
      ].filter((node): node is Element => Boolean(node));
      if (changed.length === 0) return;
      gsap.fromTo(
        changed,
        { autoAlpha: 0.55, y: 4 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.24,
          stagger: 0.035,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        },
      );
    },
    {
      scope: detailRootRef,
      dependencies: [
        Boolean(creativeData),
        creativesLoadError,
        Boolean(series),
        seriesLoadError,
        variants.length,
      ],
      revertOnUpdate: true,
    },
  );

  const runRegen = async () => {
    const adIds = (creativeData?.creatives ?? [])
      .map((x) => x.adId)
      .filter(Boolean);
    if (adIds.length === 0) {
      app.toast("No creatives to regenerate yet.", "x", "critical");
      return;
    }
    setRegenBusy(true);
    try {
      const res: RegenerateDTO = await regenerateCampaign(
        c.id,
        adIds,
        creativeData?.assumedSpendCents ?? DEFAULT_SPEND_CENTS,
      );
      if (res.ok) {
        setVariants(res.variants);
        app.toast(
          res.variants.length > 0
            ? `Generated ${res.variants.length} stronger variant(s).`
            : "No variant beat the original.",
          "sparkle",
          "success",
        );
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
      app.toast(
        r.outcome === "succeeded"
          ? "Draft pushed to Meta (paused)"
          : "Push parked for retry",
      );
    } catch {
      app.toast("Couldn't push the draft — check the action history");
    } finally {
      setPushing(false);
    }
  };

  // Header "Push to Meta" targets the strongest regenerated variant; disabled
  // (with an honest tooltip) until one exists — nothing is pushed blind.
  const bestVariant =
    variants.length > 0
      ? variants.reduce((a, b) => (b.composite > a.composite ? b : a))
      : null;

  const losing = c.spend_7d > 0 && c.roas_7d < c.breakeven_roas;
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
        type === "pause_campaign"
          ? "pause"
          : type === "resume_campaign"
            ? "play"
            : "reduce",
      );
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Action failed — please try again.";
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
    cre?.mediaKind === "video"
      ? "Video"
      : cre?.mediaKind === "image" || cre?.imageUrl
        ? "Image"
        : "—";
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
    <Card pad={false} className="cd-campaign-creative-card">
      <div
        className="flex items-center justify-between"
        style={{
          padding: "14px 16px",
          borderBottom: "0.5px solid var(--hairline-strong)",
        }}
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
            <div style={{ fontSize: 13, fontWeight: 640 }}>
              {app.storeLabel}
            </div>
            <div className="cd-caption">Sponsored · {c.platform}</div>
          </div>
        </div>
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.5,
            color: cre?.primaryText ? "var(--text-1)" : "var(--text-3)",
            marginBottom: 12,
          }}
        >
          {cre?.primaryText || creEmptyText}
        </p>
        {cre?.imageUrl ? (
          <img
            src={cre.imageUrl}
            alt={cre.headline || "Ad creative"}
            style={{
              display: "block",
              width: "100%",
              height: 300,
              objectFit: "cover",
              borderRadius: 12,
            }}
          />
        ) : (
          <div
            className="cd-nc-empty"
            style={{
              height: 300,
              background: "var(--gray-bg)",
              borderRadius: 12,
            }}
          >
            {creEmptyText}
          </div>
        )}
        <div
          className="flex items-center justify-between"
          style={{
            gap: 12,
            marginTop: 12,
            padding: "11px 14px",
            background: "var(--gray-bg)",
            borderRadius: 12,
          }}
        >
          <div className="min-w-0">
            <div className="cd-caption" style={{ letterSpacing: "0.04em" }}>
              {cre?.destinationUrl
                ? destinationDomain(cre.destinationUrl)
                : "—"}
            </div>
            <div
              className="truncate"
              style={{
                fontSize: 14,
                fontWeight: 640,
                letterSpacing: "-0.01em",
              }}
            >
              {cre?.headline || "—"}
            </div>
          </div>
          {/* Static preview of the ad's own CTA — part of the creative, not an app control. */}
          <span
            className="cd-btn cd-btn-secondary cd-btn-sm"
            style={{ flexShrink: 0, pointerEvents: "none" }}
          >
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
    <Card pad={false} className="cd-campaign-variants-card">
      <div
        className="flex items-center justify-between"
        style={{
          padding: "14px 16px",
          borderBottom: "0.5px solid var(--hairline-strong)",
        }}
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
          style={{
            gap: 12,
            padding: "13px 16px",
            borderTop: i > 0 ? "0.5px solid var(--hairline)" : undefined,
          }}
        >
          <span className="cd-score" style={compositeChip(v.composite)}>
            {v.composite}
          </span>
          <div className="min-w-0" style={{ flex: 1 }}>
            <div className="cd-row-title truncate">{v.input.headline}</div>
            <div className="cd-caption truncate">{v.rationale}</div>
          </div>
          <b
            className="tabular-nums"
            style={{ color: "var(--live)", fontSize: 13, flexShrink: 0 }}
          >
            +{v.delta}
          </b>
        </div>
      ))}
    </Card>
  );

  // Spend/day and ROAS/day sparklines from ad_spend_fact, aggregated per day
  // by the server. Needs >=2 days to draw a line, so anything short of that
  // falls back to the same honest empty state the card used to always show.
  const spendSeries = series?.map((r) => r.spend_cents / 100) ?? [];
  // Zero-spend days are dropped rather than mapped to 0 — a day can have
  // revenue with no spend recorded yet (rounding/attribution lag), and a 0
  // would draw a false dip. roasSeries renders in its own Sparkline (not
  // index-paired with spendSeries), so dropping points is safe.
  const roasSeries = (series ?? [])
    .filter((r) => r.spend_cents > 0)
    .map((r) => r.revenue_cents / r.spend_cents);
  const chartWidth = narrow ? 260 : 440;
  const chartCard = (
    <Card className="cd-campaign-chart-card">
      <div className="cd-anh-wrap">
        <div className="cd-anh">
          <CDIcon name="arrowUpRight" size={15} />
          Spend and ROAS ·{" "}
          {seriesLoadError
            ? "unavailable"
            : series
              ? `${series.length} ${series.length === 1 ? "day" : "days"}`
              : "loading"}
        </div>
      </div>
      {seriesLoadError ? (
        <div className="cd-nc-empty" style={{ minHeight: 120 }}>
          Couldn't load history — refresh to retry
        </div>
      ) : !series || series.length < 2 ? (
        <div className="cd-nc-empty" style={{ minHeight: 120 }}>
          No history yet — data appears after the first day of spend
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 16, padding: "4px 0" }}>
          <div>
            <div className="cd-caption" style={{ marginBottom: 6 }}>
              Spend/day
            </div>
            <Sparkline data={spendSeries} width={chartWidth} height={56} />
          </div>
          <div>
            <div className="cd-caption" style={{ marginBottom: 6 }}>
              ROAS/day
            </div>
            <Sparkline
              data={roasSeries}
              width={chartWidth}
              height={56}
              stroke="var(--live)"
              refLine={c.breakeven_roas > 0 ? c.breakeven_roas : null}
            />
          </div>
        </div>
      )}
    </Card>
  );

  const scoreCard = (
    <Card>
      <div
        className="cd-caption"
        style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
      >
        Score
      </div>
      <div className="flex items-baseline" style={{ gap: 7, marginTop: 2 }}>
        <span
          className="tabular-nums"
          style={{
            fontSize: 34,
            fontWeight: 680,
            lineHeight: 1,
            color: BAND_CHIP[s.band].color,
          }}
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

  // Keep this rail useful and compact: only fields the campaign sync actually
  // carries belong here. Unavailable delivery metrics stay hidden.
  const deliveryCard = (
    <Card>
      <div className="cd-anh" style={{ marginBottom: 10 }}>
        <CDIcon name="scan" size={15} />
        Campaign setup
      </div>
      <MetricRow k="Platform" v={c.platform} />
      <MetricRow k="Status" v={paused ? "Paused" : "Active"} />
      <MetricRow
        k="Budget"
        v={
          c.daily_budget_cents > 0 ? `${money(c.daily_budget_cents)}/day` : "—"
        }
      />
    </Card>
  );

  return (
    <div
      ref={detailRootRef}
      className="cd-screen"
      data-screen-label="Campaign detail"
    >
      <header className="cd-screen-head">
        <div className="flex items-center" style={{ gap: 10, minWidth: 0 }}>
          <Btn small icon="chevronLeft" onClick={onBack}>
            Back
          </Btn>
          <h1 className="cd-h1 truncate" style={{ fontSize: 24, minWidth: 0 }}>
            {c.name}
          </h1>
          <span className="cd-badge" style={BADGE_NEUTRAL}>
            {c.platform}
          </span>
          <span
            className="cd-badge"
            style={paused ? BADGE_NEUTRAL : BADGE_ACTIVE}
          >
            {paused ? "Paused" : "Active"}
          </span>
        </div>
        <div
          className="flex items-center flex-wrap"
          style={{ gap: 8, flexShrink: 0 }}
        >
          {/* Pause/resume + cut-budget are real operator actions with no other
              home — kept beyond the design's two header buttons (deliberate). */}
          {paused ? (
            <Btn
              small
              icon="play"
              disabled={busy}
              onClick={() =>
                run("resume_campaign", "Campaign resumed.", "active")
              }
            >
              Resume
            </Btn>
          ) : (
            <Btn
              small
              icon="pause"
              disabled={busy}
              onClick={() =>
                run(
                  "pause_campaign",
                  `Campaign paused — syncing to ${c.platform}.`,
                  "paused",
                )
              }
            >
              Pause
            </Btn>
          )}
          {/* 0.7 × nothing is nothing: the action route rejects a zero budget,
              so never offer a cut that cannot succeed. */}
          <span
            title={
              c.daily_budget_cents <= 0
                ? "No daily budget set on this campaign"
                : undefined
            }
          >
            <Btn
              small
              icon="reduce"
              disabled={busy || c.daily_budget_cents <= 0}
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
            {c.daily_budget_cents > 0
              ? `${money(c.daily_budget_cents)}/day budget`
              : "No daily budget set"}
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
              <span
                className="cd-stat-value"
                style={{ color: "var(--text-3)" }}
              >
                —
              </span>
              <span className="cd-caption">No attributed revenue yet</span>
            </>
          )}
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">ROAS (7d)</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: losing ? "var(--text-2)" : "var(--live)" }}
          >
            {c.roas_7d.toFixed(1)}×
          </span>
          <span className="cd-caption tabular-nums">
            break-even {c.breakeven_roas.toFixed(1)}×
          </span>
        </Card>
        <Card className="cd-stat">
          <span className="cd-stat-label">Calderyn score</span>
          <span
            className="cd-stat-value tabular-nums"
            style={{ color: BAND_CHIP[s.band].color }}
          >
            {s.value ?? "—"}
          </span>
          <span className="cd-caption">
            {s.value == null
              ? "Scoring in progress"
              : `${s.confidence} confidence`}
          </span>
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

/* ---------- List ---------- */
function CampaignList({
  app,
  joined,
  setDraftPrefill,
}: {
  app: DashboardCtx;
  joined: CampaignVM[];
  setDraftPrefill: (draft: CampaignDraftRow | null) => void;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  // Owned campaign drafts render alongside synced campaigns. Fetched on mount,
  // and re-fetched after a draft is deleted or a new one is saved from the
  // inline empty-state wizard (which never unmounts this component).
  const [drafts, setDrafts] = useState<CampaignDraftRow[]>([]);
  // Returns its promise so callers (the empty-state wizard's onExit) can wait
  // for the refresh to land before flipping to the "no campaigns" placeholder
  // — otherwise a just-saved draft flashes the wrong empty state for a frame.
  const refreshDrafts = () => {
    return fetchCampaignDrafts()
      .then((rows) => setDrafts(rows))
      .catch((err) => {
        // Non-fatal: the list still renders the synced campaigns. A toast is
        // overkill for a background refresh the merchant didn't initiate —
        // just log it so a real failure isn't silently swallowed.
        console.error("[campaigns] failed to refresh drafts", err);
      });
  };
  useEffect(() => {
    let live = true;
    fetchCampaignDrafts()
      .then((rows) => {
        if (live) setDrafts(rows);
      })
      .catch(() => {
        // Non-fatal: the list still renders the synced campaigns.
      });
    return () => {
      live = false;
    };
  }, []);

  // Empty-state entry point (no campaigns, no drafts) shows the first-campaign
  // wizard inline instead of the plain Placeholder. "Skip" reveals the
  // Placeholder below without leaving the screen.
  const [skippedEmpty, setSkippedEmpty] = useState(false);

  const deleteDraft = async (d: CampaignDraftRow) => {
    if (!window.confirm(`Delete the "${d.name}" draft? This can't be undone.`))
      return;
    try {
      await deleteCampaignDraft(d.id);
      setDrafts((cur) => cur.filter((row) => row.id !== d.id));
      app.toast("Draft deleted.", "check", "success");
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't delete the draft — try again.";
      app.toast(message, "x", "critical");
    }
  };

  // Local optimistic patches from row quick actions (pause/resume/budget),
  // keyed by campaign id — merged over the server data until the next
  // refresh lands.
  const [overrides, setOverrides] = useState<
    Record<string, Partial<CampaignVM>>
  >({});
  const reorderStateRef = useRef<ReturnType<typeof Flip.getState> | null>(null);
  const [budgetFor, setBudgetFor] = useState<CampaignVM | null>(null);
  // Reconcile patches once a new campaigns array arrives: executeAction
  // updates the ad_campaign_dim mirror BEFORE responding, so the action's own
  // refresh() reflects the patch and it can be cleared. But a live poll
  // in flight before the action committed can land after the override is
  // set, with pre-action data — clearing unconditionally would revert the
  // row for ~15s until the next poll. So only drop an override once the
  // fresh row actually reflects every field it patched; otherwise keep it.
  // Keyed on array identity (a new fetch always allocates a new array), not
  // deep equality, so unrelated re-renders still re-run the reconcile (cheap
  // — it is a no-op once everything is reflected).
  useEffect(() => {
    setOverrides((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const fresh = new Map(joined.map((c) => [c.id, c]));
      let changed = false;
      const next: Record<string, Partial<CampaignVM>> = {};
      for (const [id, patch] of Object.entries(prev)) {
        const freshRow = fresh.get(id);
        const reflected =
          freshRow != null &&
          (Object.keys(patch) as (keyof CampaignVM)[]).every(
            (k) => freshRow[k] === patch[k],
          );
        if (reflected) {
          changed = true;
        } else {
          next[id] = patch;
        }
      }
      return changed ? next : prev;
    });
  }, [app.campaigns, joined]);
  const merged = joined.map((c) =>
    overrides[c.id] ? { ...c, ...overrides[c.id] } : c,
  );

  // Active campaigns sort to the top; within each status group, highest 7d
  // spend first. Paused rows still render (dimmed), just below the active ones.
  const shown = sortActiveFirst(merged, (a, b) => b.spend_7d - a.spend_7d);
  const shownOrder = shown.map((c) => c.id).join("|");

  const patchCampaign = (id: string, patch: Partial<CampaignVM>) => {
    const nextOrder = sortActiveFirst(
      merged.map((campaign) =>
        campaign.id === id ? { ...campaign, ...patch } : campaign,
      ),
      (a, b) => b.spend_7d - a.spend_7d,
    )
      .map((campaign) => campaign.id)
      .join("|");
    if (
      patch.status !== undefined &&
      nextOrder !== shownOrder &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const items = screenRef.current?.querySelectorAll(".cd-campaign-item");
      if (items?.length) reorderStateRef.current = Flip.getState(items);
    }
    setOverrides((cur) => ({
      ...cur,
      [id]: { ...cur[id], ...patch },
    }));
  };

  const loading = app.loading && joined.length === 0;

  // Restrained, plain-language readout of the whole account: which platforms are
  // connected, how many campaigns are live, the combined daily spend, and how
  // many are spending without earning their keep. Derived from real fields only.
  const active = shown.filter((c) => c.status !== "paused");
  // Only live campaigns spend, so paused budgets stay out of the $/day figure.
  const perDayCents = active.reduce(
    (sum, c) => sum + Math.max(0, c.daily_budget_cents),
    0,
  );
  const platforms = Array.from(new Set(shown.map((c) => c.platform)));
  // Membership changes animate. Routine analytics polling does not replay
  // the collection entrance and look like a page refresh.
  const collectionSignature = `${loading}`;

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const elements = gsap.utils.toArray<HTMLElement>(
        screenRef.current?.querySelectorAll(".cd-campaign-summary") ?? [],
      );
      if (elements.length === 0) return;
      gsap.fromTo(
        elements,
        { autoAlpha: 0, y: 6 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.28,
          stagger: 0.05,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        },
      );
    },
    { scope: screenRef },
  );

  useGSAP(
    () => {
      const state = reorderStateRef.current;
      reorderStateRef.current = null;
      if (!state) return;
      const root = screenRef.current;
      if (root) root.dataset.reordering = "1";
      const clearReordering = () => {
        if (root) delete root.dataset.reordering;
      };
      const animation = Flip.from(state, {
        duration: 0.32,
        ease: "power2.out",
        absolute: false,
        simple: true,
        stagger: 0.015,
        onComplete: clearReordering,
        onInterrupt: clearReordering,
      });
      return () => {
        clearReordering();
        animation.kill();
      };
    },
    {
      scope: screenRef,
      dependencies: [shownOrder],
    },
  );

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const items = gsap.utils
        .toArray<HTMLElement>(
          screenRef.current?.querySelectorAll(".cd-campaign-item") ?? [],
        )
        .slice(0, 8);
      if (items.length === 0) return;
      gsap.fromTo(
        items,
        { autoAlpha: 0, y: 8, scale: 0.99, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.28,
          stagger: { each: 0.035, from: "start" },
          ease: "power2.out",
          overwrite: "auto",
          clearProps: "opacity,visibility,transform,willChange",
        },
      );
    },
    {
      scope: screenRef,
      dependencies: [collectionSignature],
      revertOnUpdate: true,
    },
  );

  return (
    <div ref={screenRef} className="cd-screen cd-campaign-list">
      <ScreenHeader
        title="Campaigns"
        sub="See what is running, what it costs, and what needs attention."
      >
        <Btn
          kind="primary"
          icon="plus"
          className="cd-new-campaign-btn"
          onClick={() => {
            setDraftPrefill(null);
            app.navigate("campaigns", "new");
          }}
        >
          New campaign
        </Btn>
      </ScreenHeader>
      {(shown.length > 0 || drafts.length > 0) && (
        <div
          className="cd-campaign-summary"
          aria-label="Campaign account summary"
        >
          <div className="flex items-center" style={{ gap: 5 }}>
            {platforms.map((p) => (
              <PlatformMark key={p} platform={p} size={19} />
            ))}
          </div>
          <span>
            <b style={{ color: "var(--text-1)", fontWeight: 600 }}>
              {active.length}
            </b>{" "}
            live {active.length === 1 ? "campaign" : "campaigns"}
          </span>
          <span className="tabular-nums">
            <b style={{ color: "var(--text-1)", fontWeight: 600 }}>
              {money(perDayCents)}
            </b>
            /day budget
          </span>
        </div>
      )}
      {loading || (shown.length === 0 && drafts.length === 0) ? (
        <div
          className="cd-card cd-campaign-table"
          style={{ overflow: "hidden" }}
        >
          {loading ? (
            <TableSkeleton />
          ) : skippedEmpty ? (
            <Placeholder
              icon="megaphone"
              title="No campaigns yet"
              sub="Connect an ad account and your campaigns will appear here."
              actionLabel="Connect ad account"
              onAction={() => app.navigate("settings", null, "connectors")}
            />
          ) : (
            <div className="cd-pad">
              <CampaignWizard
                app={app}
                prefill={null}
                embedded
                onExit={() => {
                  // Wait for the refreshed draft list to land before flipping
                  // to the empty placeholder — otherwise the just-saved draft
                  // is momentarily invisible and the wrong "Connect ad
                  // account" state flashes for a frame.
                  void refreshDrafts().then(() => setSkippedEmpty(true));
                }}
              />
            </div>
          )}
        </div>
      ) : (
        <div
          className="cd-card cd-campaign-table"
          style={{ overflow: "hidden" }}
        >
          <Pan min={560}>
            <div
              className="cd-tablehd"
              style={{
                gridTemplateColumns: CAMP_GRID,
                gap: 10,
                padding: "9px 16px",
              }}
            >
              <span>Campaign</span>
              {/* No per-campaign autopilot flag exists in the data, so this
                  column shows the real status instead of an Auto/Manual state. */}
              <span>Status</span>
              <span>Daily</span>
              <span>ROAS</span>
              <span className="text-right">Score</span>
              <span />
              <span />
            </div>
            {shown.map((c) => (
              <CampaignRow
                key={c.id}
                app={app}
                c={c}
                onClick={() => app.navigate("campaigns", c.id)}
                onEditBudget={() => setBudgetFor(c)}
                onChanged={(patch) => patchCampaign(c.id, patch)}
              />
            ))}
            {drafts.map((d) => (
              <DraftRow
                key={d.id}
                d={d}
                onContinue={() => {
                  setDraftPrefill(d);
                  app.navigate("campaigns", "new");
                }}
                onDelete={() => deleteDraft(d)}
              />
            ))}
          </Pan>
        </div>
      )}
      {budgetFor && (
        <EditBudgetModal
          app={app}
          c={budgetFor}
          onClose={() => setBudgetFor(null)}
          onSaved={(newCents) =>
            setOverrides((cur) => ({
              ...cur,
              [budgetFor.id]: {
                ...cur[budgetFor.id],
                daily_budget_cents: newCents,
              },
            }))
          }
        />
      )}
    </div>
  );
}

/* ---------- Screen ---------- */
export default function Campaigns({ app }: { app: DashboardCtx }) {
  // Real grades + break-even come from fetchAnalytics(); join by campaign_id.
  // While this is in flight the campaigns render with whatever grade they carry.
  const [grades, setGrades] = useState<CampaignGradeRow[]>([]);
  const [metaCanPushDrafts, setMetaCanPushDrafts] = useState(false);
  // Carries a draft's { id, name, platform } into the wizard when the merchant
  // hits "Continue setup" on a DraftRow — lifted here since the wizard mounts
  // fresh on the "new" nav param, unrelated to CampaignList's own state. The
  // id lets the wizard replace the resumed draft instead of duplicating it.
  const [draftPrefill, setDraftPrefill] = useState<CampaignDraftRow | null>(
    null,
  );

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
        return {
          ...c,
          grade: gradeFromRow(g, c.roas_7d),
          breakeven_roas: g.break_even_roas,
        };
      }),
    [app.campaigns, grades],
  );

  if (app.nav.param === "new") {
    return (
      <CampaignWizard
        app={app}
        prefill={draftPrefill}
        onExit={() => {
          setDraftPrefill(null);
          app.navigate("campaigns");
        }}
      />
    );
  }

  // Row-click / deep-link: nav.param carries the selected campaign id.
  const selected = app.nav.param
    ? joined.find((c) => c.id === app.nav.param)
    : null;
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

  return (
    <CampaignList app={app} joined={joined} setDraftPrefill={setDraftPrefill} />
  );
}
