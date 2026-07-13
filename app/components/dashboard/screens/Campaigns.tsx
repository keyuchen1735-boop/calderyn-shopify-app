import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { gradeFromRow } from "~/lib/campaign-grade";
import {
  Card,
  Btn,
  Segmented,
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
  screenCampaignCreative,
  type CampaignCreativesDTO,
  type RegenerateDTO,
} from "~/lib/dashboard/client";
import {
  fetchCampaignDrafts,
  deleteCampaignDraft,
  type CampaignDraftRow,
} from "~/lib/dashboard/campaign-drafts-client";
import { CampaignWizard } from "./CampaignWizard";
import {
  CAMPAIGN_DRAFT_PLATFORM_LABELS,
  type CampaignDraftPlatform,
} from "~/lib/ads/campaign-draft-types";
import type { Variant, CreativeScreenRun, CreativeInput } from "~/lib/screener/types";
import { DEFAULT_SPEND_CENTS } from "~/lib/screener/types";
import { sortActiveFirst } from "~/lib/campaign-sort";
import type { DashboardCtx } from "../context";
import type { CampaignVM } from "../view-models";
import type { CampaignGradeRow, DailyRoasRow } from "~/lib/types";
import {
  campaignPortfolio,
  campaignStory,
  portfolioGreeting,
  roasRailPosition,
  type CampaignHealth,
} from "./campaign-experience";

gsap.registerPlugin(useGSAP);

const PENDING_SCORE: CampaignCalderynScore = {
  value: null, band: "nodata", performance: null, creative: null, confidence: "low",
  weakDimensions: [], tips: [], adsCovered: 0, adsTotal: 0,
};

/** Shared column template for the campaigns table (header + rows). */
const CAMP_GRID = "minmax(0,1fr) 72px 96px 68px 54px 104px 22px";

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

const PLATFORM_TONE: Record<string, string> = {
  Meta: "#5568f2",
  Google: "#d95f43",
  TikTok: "#1f9c91",
};

function CampaignPlatformMark({ platform, size = 30 }: { platform: string; size?: number }) {
  return (
    <span
      className="cd-campaign-platform-mark"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        background: PLATFORM_TONE[platform] ?? "var(--accent)",
        fontSize: Math.round(size * 0.42),
      }}
    >
      {platform.slice(0, 1).toUpperCase()}
    </span>
  );
}

function CampaignArtwork({
  platform,
  name,
  health,
  compact = false,
}: {
  platform: string;
  name: string;
  health: CampaignHealth | "draft";
  compact?: boolean;
}) {
  return (
    <div
      className="cd-campaign-art"
      data-platform={platform.toLowerCase()}
      data-health={health}
      data-compact={compact ? "1" : "0"}
      aria-hidden="true"
    >
      <span className="cd-campaign-art-orbit cd-campaign-art-orbit-a" />
      <span className="cd-campaign-art-orbit cd-campaign-art-orbit-b" />
      <span className="cd-campaign-art-spark cd-campaign-art-spark-a" />
      <span className="cd-campaign-art-spark cd-campaign-art-spark-b" />
      <div className="cd-campaign-art-copy">
        <span>{platform}</span>
        <strong>{name.trim() || "Your next campaign"}</strong>
      </div>
      <div className="cd-campaign-art-stamp">
        <CampaignPlatformMark platform={platform} size={compact ? 30 : 38} />
      </div>
    </div>
  );
}

function CampaignPoster({ c, onClick }: { c: CampaignVM; onClick: () => void }) {
  const story = campaignStory(c);
  const score = c.calderynScore ?? PENDING_SCORE;
  const hasBudget = c.daily_budget_cents > 0;
  const perDay = hasBudget
    ? c.daily_budget_cents
    : c.spend_7d > 0
      ? Math.round(c.spend_7d / 7)
      : null;

  return (
    <button className="cd-campaign-poster cd-campaign-reveal" data-health={story.health} onClick={onClick}>
      <CampaignArtwork platform={c.platform} name={c.name} health={story.health} />
      <div className="cd-campaign-poster-body">
        <div className="flex items-center justify-between" style={{ gap: 10 }}>
          <span className="cd-campaign-kicker">
            <i /> {story.eyebrow}
          </span>
          <ScoreChip score={score} />
        </div>
        <div>
          <h3 className="cd-campaign-poster-title">{c.name}</h3>
          <p className="cd-campaign-poster-verdict">{story.verdict}</p>
        </div>
        <div className="cd-campaign-poster-stats">
          <span>
            <small>ROAS</small>
            <b>{c.spend_7d > 0 ? `${c.roas_7d.toFixed(1)}×` : "Learning"}</b>
          </span>
          <span>
            <small>Break-even</small>
            <b>{c.breakeven_roas.toFixed(1)}×</b>
          </span>
          <span>
            <small>{hasBudget ? "Budget" : "Daily pace"}</small>
            <b>{perDay == null ? "—" : `${money(perDay)}/d`}</b>
          </span>
        </div>
        <span className="cd-campaign-open">
          Read campaign <CDIcon name="arrowRight" size={14} />
        </span>
      </div>
    </button>
  );
}

function DraftPoster({
  draft,
  onContinue,
  onDelete,
}: {
  draft: CampaignDraftRow;
  onContinue: () => void;
  onDelete: () => void;
}) {
  const platform = CAMPAIGN_DRAFT_PLATFORM_LABELS[draft.platform];
  return (
    <article className="cd-campaign-poster cd-campaign-poster-draft cd-campaign-reveal">
      <CampaignArtwork platform={platform} name={draft.name} health="draft" />
      <div className="cd-campaign-poster-body">
        <div className="flex items-center justify-between" style={{ gap: 10 }}>
          <span className="cd-campaign-kicker"><i /> Draft saved</span>
          <span className="cd-badge" style={BADGE_NEUTRAL}>Draft</span>
        </div>
        <div>
          <h3 className="cd-campaign-poster-title">{draft.name}</h3>
          <p className="cd-campaign-poster-verdict">Nothing is live or spending yet.</p>
        </div>
        <div className="cd-caption">Created {timeAgo(draft.createdAt)} · {platform}</div>
        <div className="flex items-center" style={{ gap: 8, marginTop: "auto" }}>
          <Btn kind="primary" small icon="arrowRight" onClick={onContinue}>Continue setup</Btn>
          <Btn small icon="trash" ariaLabel="Delete draft" onClick={onDelete}>{""}</Btn>
        </div>
      </div>
    </article>
  );
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
        err instanceof DashboardApiError ? err.message : "Action failed — try again.";
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
              ? run("resume_campaign", "Campaign resumed.", { status: "active" })
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
              onClick={() => run("duplicate_campaign", "Copy created on Meta (paused).", {})}
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
    // A div with button semantics rather than a real <button>: the row nests
    // the per-row action buttons (pause/resume, edit budget, duplicate),
    // which are invalid inside <button>.
    <div
      role="button"
      tabIndex={0}
      className="cd-camp-row"
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
      <RowQuickActions app={app} c={c} onEditBudget={onEditBudget} onChanged={onChanged} />
      <div className="flex" style={{ justifyContent: "flex-end", color: "var(--text-3)" }}>
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
      <div className="flex items-center justify-end" style={{ gap: 4 }}>
        <Btn small icon="arrowRight" onClick={onContinue}>
          Continue setup
        </Btn>
      </div>
      <div className="flex items-center justify-end">
        <Tooltip content="Delete draft">
          <Btn small icon="trash" className="cd-btn-icon" ariaLabel="Delete draft" onClick={onDelete}>
            {""}
          </Btn>
        </Tooltip>
      </div>
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
  analyticsError,
  analyticsLoading,
  onRetryAnalytics,
}: {
  app: DashboardCtx;
  c: CampaignVM;
  /** Latest grade row for this campaign (attributed revenue); undefined until
   *  analytics loads or when the campaign has no grade yet. */
  grade?: CampaignGradeRow;
  onBack: () => void;
  metaCanPushDrafts: boolean;
  analyticsError: string | null;
  analyticsLoading: boolean;
  onRetryAnalytics: () => void;
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
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { duration: 0.46, ease: "power3.out" } });
      timeline
        .fromTo(".cd-campaign-story-hero", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0 }, "intro")
        .fromTo(
          ".cd-campaign-story-reveal",
          { autoAlpha: 0, y: 12 },
          { autoAlpha: 1, y: 0, stagger: 0.07 },
          "intro+=0.1",
        );
    },
    { scope: rootRef, dependencies: [c.id], revertOnUpdate: true },
  );

  useEffect(() => {
    let live = true;
    setCreativesLoadError(false);
    fetchCampaignCreatives(c.id)
      .then((d) => { if (live) setCreativeData(d); })
      .catch(() => { if (live) setCreativesLoadError(true); });
    return () => { live = false; };
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
      .then((s) => { if (live) setSeries(s); })
      .catch(() => { if (live) setSeriesLoadError(true); });
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
  const story = campaignStory({ ...c, status });
  const isMeta = c.platform === "Meta";

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
  // Honest message for the empty creative slot, by cause.
  const creEmptyText = creativeEmptyText(c.platform, {
    loadError: creativesLoadError,
    data: creativeData,
  });

  const creativeCard = (
    <Card pad={false} className="cd-campaign-story-reveal">
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
    <Card pad={false} className="cd-campaign-story-reveal">
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

  // Spend/day and ROAS/day sparklines from ad_spend_fact, aggregated per day
  // by the server. Needs >=2 days to draw a line, so anything short of that
  // falls back to the same honest empty state the card used to always show.
  const spendSeries = series?.map((r) => r.spend_cents / 100) ?? [];
  // Zero-spend days are dropped rather than mapped to 0 — a day can have
  // revenue with no spend recorded yet (rounding/attribution lag), and a 0
  // would draw a false dip. roasSeries renders in its own Sparkline (not
  // index-paired with spendSeries), so dropping points is safe.
  const roasSeries = (series ?? []).filter((r) => r.spend_cents > 0).map((r) => r.revenue_cents / r.spend_cents);
  const chartWidth = narrow ? 260 : 440;
  const chartCard = (
    <Card className="cd-campaign-story-reveal">
      <div className="cd-anh-wrap">
        <div className="cd-anh">
          <CDIcon name="arrowUpRight" size={15} />
          Spend vs revenue ·{" "}
          {seriesLoadError
            ? "unavailable"
            : series
              ? `${series.length} ${series.length === 1 ? "day" : "days"}`
              : "loading"}
        </div>
        <span className="cd-caption">latest attributed day</span>
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
            <div className="cd-caption" style={{ marginBottom: 6 }}>Spend/day</div>
            <Sparkline data={spendSeries} width={chartWidth} height={56} />
          </div>
          <div>
            <div className="cd-caption" style={{ marginBottom: 6 }}>ROAS/day</div>
            <Sparkline
              data={roasSeries}
              width={chartWidth}
              height={56}
              stroke="var(--green)"
              refLine={c.breakeven_roas > 0 ? c.breakeven_roas : null}
            />
          </div>
        </div>
      )}
    </Card>
  );

  const scoreCard = (
    <Card className="cd-campaign-score-story cd-campaign-story-reveal">
      <div className="cd-anh"><CDIcon name="gauge" size={15} /> Calderyn score</div>
      <div className="cd-campaign-score-orbit" style={{ background: `conic-gradient(${BAND_CHIP[s.band].color} ${(s.value ?? 0) * 1}%, var(--gray-bg) 0)` }}>
        <span><b>{s.value ?? "—"}</b><small>/ 100</small></span>
      </div>
      <p className="cd-caption">
        {s.value == null ? "Waiting for enough ad evidence to score this campaign." : s.band === "strong" ? "A strong blend of performance and creative evidence." : s.band === "fair" ? "A workable foundation with room to improve." : "The score is pointing to a clear improvement opportunity."}
      </p>
      <div style={{ marginTop: 14 }}>
        <ScoreDim label="Performance" value={s.performance} />
        <ScoreDim label="Creative" value={s.creative} />
      </div>
      <div className="cd-caption" style={{ marginTop: 4 }}>
        Confidence: {s.confidence} · Ads scored {s.adsCovered}/{s.adsTotal}
      </div>
    </Card>
  );

  const deliveryCard = (
    <Card className="cd-campaign-story-reveal">
      <div className="cd-anh" style={{ marginBottom: 10 }}>
        <CDIcon name="eye" size={15} />
        How to read this
      </div>
      <p className="cd-campaign-reading-copy">{story.detail}</p>
      <MetricRow k="Platform" v={c.platform} />
      <MetricRow k="Status" v={paused ? "Paused" : "Active"} />
      <MetricRow
        k="Daily budget"
        v={c.daily_budget_cents > 0 ? `${money(c.daily_budget_cents)}/day` : "—"}
      />
      <MetricRow k="Score confidence" v={s.confidence} />
      <MetricRow k="Ads scored" v={`${s.adsCovered}/${s.adsTotal}`} />
    </Card>
  );

  return (
    <div ref={rootRef} className="cd-screen cd-screen--wide cd-campaign-story" data-screen-label="Campaign detail">
      <header className="cd-campaign-story-nav">
        <Btn small icon="chevronLeft" onClick={onBack}>Campaigns</Btn>
        <div><CampaignPlatformMark platform={c.platform} size={26} /><span>{c.platform}</span><i /> <span>{paused ? "Paused" : "Active"}</span></div>
      </header>

      <section className="cd-campaign-story-hero" data-health={story.health}>
        <CampaignArtwork platform={c.platform} name={c.name} health={story.health} compact />
        <div className="cd-campaign-story-copy">
          <span className="cd-campaign-builder-kicker">{story.eyebrow}</span>
          <h1>{c.name}</h1>
          <p>{story.verdict}</p>
          <div className="cd-campaign-roas-rail">
            <div>
              <span style={{ left: `${roasRailPosition(c.breakeven_roas, Math.max(c.roas_7d, c.breakeven_roas))}%` }} data-kind="break-even">
                <i />
                <b>Break-even {c.breakeven_roas.toFixed(1)}×</b>
              </span>
              <span style={{ left: `${roasRailPosition(c.roas_7d, Math.max(c.roas_7d, c.breakeven_roas))}%` }} data-kind="current">
                <i />
                <b>Current {c.roas_7d.toFixed(1)}×</b>
              </span>
            </div>
            <p><span>Lower return</span><span>Higher return</span></p>
          </div>
        </div>
      </section>

      <section className="cd-campaign-action-dock cd-campaign-story-reveal">
        <div>
          <span className="cd-campaign-builder-kicker">Your next move</span>
          <strong>{paused ? "Resume when you are ready to gather fresh signal." : losing ? "Protect the budget while you inspect what is holding return back." : "Keep the campaign steady or improve its strongest creative."}</strong>
        </div>
        <div className="flex items-center flex-wrap" style={{ gap: 8 }}>
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
      </section>

      <div className="cd-stat-grid cd-campaign-story-reveal">
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
  analyticsError,
  onRetryAnalytics,
}: {
  app: DashboardCtx;
  joined: CampaignVM[];
  setDraftPrefill: (p: { id?: string; name?: string; platform?: CampaignDraftPlatform } | null) => void;
  analyticsError: string | null;
  onRetryAnalytics: () => void;
}) {
  // Owned campaign drafts render alongside synced campaigns. Fetched on mount,
  // and re-fetched after a draft is deleted or a new one is saved from the
  // inline empty-state wizard (which never unmounts this component).
  const [drafts, setDrafts] = useState<CampaignDraftRow[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(true);
  const [draftRetry, setDraftRetry] = useState(0);
  const [view, setView] = useState<"gallery" | "list">("gallery");
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setDraftError(null);
    setDraftLoading(true);
    fetchCampaignDrafts()
      .then((rows) => { if (live) setDrafts(rows); })
      .catch((error: unknown) => {
        if (live) {
          setDraftError(
            error instanceof DashboardApiError
              ? error.message
              : "Refresh or try again in a moment. Live campaigns are still available below.",
          );
        }
      })
      .finally(() => { if (live) setDraftLoading(false); });
    return () => { live = false; };
  }, [draftRetry]);

  const deleteDraft = async (d: CampaignDraftRow) => {
    if (!window.confirm(`Delete the "${d.name}" draft? This can't be undone.`)) return;
    try {
      await deleteCampaignDraft(d.id);
      setDrafts((cur) => cur.filter((row) => row.id !== d.id));
      app.toast("Draft deleted.", "check", "success");
    } catch (err) {
      const message =
        err instanceof DashboardApiError ? err.message : "Couldn't delete the draft — try again.";
      app.toast(message, "x", "critical");
    }
  };

  // Local optimistic patches from row quick actions (pause/resume/budget),
  // keyed by campaign id — merged over the server data until the next
  // refresh lands.
  const [overrides, setOverrides] = useState<Record<string, Partial<CampaignVM>>>({});
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
          (Object.keys(patch) as (keyof CampaignVM)[]).every((k) => freshRow[k] === patch[k]);
        if (reflected) {
          changed = true;
        } else {
          next[id] = patch;
        }
      }
      return changed ? next : prev;
    });
  }, [app.campaigns, joined]);
  const merged = joined.map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c));

  // Active campaigns sort to the top; within each status group, highest 7d
  // spend first. Paused rows still render (dimmed), just below the active ones.
  const shown = sortActiveFirst(merged, (a, b) => b.spend_7d - a.spend_7d);
  const summary = campaignPortfolio(shown);
  const greeting = portfolioGreeting(summary);
  const featured =
    shown.find((campaign) => campaignStory(campaign).health === "attention") ??
    shown.find((campaign) => campaignStory(campaign).health === "healthy") ??
    shown.find((campaign) => campaign.status !== "paused") ??
    shown[0];
  const loading = (app.loading && joined.length === 0) || (draftLoading && shown.length === 0);

  useGSAP(
    () => {
      if (loading || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { duration: 0.48, ease: "power3.out" } });
      timeline
        .fromTo(".cd-campaign-briefing", { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0 }, "intro")
        .fromTo(
          ".cd-campaign-reveal",
          { autoAlpha: 0, y: 14 },
          { autoAlpha: 1, y: 0, stagger: 0.06 },
          "intro+=0.1",
        );
    },
    { scope: rootRef, dependencies: [loading, view, drafts.length], revertOnUpdate: true },
  );

  return (
    <div ref={rootRef} className="cd-screen cd-screen--wide cd-campaign-library">
      <ScreenHeader title="Campaigns" sub="A visual read on every campaign — and what deserves your attention next.">
        <Btn kind="primary" small icon="plus" onClick={() => { setDraftPrefill(null); app.navigate("campaigns", "new"); }}>
          Create campaign
        </Btn>
      </ScreenHeader>

      {analyticsError && (
        <div className="cd-campaign-data-error" role="alert">
          <CDIcon name="warn" size={18} />
          <span><strong>Some campaign analytics could not load.</strong><small>{analyticsError}</small></span>
          <Btn small onClick={onRetryAnalytics}>Try again</Btn>
        </div>
      )}
      {draftError && (
        <div className="cd-campaign-data-error" role="alert">
          <CDIcon name="warn" size={18} />
          <span><strong>Saved campaign drafts could not load.</strong><small>{draftError}</small></span>
          <Btn small onClick={() => setDraftRetry((value) => value + 1)}>Try again</Btn>
        </div>
      )}

      {loading ? (
        <div className="cd-card"><TableSkeleton rows={5} /></div>
      ) : shown.length === 0 && drafts.length === 0 ? (
        <div className="cd-campaign-empty cd-campaign-briefing">
          <CampaignArtwork platform="Calderyn" name="Your first campaign" health="draft" compact />
          <div>
            <span className="cd-campaign-builder-kicker">A fresh campaign library</span>
            <h2>Start a draft or bring your live campaigns in.</h2>
            <p>Create a safe draft in Calderyn, or connect an ad account to see current performance here.</p>
            <div className="flex items-center flex-wrap" style={{ gap: 8, marginTop: 18 }}>
              <Btn kind="primary" icon="plus" onClick={() => { setDraftPrefill(null); app.navigate("campaigns", "new"); }}>Create campaign</Btn>
              <Btn icon="bolt" onClick={() => app.navigate("settings", null, "connectors")}>Connect ad account</Btn>
            </div>
          </div>
        </div>
      ) : (
        <>
          <section className="cd-campaign-briefing" data-tone={summary.attentionCount > 0 ? "attention" : "healthy"}>
            <div className="cd-campaign-briefing-copy">
              <span className="cd-campaign-builder-kicker">Your campaign briefing</span>
              <h2>{greeting.title}</h2>
              <p>{greeting.detail}</p>
              {featured && (
                <button type="button" onClick={() => app.navigate("campaigns", featured.id)}>
                  {campaignStory(featured).health === "attention" ? "Review first" : "Open the lead campaign"}
                  <CDIcon name="arrowRight" size={15} />
                </button>
              )}
            </div>
            <div className="cd-campaign-briefing-visual" aria-label={`${summary.activeCount} live campaigns, ${summary.attentionCount} needing attention`}>
              <div className="cd-campaign-pulse-orbit">
                <span>{summary.activeCount}</span>
                <small>live</small>
                {shown.slice(0, 5).map((campaign, index) => (
                  <i
                    key={campaign.id}
                    data-health={campaignStory(campaign).health}
                    style={{ "--orbit-index": index } as CSSProperties}
                  />
                ))}
              </div>
            </div>
            <div className="cd-campaign-briefing-stats">
              <span><small>Daily pace</small><b>{money(summary.dailyBudgetCents)}</b></span>
              <span><small>Healthy</small><b>{summary.healthyCount}</b></span>
              <span><small>Needs attention</small><b>{summary.attentionCount}</b></span>
              <span><small>Learning</small><b>{summary.learningCount}</b></span>
            </div>
          </section>

          <div className="cd-campaign-section-head">
            <div>
              <span className="cd-campaign-builder-kicker">Campaign library</span>
              <h2>Pick a campaign to read its story.</h2>
            </div>
            <Segmented
              small
              value={view}
              onChange={(value) => setView(value as "gallery" | "list")}
              options={[{ value: "gallery", label: "Gallery" }, { value: "list", label: "Compact" }]}
            />
          </div>

          {view === "gallery" ? (
            <div className="cd-campaign-gallery">
              {shown.map((campaign) => (
                <CampaignPoster key={campaign.id} c={campaign} onClick={() => app.navigate("campaigns", campaign.id)} />
              ))}
              {drafts.map((draft) => (
                <DraftPoster
                  key={draft.id}
                  draft={draft}
                  onContinue={() => { setDraftPrefill({ id: draft.id, name: draft.name, platform: draft.platform }); app.navigate("campaigns", "new"); }}
                  onDelete={() => { void deleteDraft(draft); }}
                />
              ))}
            </div>
          ) : (
            <div className="cd-card cd-campaign-reveal" style={{ overflow: "hidden" }}>
              <div className="cd-tablehd" style={{ gridTemplateColumns: CAMP_GRID, gap: 12, padding: "13px 20px" }}>
                <span>Campaign</span>
                <span>Status</span>
                <span>Spend/day</span>
                <span>ROAS</span>
                <span className="text-right">Score</span>
                <span />
                <span />
              </div>
              {shown.map((campaign) => (
                <CampaignRow
                  key={campaign.id}
                  app={app}
                  c={campaign}
                  onClick={() => app.navigate("campaigns", campaign.id)}
                  onEditBudget={() => setBudgetFor(campaign)}
                  onChanged={(patch) => setOverrides((cur) => ({ ...cur, [campaign.id]: { ...cur[campaign.id], ...patch } }))}
                />
              ))}
              {drafts.map((draft) => (
                <DraftRow
                  key={draft.id}
                  d={draft}
                  onContinue={() => { setDraftPrefill({ id: draft.id, name: draft.name, platform: draft.platform }); app.navigate("campaigns", "new"); }}
                  onDelete={() => { void deleteDraft(draft); }}
                />
              ))}
            </div>
          )}

          {shown.length > 0 && <ScreenNewCreativeCard app={app} campaigns={shown} />}
        </>
      )}
      {budgetFor && (
        <EditBudgetModal
          app={app}
          c={budgetFor}
          onClose={() => setBudgetFor(null)}
          onSaved={(newCents) => setOverrides((cur) => ({
            ...cur,
            [budgetFor.id]: { ...cur[budgetFor.id], daily_budget_cents: newCents },
          }))}
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
  const [draftPrefill, setDraftPrefill] = useState<{ id?: string; name?: string; platform?: CampaignDraftPlatform } | null>(
    null,
  );
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsRetry, setAnalyticsRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setAnalyticsError(null);
    setAnalyticsLoading(true);
    fetchAnalytics()
      .then((res) => {
        if (alive) {
          setGrades(res.grades);
          setMetaCanPushDrafts(res.metaCanPushDrafts);
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setAnalyticsError(
            error instanceof DashboardApiError
              ? error.message
              : "Refresh or try again in a moment. Campaigns are still available below.",
          );
        }
      })
      .finally(() => { if (alive) setAnalyticsLoading(false); });
    return () => {
      alive = false;
    };
  }, [analyticsRetry]);

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
  const selected = app.nav.param ? joined.find((c) => c.id === app.nav.param) : null;
  if (selected) {
    return (
      <CampaignDetail
        app={app}
        c={selected}
        grade={gradeFor(selected.id)}
        onBack={() => app.navigate("campaigns")}
        metaCanPushDrafts={metaCanPushDrafts}
        analyticsError={analyticsError}
        analyticsLoading={analyticsLoading}
        onRetryAnalytics={() => setAnalyticsRetry((value) => value + 1)}
      />
    );
  }

  return (
    <CampaignList
      app={app}
      joined={joined}
      setDraftPrefill={setDraftPrefill}
      analyticsError={analyticsError}
      onRetryAnalytics={() => setAnalyticsRetry((value) => value + 1)}
    />
  );
}
