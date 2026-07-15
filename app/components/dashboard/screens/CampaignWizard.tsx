import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { CalderynHexMark } from "~/components/CalderynHexMark";
import {
  Card,
  Btn,
  ClearableSearchInput,
  Placeholder,
  PlatformMark,
} from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import {
  fetchFirstRunPreflight,
  generateFirstRunCreatives,
  buildFirstRunPlaceholderVariants,
  createFirstCampaignRun,
  executeCampaignAction,
  startIntegrationConnect,
  fetchProducts,
  uploadCampaignCreativeImage,
  DashboardApiError,
  type FirstRunPreflight,
  type FirstRunCreativeVariant,
  type ProductSummaryVM,
} from "~/lib/dashboard/client";
import {
  createCampaignDraft,
  updateCampaignDraft,
} from "~/lib/dashboard/campaign-drafts-client";
import { META_CTA_TYPES } from "~/lib/meta/cta-types";
import {
  MAX_CAMPAIGN_DRAFT_NAME_LENGTH,
  type CampaignDraftPlatform,
  type CampaignDraftRow,
  type CampaignDraftState,
} from "~/lib/ads/campaign-draft-types";
import type { DashboardCtx } from "../context";

/** A saved draft carries the complete wizard state needed to resume at review. */
type WizardPrefill = CampaignDraftRow | null;

/* ---------- Shared constants ---------- */

const DEFAULT_BUDGET_CENTS = 1500;

/** Meta creation is available only after a fresh, successful preflight check. */
const META_CREATE_ENABLED = true;

const BADGE_GOOD = {
  color: "var(--live)",
  background: "color-mix(in oklch, var(--live) 13%, transparent)",
} as const;

const STEP_ORDER = ["platform", "product", "creative", "review"] as const;
type WizardStep = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<WizardStep, { label: string; detail: string }> = {
  platform: { label: "Platform", detail: "Choose where it runs" },
  product: { label: "Product", detail: "Choose what to promote" },
  creative: { label: "Creative", detail: "Pick a winning direction" },
  review: { label: "Review", detail: "Preview and finish" },
};

type CampaignPlacement = "facebook" | "instagram" | "google" | "tiktok";

const CAMPAIGN_PLACEMENTS: Array<{
  id: CampaignPlacement;
  label: string;
  platform: CampaignDraftPlatform;
  detail: string;
}> = [
  {
    id: "facebook",
    label: "Facebook",
    platform: "meta",
    detail: "Feed and mobile placements",
  },
  {
    id: "instagram",
    label: "Instagram",
    platform: "meta",
    detail: "Feed-first visual ads",
  },
  {
    id: "google",
    label: "Google",
    platform: "google",
    detail: "Preview and save a draft",
  },
  {
    id: "tiktok",
    label: "TikTok",
    platform: "tiktok",
    detail: "Preview and save a draft",
  },
];

function defaultPlacement(platform: CampaignDraftPlatform): CampaignPlacement {
  if (platform === "google") return "google";
  if (platform === "tiktok") return "tiktok";
  return "facebook";
}

function placementLabel(placement: CampaignPlacement): string {
  return (
    CAMPAIGN_PLACEMENTS.find((option) => option.id === placement)?.label ??
    "Facebook"
  );
}

const REVIEW_PREVIEW_PLACEMENTS: CampaignPlacement[] = [
  "instagram",
  "facebook",
  "google",
  "tiktok",
];

function isMobileOnlyPreview(placement: CampaignPlacement): boolean {
  return placement === "instagram" || placement === "tiktok";
}

gsap.registerPlugin(useGSAP);

interface CreativeFields {
  headline: string;
  primaryText: string;
  cta: string;
  /** Signed product image the copy was scored against, resolved by the server. */
  imageUrl: string | null;
  /** The product's storefront page — server-resolved for the same reason. */
  destinationUrl: string;
  audience: string;
}

interface WizardState {
  step: WizardStep;
  /** Client-minted once at wizard mount and held stable for the wizard's whole
   *  lifetime, including retries after a failed Meta create — that's what makes
   *  a retried create idempotent server-side instead of a second campaign. */
  runId: string;
  platform: CampaignDraftPlatform;
  placement: CampaignPlacement;
  preflight: FirstRunPreflight | null;
  productId: string | null;
  productTitle: string | null;
  productImageUrl: string | null;
  /** The product whose initial paid image set the user explicitly approved.
   * Keeping this in wizard state lets Back/forward navigation resume the same
   * idempotent attempt instead of silently starting or spending again. */
  generationApprovedProductId: string | null;
  budgetCents: number;
  creative: CreativeFields | null;
  creativeVariants: FirstRunCreativeVariant[] | null;
  selectedCreativeIndex: number;
  regenerationsLeft: number;
}

type WizardAction =
  | { type: "step"; step: WizardStep }
  | {
      type: "placement";
      placement: CampaignPlacement;
      platform: CampaignDraftPlatform;
    }
  | { type: "preflight"; preflight: FirstRunPreflight }
  | { type: "product"; id: string; title: string; imageUrl: string | null }
  | { type: "confirmGeneration"; productId: string }
  | { type: "budget"; cents: number }
  | { type: "creative"; creative: CreativeFields }
  | {
      type: "creativeOptions";
      variants: FirstRunCreativeVariant[];
      creative: CreativeFields;
      regenerationsLeft: number;
    }
  | { type: "creativeSelection"; index: number; creative: CreativeFields }
  | { type: "regenerationsLeft"; value: number }
  /** Mint a fresh runId: the server 409s (run_input_mismatch) when a runId is
   *  replayed with different campaign details, so an edited run starts over. */
  | { type: "newRunId" };

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "step":
      return { ...state, step: action.step };
    case "placement": {
      // Re-picking the already-selected placement is a no-op. Resetting
      // preflight here would leave PlatformStep's guarded effect dep unchanged
      // (state.platform), so the "Checking your Meta connection…" state would
      // never resolve again.
      if (action.placement === state.placement) return state;
      // Facebook and Instagram share the same Meta connection, so switching
      // between them keeps a valid preflight result. Crossing integrations does not.
      const keepMetaPreflight =
        state.platform === "meta" && action.platform === "meta";
      return {
        ...state,
        placement: action.placement,
        platform: action.platform,
        preflight: keepMetaPreflight ? state.preflight : null,
      };
    }
    case "preflight":
      return { ...state, preflight: action.preflight };
    case "product":
      // Re-selecting the current product must not erase a generated set (or an
      // in-flight approval) when the user revisits the Product step.
      if (action.id === state.productId) return state;
      // A new product invalidates any creative generated for the old one.
      return {
        ...state,
        productId: action.id,
        productTitle: action.title,
        productImageUrl: action.imageUrl,
        generationApprovedProductId: null,
        creative: null,
        creativeVariants: null,
        selectedCreativeIndex: 0,
        regenerationsLeft: 2,
      };
    case "confirmGeneration":
      if (action.productId !== state.productId) return state;
      return { ...state, generationApprovedProductId: action.productId };
    case "budget":
      return { ...state, budgetCents: action.cents };
    case "creative":
      return { ...state, creative: action.creative };
    case "creativeOptions":
      return {
        ...state,
        creativeVariants: action.variants,
        selectedCreativeIndex: 0,
        creative: action.creative,
        regenerationsLeft: action.regenerationsLeft,
      };
    case "creativeSelection":
      return {
        ...state,
        selectedCreativeIndex: action.index,
        creative: action.creative,
      };
    case "regenerationsLeft":
      return {
        ...state,
        regenerationsLeft: Math.max(0, Math.min(2, action.value)),
      };
    case "newRunId":
      return { ...state, runId: crypto.randomUUID() };
    default:
      return state;
  }
}

function initWizardState(prefill: WizardPrefill): WizardState {
  if (prefill?.state) {
    return {
      step: "review",
      runId: prefill.state.runId,
      platform: prefill.platform,
      placement: prefill.state.placement,
      preflight: null,
      productId: prefill.state.productId,
      productTitle: prefill.state.productTitle,
      productImageUrl: prefill.state.productImageUrl,
      generationApprovedProductId: prefill.state.creative
        ? prefill.state.productId
        : null,
      budgetCents: prefill.state.budgetCents,
      creative: prefill.state.creative,
      creativeVariants: prefill.state.creativeVariants,
      selectedCreativeIndex: prefill.state.selectedCreativeIndex,
      regenerationsLeft: prefill.state.regenerationsLeft,
    };
  }
  const platform = prefill?.platform ?? "meta";
  return {
    // A Google/TikTok draft already picked a platform — jump straight to the
    // product pick. A Meta draft still starts on the platform step (preselected)
    // so the connect button / readiness checks are never skipped: resuming a
    // draft is exactly when the account may still be unconnected.
    step:
      prefill?.platform && prefill.platform !== "meta" ? "product" : "platform",
    runId: crypto.randomUUID(),
    platform,
    placement: defaultPlacement(platform),
    preflight: null,
    productId: null,
    productTitle: null,
    productImageUrl: null,
    generationApprovedProductId: null,
    budgetCents: DEFAULT_BUDGET_CENTS,
    creative: null,
    creativeVariants: null,
    selectedCreativeIndex: 0,
    regenerationsLeft: 2,
  };
}

/* ---------- Header ---------- */

function StepProgress({
  current,
  onStepSelect,
}: {
  current: WizardStep;
  onStepSelect: (step: WizardStep) => void;
}) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <ol
      className="cd-cw-progress"
      aria-label={`Campaign setup, step ${idx + 1} of ${STEP_ORDER.length}`}
    >
      {STEP_ORDER.map((s, i) => (
        <li
          key={s}
          data-state={i < idx ? "done" : i === idx ? "current" : "upcoming"}
          data-clickable={i < idx ? "1" : "0"}
          aria-current={i === idx ? "step" : undefined}
        >
          <button
            type="button"
            className="cd-cw-progress-target"
            disabled={i >= idx}
            onClick={() => onStepSelect(s)}
            aria-label={
              i < idx ? `Go back to ${STEP_LABELS[s].label}` : undefined
            }
          >
            <span className="cd-cw-progress-dot">
              {i < idx ? <CDIcon name="check" size={12} /> : i + 1}
            </span>
            <span className="cd-cw-progress-copy">
              <b>{STEP_LABELS[s].label}</b>
              <small>{STEP_LABELS[s].detail}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function WizardHeader({
  step,
  canBack,
  onBack,
  onStepSelect,
  onExit,
}: {
  step: WizardStep;
  canBack: boolean;
  onBack: () => void;
  onStepSelect: (step: WizardStep) => void;
  onExit: () => void;
}) {
  const idx = STEP_ORDER.indexOf(step);
  return (
    <header className="cd-cw-header">
      <div className="cd-cw-header-top">
        <div className="flex items-center" style={{ gap: 12 }}>
          {canBack && (
            <Btn small icon="chevronLeft" onClick={onBack}>
              Back
            </Btn>
          )}
          <span className="cd-cw-kicker">
            New campaign · Step {idx + 1} of {STEP_ORDER.length}
          </span>
        </div>
        <button type="button" className="cd-link" onClick={onExit}>
          Exit setup
        </button>
      </div>
      <StepProgress current={step} onStepSelect={onStepSelect} />
    </header>
  );
}

function CampaignDraftPreview({
  state,
  continueLabel,
  continueDisabled,
  onContinue,
}: {
  state: WizardState;
  continueLabel: string;
  continueDisabled: boolean;
  onContinue: () => void;
}) {
  const platform = placementLabel(state.placement);
  const previewImageUrl = state.creative?.imageUrl ?? state.productImageUrl;
  const previewRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      const art = previewRef.current?.querySelector(".cd-cw-preview-art");
      const copy = previewRef.current?.querySelectorAll(
        ".cd-cw-preview-copy > *, .cd-cw-preview-facts > span, .cd-cw-preview-action",
      );
      if (art) {
        timeline.fromTo(
          art,
          { autoAlpha: 0.76, scale: 0.985, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            scale: 1,
            duration: 0.3,
            clearProps: "transform,opacity,visibility,willChange",
          },
        );
      }
      if (copy?.length) {
        timeline.fromTo(
          copy,
          { autoAlpha: 0, y: 4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.22,
            stagger: 0.028,
            clearProps: "transform,opacity,visibility",
          },
          "-=0.18",
        );
      }
    },
    {
      scope: previewRef,
      dependencies: [
        state.placement,
        state.step,
        state.productId,
        state.creative?.imageUrl,
        state.creative?.headline,
      ],
      revertOnUpdate: true,
    },
  );

  return (
    <aside
      ref={previewRef}
      className="cd-cw-preview"
      aria-label="Campaign draft summary"
    >
      <div className="cd-cw-preview-art" data-platform={state.platform}>
        {previewImageUrl ? (
          <img
            key={previewImageUrl}
            src={previewImageUrl}
            alt={
              state.creative
                ? `Selected ad creative for ${state.productTitle ?? "the product"}`
                : ""
            }
          />
        ) : (
          <CDIcon name="megaphone" size={28} />
        )}
        <span>
          <PlatformMark platform={platform} />
        </span>
      </div>
      <div className="cd-cw-preview-copy">
        <span className="cd-cw-kicker">Campaign draft</span>
        <strong>{state.productTitle ?? "Your next campaign"}</strong>
        <small>{platform} · Calderyn optimized</small>
      </div>
      <div className="cd-cw-preview-facts">
        <span>
          <small>Product</small>
          <b>{state.productTitle ?? "Not chosen"}</b>
        </span>
        <span>
          <small>Creative</small>
          <b>{state.creative?.headline ?? "Not ready"}</b>
        </span>
      </div>
      <p>
        <CDIcon name="shield" size={14} /> Nothing spends until you turn it on.
      </p>
      <div className="cd-cw-preview-action">
        <Btn
          kind="primary"
          disabled={continueDisabled}
          onClick={onContinue}
        >
          {continueLabel}
        </Btn>
      </div>
    </aside>
  );
}

/* ---------- Step 1: platform ---------- */

function StatusRow({ children }: { children: ReactNode }) {
  return (
    <div className="cd-cw-ready-item flex items-center">
      <CDIcon name="warn" size={15} />
      <span>{children}</span>
    </div>
  );
}

function PlatformStep({
  state,
  dispatch,
  app,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  app: DashboardCtx;
}) {
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [preflightError, setPreflightError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const platformRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Skip once a preflight read already exists — remounting this step (e.g.
    // Back from ProductStep, then Continue again) must not re-hit the Meta
    // API for a result the wizard already has. retryTick still works: on
    // error state.preflight stays null, so the guard falls through and this
    // re-runs.
    if (state.platform !== "meta" || state.preflight) return;
    let alive = true;
    setPreflightError(false);
    fetchFirstRunPreflight()
      .then((pf) => {
        if (alive) dispatch({ type: "preflight", preflight: pf });
      })
      .catch(() => {
        if (alive) setPreflightError(true);
      });
    return () => {
      alive = false;
    };
    // dispatch from useReducer is referentially stable — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.platform, state.preflight, retryTick]);

  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const { url } = await startIntegrationConnect("meta");
      window.location.href = url;
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't start the connection — try again.";
      app.toast(message, "x", "critical");
      setConnecting(false);
    }
  };

  const isMeta = state.platform === "meta";
  const loadingPreflight =
    isMeta && state.preflight === null && !preflightError;
  const hasMetaReadinessIssue = Boolean(
    state.preflight?.metaConnected &&
    (!state.preflight.adsScope || !state.preflight.pageOk),
  );
  const showMetaStatus =
    isMeta &&
    (loadingPreflight ||
      preflightError ||
      !state.preflight?.metaConnected ||
      hasMetaReadinessIssue);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      const selectedCard = platformRootRef.current?.querySelector(
        ".cd-cw-choice.cd-tile-selected",
      );
      const selectedBadge = platformRootRef.current?.querySelector(
        ".cd-cw-selected-badge",
      );
      const status = platformRootRef.current?.querySelector(
        ".cd-cw-platform-status",
      );
      const details = platformRootRef.current?.querySelectorAll(
        ".cd-cw-ready-item, .cd-cw-connect-details",
      );
      if (selectedCard) {
        timeline.fromTo(
          selectedCard,
          { scale: 0.975, y: 2, willChange: "transform" },
          {
            scale: 1,
            y: 0,
            duration: 0.28,
            clearProps: "transform,willChange",
          },
        );
      }
      if (selectedBadge) {
        timeline.fromTo(
          selectedBadge,
          { autoAlpha: 0, scale: 0.72 },
          {
            autoAlpha: 1,
            scale: 1,
            duration: 0.3,
            ease: "back.out(1.6)",
            clearProps: "transform,opacity,visibility",
          },
          "<",
        );
      }
      if (status) {
        timeline.fromTo(
          status,
          { autoAlpha: 0, y: 6, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.28,
            clearProps: "transform,opacity,visibility,willChange",
          },
          "-=0.14",
        );
      }
      if (details?.length) {
        timeline.fromTo(
          details,
          { autoAlpha: 0, y: 4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.24,
            stagger: 0.045,
            clearProps: "transform,opacity,visibility",
          },
          "-=0.16",
        );
      }
    },
    {
      scope: platformRootRef,
      dependencies: [
        state.placement,
        Boolean(state.preflight),
        preflightError,
        expanded,
      ],
      revertOnUpdate: true,
    },
  );

  return (
    <div
      ref={platformRootRef}
      className="cd-cw-step-content flex flex-col"
      style={{ gap: 20 }}
    >
      <div>
        <h2 className="cd-h2">Choose a placement</h2>
      </div>

      <div className="cd-cw-platform-grid">
        {CAMPAIGN_PLACEMENTS.map((option) => (
          <Card
            key={option.id}
            hover
            onClick={() =>
              dispatch({
                type: "placement",
                placement: option.id,
                platform: option.platform,
              })
            }
            className={`cd-cw-choice ${state.placement === option.id ? "cd-tile-selected" : ""}`}
          >
            <div
              className="flex items-center justify-between"
              style={{ marginBottom: 8 }}
            >
              <PlatformMark platform={option.label} />
              {state.placement === option.id ? (
                <span
                  className="cd-badge cd-cw-selected-badge"
                  style={BADGE_GOOD}
                >
                  <CDIcon name="check" size={12} /> Selected
                </span>
              ) : option.platform !== "meta" ? (
                <span className="cd-badge">Draft only</span>
              ) : null}
            </div>
            <div className="cd-h3">{option.label}</div>
            <small className="cd-cw-choice-detail">{option.detail}</small>
          </Card>
        ))}
      </div>

      {showMetaStatus && (
        <div className="cd-cw-platform-foot">
          <div className="cd-cw-platform-status-slot">
            <Card className="cd-cw-platform-status">
              {loadingPreflight ? (
                <p className="cd-caption">Checking your Meta connection…</p>
              ) : preflightError ? (
                <div
                  className="flex items-center justify-between"
                  style={{ flexWrap: "wrap", gap: 10 }}
                >
                  <span className="cd-caption" style={{ color: "var(--red)" }}>
                    Couldn't check your Meta connection — try again.
                  </span>
                  <Btn small onClick={() => setRetryTick((t) => t + 1)}>
                    Try again
                  </Btn>
                </div>
              ) : state.preflight && !state.preflight.metaConnected ? (
                <div className="flex flex-col" style={{ gap: 12 }}>
                  <p className="cd-caption">
                    Connect a Meta ad account to run this campaign.
                  </p>
                  <div
                    className="flex items-center"
                    style={{ gap: 10, flexWrap: "wrap" }}
                  >
                    <Btn kind="primary" disabled={connecting} onClick={connect}>
                      {connecting ? "Connecting…" : "I have a Meta ad account"}
                    </Btn>
                    <Btn onClick={() => setExpanded((v) => !v)}>
                      I don't have one yet
                    </Btn>
                  </div>
                  {expanded && (
                    <div
                      className="cd-cw-connect-details flex flex-col"
                      style={{ gap: 8, fontSize: 13.5 }}
                    >
                      <ol
                        style={{
                          paddingLeft: 18,
                          margin: 0,
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        <li>
                          Create a business portfolio at{" "}
                          <a
                            href="https://business.facebook.com"
                            target="_blank"
                            rel="noreferrer"
                          >
                            business.facebook.com
                          </a>
                          .
                        </li>
                        <li>Create an ad account and add a billing method.</li>
                        <li>Come back here and connect it.</li>
                      </ol>
                      <div>
                        <Btn
                          kind="primary"
                          disabled={connecting}
                          onClick={connect}
                        >
                          {connecting ? "Connecting…" : "Connect Meta"}
                        </Btn>
                      </div>
                    </div>
                  )}
                </div>
              ) : state.preflight && hasMetaReadinessIssue ? (
                <div className="cd-cw-readiness">
                  {!state.preflight.adsScope && (
                    <StatusRow>
                      Missing ad permissions — reconnect to grant access
                    </StatusRow>
                  )}
                  {!state.preflight.pageOk && (
                    <StatusRow>No Facebook Page connected yet</StatusRow>
                  )}
                </div>
              ) : null}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Step 2: product ---------- */

function ProductStep({
  state,
  dispatch,
  app,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  app: DashboardCtx;
}) {
  const [search, setSearch] = useState("");
  // Debounce the search box so each keystroke doesn't fire a request — same
  // pattern as Catalog.tsx / Collections.tsx.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [products, setProducts] = useState<ProductSummaryVM[] | null>(null);
  const productGridRef = useRef<HTMLDivElement>(null);
  const productRootRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    fetchProducts({ status: "active", search: query || undefined })
      .then((res) => {
        if (alive) setProducts(res.products);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  useGSAP(
    () => {
      if (
        !products?.length ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const cards = productGridRef.current?.querySelectorAll(
        ".cd-cw-product-choice",
      );
      if (!cards?.length) return;
      gsap.fromTo(
        cards,
        { autoAlpha: 0, y: 8, scale: 0.985, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.32,
          stagger: 0.045,
          ease: "power2.out",
          clearProps: "transform,opacity,visibility,willChange",
        },
      );
    },
    {
      scope: productGridRef,
      dependencies: [products?.length, query],
      revertOnUpdate: true,
    },
  );

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      const selectedCard = productRootRef.current?.querySelector(
        ".cd-cw-product-choice.cd-tile-selected",
      );
      const selectedCheck = productRootRef.current?.querySelector(
        ".cd-cw-product-choice.cd-tile-selected .cd-cw-product-image > span",
      );
      if (selectedCard) {
        timeline.fromTo(
          selectedCard,
          { scale: 0.975, y: 2, willChange: "transform" },
          {
            scale: 1,
            y: 0,
            duration: 0.28,
            clearProps: "transform,willChange",
          },
        );
      }
      if (selectedCheck) {
        timeline.fromTo(
          selectedCheck,
          { autoAlpha: 0, scale: 0.55, rotation: -12 },
          {
            autoAlpha: 1,
            scale: 1,
            rotation: 0,
            duration: 0.34,
            ease: "back.out(1.8)",
            clearProps: "transform,opacity,visibility",
          },
          "<",
        );
      }
    },
    {
      scope: productRootRef,
      dependencies: [state.productId],
      revertOnUpdate: true,
    },
  );

  return (
    <div
      ref={productRootRef}
      className="cd-cw-step-content cd-cw-product-step flex flex-col"
      style={{ gap: 14 }}
    >
      <h2 className="cd-h2">Which product?</h2>

      <div className="cd-cw-product-search">
        <ClearableSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search products"
          ariaLabel="Search products"
        />
      </div>

      {products === null && !loadError ? (
        <p className="cd-caption">Loading products…</p>
      ) : loadError ? (
        <p className="cd-caption" style={{ color: "var(--red)" }}>
          Couldn't load your products — try again.
        </p>
      ) : products && products.length === 0 && !query ? (
        <Placeholder
          icon="box"
          title="No products yet"
          sub="Add your first product and come back."
          actionLabel="Go to products"
          onAction={() => app.navigate("catalog")}
        />
      ) : products && products.length === 0 ? (
        <p className="cd-caption">No active products found.</p>
      ) : (
        <div ref={productGridRef} className="cd-cw-product-grid">
          {(products ?? []).map((p) => (
            <Card
              key={p.id}
              hover
              onClick={() =>
                dispatch({
                  type: "product",
                  id: p.id,
                  title: p.title,
                  imageUrl: p.imageUrl,
                })
              }
              className={`cd-cw-choice cd-cw-product-choice ${state.productId === p.id ? "cd-tile-selected" : ""}`}
            >
              <div className="cd-cw-product-image">
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt="" />
                ) : (
                  <CDIcon name="box" size={22} />
                )}
                {state.productId === p.id && (
                  <span>
                    <CDIcon name="check" size={14} />
                  </span>
                )}
              </div>
              <div className="cd-row-title truncate" style={{ fontSize: 13.5 }}>
                {p.title}
              </div>
              <div className="cd-caption tabular-nums">
                {p.priceCents != null ? money(p.priceCents) : "—"}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Step 3: creative ---------- */

function CreativeGenerationConfirmationDialog({
  productTitle,
  onConfirm,
  onCancel,
}: {
  productTitle: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmationRef = useRef<HTMLDivElement>(null);

  const { contextSafe } = useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        confirmationRef.current
          ?.querySelector<HTMLElement>("[data-generation-confirm] .cd-btn")
          ?.focus({ preventScroll: true });
        return;
      }
      const dialog = confirmationRef.current?.querySelector(
        ".cd-cw-generation-dialog",
      );
      const details = confirmationRef.current?.querySelectorAll(
        ".cd-cw-generation-consent-copy > *, .cd-cw-generation-consent-action",
      );
      const mark = confirmationRef.current?.querySelector(
        ".cd-cw-generation-consent-mark",
      );
      const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
      timeline.fromTo(
        confirmationRef.current,
        { autoAlpha: 0 },
        {
          autoAlpha: 1,
          duration: 0.22,
          clearProps: "opacity,visibility",
        },
      );
      if (dialog) {
        timeline.fromTo(
          dialog,
          { autoAlpha: 0, y: 12, scale: 0.97, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.36,
            ease: "back.out(1.35)",
            clearProps: "transform,opacity,visibility,willChange",
          },
          "<0.02",
        );
      }
      if (mark) {
        timeline.fromTo(
          mark,
          { scale: 0.82, rotation: -8 },
          { scale: 1, rotation: 0, duration: 0.34 },
          "<0.04",
        );
      }
      if (details?.length) {
        timeline.fromTo(
          details,
          { autoAlpha: 0, y: 4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.25,
            stagger: 0.045,
            clearProps: "transform,opacity,visibility",
          },
          "<0.04",
        );
      }
      confirmationRef.current
        ?.querySelector<HTMLElement>("[data-generation-confirm] .cd-btn")
        ?.focus({ preventScroll: true });
    },
    { scope: confirmationRef },
  );

  const closeWith = contextSafe((callback: () => void) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      callback();
      return;
    }
    const dialog = confirmationRef.current?.querySelector(
      ".cd-cw-generation-dialog",
    );
    const timeline = gsap.timeline({ onComplete: callback });
    if (dialog) {
      timeline.to(dialog, {
        autoAlpha: 0,
        y: 7,
        scale: 0.985,
        duration: 0.16,
        ease: "power2.in",
      });
    }
    timeline.to(
      confirmationRef.current,
      { autoAlpha: 0, duration: 0.14, ease: "power1.in" },
      "-=0.08",
    );
  });

  return (
    <div
      ref={confirmationRef}
      className="cd-cw-generation-confirmation"
      onKeyDown={(event) => {
        if (event.key === "Escape") closeWith(onCancel);
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeWith(onCancel);
      }}
    >
      <div
        className="cd-card cd-cw-generation-consent cd-cw-generation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="creative-generation-dialog-title"
        aria-describedby="creative-generation-dialog-detail"
      >
        <span className="cd-cw-generation-consent-mark" aria-hidden="true">
          <CalderynHexMark
            size={18}
            fill="var(--accent)"
            stroke="var(--on-accent)"
          />
        </span>
        <div className="cd-cw-generation-consent-copy">
          <b id="creative-generation-dialog-title">
            Use 3 credits to generate?
          </b>
          <small id="creative-generation-dialog-detail">
            Calderyn will create three product-specific ad images.
          </small>
          {productTitle && <span>Based on {productTitle}</span>}
        </div>
        <div className="cd-cw-generation-consent-action">
          <Btn onClick={() => closeWith(onCancel)}>Not yet</Btn>
          <span data-generation-confirm>
            <Btn
              kind="primary"
              icon="sparkle"
              onClick={() => closeWith(onConfirm)}
            >
              Yes, generate
            </Btn>
          </span>
        </div>
      </div>
    </div>
  );
}

function CreativeGenerationStage({
  productImageUrl,
  compact = false,
}: {
  productImageUrl: string | null;
  compact?: boolean;
}) {
  const generationRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const cards = generationRef.current?.querySelectorAll(
        ".cd-cw-generation-card-inner",
      );
      const scans = generationRef.current?.querySelectorAll(
        ".cd-cw-generation-scan",
      );
      const copy = generationRef.current?.querySelectorAll(
        ".cd-cw-generation-copy > *",
      );
      const pulse = generationRef.current?.querySelector(
        ".cd-cw-generation-pulse",
      );
      if (!cards?.length) return;

      const entrance = gsap.timeline({ defaults: { ease: "power3.out" } });
      entrance
        .fromTo(
          generationRef.current,
          { autoAlpha: 0, scale: 0.992 },
          {
            autoAlpha: 1,
            scale: 1,
            duration: 0.32,
            clearProps: "transform,opacity,visibility",
          },
        )
        .fromTo(
          cards,
          {
            autoAlpha: 0,
            y: 12,
            rotationX: -8,
            transformPerspective: 800,
          },
          {
            autoAlpha: 1,
            y: 0,
            rotationX: 0,
            duration: 0.46,
            stagger: 0.075,
          },
          "<0.04",
        );

      if (copy?.length) {
        entrance.fromTo(
          copy,
          { autoAlpha: 0, y: 4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.26,
            stagger: 0.055,
            clearProps: "transform,opacity,visibility",
          },
          "<0.1",
        );
      }

      const float = gsap.timeline({
        paused: true,
        repeat: -1,
        yoyo: true,
        defaults: { duration: 1.65, ease: "sine.inOut" },
      });
      float.to(cards, {
        y: (index) => (index === 1 ? -4 : -2),
        rotationY: (index) => (index - 1) * 1.6,
        stagger: 0.12,
      });
      entrance.call(() => float.play(), undefined, ">-0.02");

      if (scans?.length) {
        gsap.fromTo(
          scans,
          { autoAlpha: 0, yPercent: -180 },
          {
            autoAlpha: 0.72,
            yPercent: 760,
            duration: 1.45,
            stagger: 0.18,
            repeat: -1,
            repeatDelay: 0.42,
            ease: "power1.inOut",
          },
        );
      }

      if (pulse) {
        gsap.to(pulse, {
          autoAlpha: 0.72,
          scale: 1.12,
          duration: 1.05,
          repeat: -1,
          yoyo: true,
          ease: "sine.inOut",
        });
      }
    },
    { scope: generationRef },
  );

  return (
    <div
      ref={generationRef}
      className={`cd-cw-generation-stage${compact ? " is-compact" : " cd-card cd-pad"}`}
      role="status"
      aria-live="polite"
    >
      <div className="cd-cw-generation-copy">
        <span className="cd-cw-generation-pulse" aria-hidden="true">
          <CalderynHexMark
            size={16}
            fill="var(--accent)"
            stroke="var(--on-accent)"
          />
        </span>
        <div>
          <b>{compact ? "Finding fresh directions" : "Creating three directions"}</b>
          <small>Visuals · Copy · Scoring</small>
        </div>
      </div>

      <div className="cd-cw-generation-deck" aria-hidden="true">
        {[0, 1, 2].map((option) => (
          <span
            key={option}
            className="cd-cw-generation-card"
            data-option={option + 1}
          >
            <span className="cd-cw-generation-card-inner">
              <span className="cd-cw-generation-art">
                {productImageUrl ? <img src={productImageUrl} alt="" /> : null}
                <span className="cd-cw-generation-scan" />
              </span>
              <span className="cd-cw-generation-lines">
                <i />
                <i />
              </span>
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CreativeStep({
  state,
  dispatch,
  regenerating,
  setRegenerating,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  regenerating: boolean;
  setRegenerating: (value: boolean) => void;
}) {
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  // This is an interaction counter, not persisted allowance state. Starting it
  // above zero on a remount would turn ordinary Back navigation into an
  // unintended regeneration request.
  const [generationTick, setGenerationTick] = useState(0);
  const [regenerationError, setRegenerationError] = useState<string | null>(
    null,
  );
  const creativeRootRef = useRef<HTMLDivElement>(null);
  const productId = state.productId;
  const productTitle = state.productTitle;
  const variants = state.creativeVariants;
  const selectedIdx = state.selectedCreativeIndex;
  const generationApproved =
    state.generationApprovedProductId === productId && productId !== null;

  useEffect(() => {
    const isRegeneration = generationTick > 0;
    // Returning to this step keeps the previously generated set. A deliberate
    // regeneration is the only path that re-bills the generator.
    if (
      !productId ||
      (!isRegeneration &&
        (!generationApproved || (state.creative && variants?.length)))
    )
      return;
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setLoadError(false);
    setRegenerationError(null);
    if (isRegeneration) setRegenerating(true);
    const attempt = isRegeneration ? 4 - state.regenerationsLeft : 1;
    generateFirstRunCreatives(productId, state.runId, attempt)
      .then((res) => {
        if (!alive) return;
        const displayVariants =
          res.available && res.variants.length > 0
            ? res.variants
            : !isRegeneration
              ? buildFirstRunPlaceholderVariants({
                  fallback: res.fallback,
                  imageUrl: res.imageUrl ?? state.productImageUrl,
                })
              : [];
        if (displayVariants.length > 0) {
          const first = displayVariants[0];
          dispatch({
            type: "creativeOptions",
            variants: displayVariants,
            regenerationsLeft: res.regenerationsLeft,
            creative: {
              headline: first.headline,
              primaryText: first.primaryText,
              cta: first.cta,
              imageUrl: first.imageUrl ?? res.imageUrl,
              destinationUrl: res.destinationUrl,
              audience: "Broad, your country",
            },
          });
        } else if (isRegeneration) {
          dispatch({ type: "regenerationsLeft", value: res.regenerationsLeft });
          setRegenerationError(
            "Couldn't create a fresh set right now. Your current options are unchanged.",
          );
        } else {
          dispatch({ type: "regenerationsLeft", value: res.regenerationsLeft });
          setLoadError(true);
        }
      })
      .catch((error: unknown) => {
        // No destinationUrl to fall back to (server-only resolution) — leave
        // state.creative null and show a real retry rather than silently
        // continuing with an ad that has no landing page.
        if (!alive) return;
        if (
          error instanceof DashboardApiError &&
          error.code === "creative_generation_in_progress"
        ) {
          retryTimer = setTimeout(() => {
            if (alive) setRetryTick((tick) => tick + 1);
          }, 1200);
          return;
        }
        if (isRegeneration) {
          if (
            error instanceof DashboardApiError &&
            error.code === "creative_regeneration_limit"
          ) {
            dispatch({ type: "regenerationsLeft", value: 0 });
          }
          setRegenerationError(
            error instanceof DashboardApiError
              ? error.message
              : "Couldn't create a fresh set right now. Your current options are unchanged.",
          );
        } else {
          setLoadError(true);
        }
      })
      .finally(() => {
        if (alive) setRegenerating(false);
      });
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, generationApproved, generationTick, retryTick]);

  const loading = state.creative === null && !loadError;
  const creative = state.creative;

  const selectVariant = (i: number) => {
    if (!variants || !creative) return;
    const v = variants[i];
    dispatch({
      type: "creativeSelection",
      index: i,
      creative: {
        ...creative,
        headline: v.headline,
        primaryText: v.primaryText,
        cta: v.cta,
        imageUrl: v.imageUrl ?? creative.imageUrl,
      },
    });
  };

  const regenerate = () => {
    if (regenerating || state.regenerationsLeft <= 0) return;
    setRegenerationError(null);
    setRegenerating(true);
    setGenerationTick((tick) => tick + 1);
  };

  useGSAP(
    () => {
      if (
        !creative ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const cards = creativeRootRef.current?.querySelectorAll(
        ".cd-cw-concept-card",
      );
      if (!cards?.length) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      timeline.fromTo(
        cards,
        { autoAlpha: 0, y: 10, scale: 0.985, willChange: "transform,opacity" },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.36,
          stagger: 0.065,
          clearProps: "transform,opacity,visibility,willChange",
        },
      );
    },
    {
      scope: creativeRootRef,
      dependencies: [
        Boolean(creative),
        variants
          ?.map((variant) => `${variant.headline}:${variant.imageUrl ?? ""}`)
          .join("|"),
      ],
      revertOnUpdate: true,
    },
  );

  return (
    <div
      ref={creativeRootRef}
      className="cd-cw-step-content flex flex-col"
      style={{ gap: 16 }}
    >
      <div className="cd-cw-creative-title-row">
        <div>
          <h2 className="cd-h2">Choose your strongest direction</h2>
        </div>
        {creative && Boolean(variants?.length) && (
          <div className="cd-cw-regenerate-control">
            <Btn
              small
              icon="rotate"
              disabled={regenerating || state.regenerationsLeft <= 0}
              onClick={regenerate}
            >
              {regenerating
                ? "Generating…"
                : `Regenerate · ${state.regenerationsLeft} left`}
            </Btn>
          </div>
        )}
      </div>

      {loading ? (
        <CreativeGenerationStage productImageUrl={state.productImageUrl} />
      ) : loadError ? (
        <Card>
          <div
            className="flex items-center justify-between"
            style={{ flexWrap: "wrap", gap: 10 }}
          >
            <span className="cd-caption">
              Images weren't generated. Try again before continuing.
            </span>
            <Btn small onClick={() => setRetryTick((t) => t + 1)}>
              Try again
            </Btn>
          </div>
        </Card>
      ) : (
        <>
          {variants && variants.length > 0 && (
            <div
              className="cd-cw-concept-grid"
              data-regenerating={regenerating ? "1" : "0"}
              role="radiogroup"
              aria-label="Creative direction"
            >
              {variants.map((variant, i) => {
                const selected = i === selectedIdx;
                return (
                  <button
                    key={`${generationTick}:${i}:${variant.imageUrl ?? "no-image"}:${variant.headline}:${variant.cta}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="cd-cw-concept-card"
                    data-selected={selected ? "1" : "0"}
                    data-option={i + 1}
                    data-placeholder={variant.imageGenerated ? "0" : "1"}
                    onClick={() => selectVariant(i)}
                  >
                    <span className="cd-cw-concept-art">
                      {variant.imageUrl ? (
                        <img
                          src={variant.imageUrl}
                          alt={`Generated ad direction ${i + 1} for ${productTitle ?? "your product"}`}
                        />
                      ) : creative?.imageUrl ? (
                        <img src={creative.imageUrl} alt="" />
                      ) : (
                        <CDIcon name="image" size={28} />
                      )}
                      <span className="cd-cw-concept-shade" />
                      <span className="cd-cw-concept-label">
                        {variant.imageGenerated ? "AI generated" : "Placeholder"}
                        {i === 0 && variant.score != null && <b>Top pick</b>}
                      </span>
                      <span
                        className="cd-cw-concept-score"
                        data-selected={selected ? "1" : "0"}
                      >
                        <b>
                          {variant.imageGenerated
                            ? variant.score == null
                              ? "New"
                              : Math.round(variant.score)
                            : "Source"}
                        </b>
                        <small>
                          {variant.imageGenerated
                            ? variant.score == null
                              ? "visual"
                              : "score"
                            : "image"}
                        </small>
                        {selected && <CDIcon name="check" size={11} />}
                      </span>
                      <strong>{variant.headline}</strong>
                    </span>
                    <span className="cd-cw-concept-body">
                      <span>{variant.primaryText}</span>
                      <span className="cd-cw-concept-meta">
                        <b>{variant.cta.replace(/_/g, " ")}</b>
                        <small>
                          <CDIcon name="sparkle" size={11} />{" "}
                          {variant.rationale}
                        </small>
                      </span>
                    </span>
                  </button>
                );
              })}
              {regenerating && (
                <div className="cd-cw-regenerating">
                  <CreativeGenerationStage
                    productImageUrl={state.productImageUrl}
                    compact
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {regenerationError && (
        <p className="cd-caption cd-cw-generation-error">{regenerationError}</p>
      )}
    </div>
  );
}

/* ---------- Step 4: review ---------- */

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="cd-cw-summary-row">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function destinationHost(url: string | undefined): string {
  if (!url) return "yourstore.com";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "yourstore.com";
  }
}

function LiveAdPreview({
  state,
  storeLabel,
  device,
  previewPlacement,
  previewDirection,
  revision,
}: {
  state: WizardState;
  storeLabel: string;
  device: "mobile" | "desktop";
  previewPlacement: CampaignPlacement;
  previewDirection: -1 | 1;
  revision: number;
}) {
  const creative = state.creative;
  const imageUrl = creative?.imageUrl || state.productImageUrl;
  const cta = (creative?.cta ?? "SHOP_NOW").replace(/_/g, " ");
  const livePreviewRef = useRef<HTMLDivElement>(null);
  const productAlt = `Advertisement for ${state.productTitle ?? "selected product"}`;
  const media = imageUrl ? (
    <img src={imageUrl} alt={productAlt} />
  ) : (
    <CDIcon name="image" size={30} />
  );

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const ad = livePreviewRef.current?.querySelector(".cd-cw-live-ad");
      if (!ad) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      timeline.fromTo(
        ad,
        {
          autoAlpha: 0.68,
          x: previewDirection * 12,
          scale: 0.994,
          willChange: "transform,opacity",
        },
        {
          autoAlpha: 1,
          x: 0,
          scale: 1,
          duration: 0.32,
          clearProps: "transform,opacity,visibility,willChange",
        },
      );
      timeline.fromTo(
        ".cd-cw-live-media img, [data-preview-copy]",
        { autoAlpha: 0.72, y: 3 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.24,
          stagger: 0.035,
          clearProps: "transform,opacity,visibility",
        },
        "-=0.18",
      );
    },
    {
      scope: livePreviewRef,
      dependencies: [device, previewPlacement, previewDirection, revision],
      revertOnUpdate: true,
    },
  );

  let ad: ReactNode;

  if (previewPlacement === "instagram") {
    ad = (
      <article
        className="cd-cw-live-ad cd-cw-live-instagram"
        aria-label={`Preview of the ${storeLabel} Instagram ad`}
      >
        <header className="cd-cw-live-identity">
          <span className="cd-cw-live-avatar">
            {storeLabel.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <b>{storeLabel}</b>
            <small>Sponsored</small>
          </span>
          <span className="cd-cw-live-more" aria-hidden="true">
            •••
          </span>
        </header>
        <div className="cd-cw-live-media">{media}</div>
        <div className="cd-cw-ig-actions" aria-hidden="true">
          <span>
            <CDIcon name="heart" size={22} strokeWidth={1.9} />
          </span>
          <span>
            <CDIcon name="comment" size={22} strokeWidth={1.9} />
          </span>
          <span>
            <CDIcon name="send" size={22} strokeWidth={1.9} />
          </span>
          <span>
            <CDIcon name="bookmark" size={22} strokeWidth={1.9} />
          </span>
        </div>
        <div className="cd-cw-ig-cta">
          <span>{cta}</span>
          <b>›</b>
        </div>
        <p className="cd-cw-ig-caption" data-preview-copy>
          <b>{storeLabel}</b> {creative?.primaryText}
        </p>
        <small className="cd-cw-ig-headline" data-preview-copy>
          {creative?.headline}
        </small>
      </article>
    );
  } else if (previewPlacement === "google") {
    ad = (
      <article
        className="cd-cw-live-ad cd-cw-live-google"
        aria-label={`Preview of the ${storeLabel} Google display ad`}
      >
        <div className="cd-cw-live-media">{media}</div>
        <div className="cd-cw-google-copy">
          <span className="cd-cw-google-domain">
            <b>Ad</b> · {destinationHost(creative?.destinationUrl)}
          </span>
          <strong data-preview-copy>{creative?.headline}</strong>
          <p data-preview-copy>{creative?.primaryText}</p>
          <span className="cd-cw-google-foot">
            <b>{storeLabel}</b>
            <span>{cta}</span>
          </span>
        </div>
      </article>
    );
  } else if (previewPlacement === "tiktok") {
    ad = (
      <article
        className="cd-cw-live-ad cd-cw-live-tiktok"
        aria-label={`Preview of the ${storeLabel} TikTok ad`}
      >
        <div className="cd-cw-live-media">{media}</div>
        <div className="cd-cw-tiktok-copy" data-preview-copy>
          <b>@{storeLabel.toLowerCase().replace(/[^a-z0-9._]/g, "")}</b>
          <p>{creative?.primaryText}</p>
          <small>Sponsored · {creative?.headline}</small>
        </div>
        <span className="cd-cw-tiktok-cta">{cta}</span>
        <div className="cd-cw-tiktok-actions" aria-hidden="true">
          <span>♥</span>
          <span>●</span>
          <span>↗</span>
        </div>
      </article>
    );
  } else {
    ad = (
      <article
        className="cd-cw-live-ad cd-cw-live-facebook"
        aria-label={`Preview of the ${storeLabel} Facebook ad`}
      >
        <header className="cd-cw-live-identity">
          <span className="cd-cw-live-avatar">
            {storeLabel.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <b>{storeLabel}</b>
            <small>Sponsored · 🌐</small>
          </span>
          <span className="cd-cw-live-more" aria-hidden="true">
            •••
          </span>
        </header>
        <p className="cd-cw-live-copy" data-preview-copy>
          {creative?.primaryText}
        </p>
        <div className="cd-cw-live-media">{media}</div>
        <div className="cd-cw-live-link">
          <span>
            <small>
              {destinationHost(creative?.destinationUrl).toUpperCase()}
            </small>
            <strong data-preview-copy>{creative?.headline}</strong>
            <span>{state.productTitle}</span>
          </span>
          <span className="cd-cw-live-cta">{cta}</span>
        </div>
        <div className="cd-cw-live-social">
          <span>Be the first to react</span>
          <span>0 comments</span>
        </div>
        <div className="cd-cw-live-actions" aria-hidden="true">
          <span>Like</span>
          <span>Comment</span>
          <span>Share</span>
        </div>
      </article>
    );
  }

  return (
    <div
      ref={livePreviewRef}
      className="cd-cw-live-stage"
      data-placement={device}
      data-network={previewPlacement}
    >
      {ad}
    </div>
  );
}

function ReviewStep({
  state,
  dispatch,
  app,
  prefill,
  onExit,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  app: DashboardCtx;
  prefill: WizardPrefill;
  onExit: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** Error code of the last failed create (drives code-specific affordances
   *  like the run_needs_review "Start over" link). */
  const [createErrorCode, setCreateErrorCode] = useState<string | null>(null);
  const [created, setCreated] = useState<{ campaignDimId: string } | null>(
    null,
  );
  const [turningOn, setTurningOn] = useState(false);
  /** True once resume_campaign succeeded — makes the Turn on button single-use. */
  const [turnedOn, setTurnedOn] = useState(false);
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const [previewPlacement, setPreviewPlacement] =
    useState<CampaignPlacement>(state.placement);
  const [previewDirection, setPreviewDirection] = useState<-1 | 1>(1);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [reviewPreflightPending, setReviewPreflightPending] = useState(
    state.platform === "meta",
  );
  const [reviewPreflightError, setReviewPreflightError] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const reviewRootRef = useRef<HTMLDivElement>(null);

  const selectPreviewPlacement = (nextPlacement: CampaignPlacement) => {
    if (nextPlacement === previewPlacement) return;
    const currentIndex = REVIEW_PREVIEW_PLACEMENTS.indexOf(previewPlacement);
    const nextIndex = REVIEW_PREVIEW_PLACEMENTS.indexOf(nextPlacement);
    setPreviewDirection(nextIndex >= currentIndex ? 1 : -1);
    setPreviewPlacement(nextPlacement);
    if (isMobileOnlyPreview(nextPlacement)) setDevice("mobile");
  };

  useEffect(() => {
    if (state.platform !== "meta") {
      setReviewPreflightPending(false);
      return;
    }
    let alive = true;
    setReviewPreflightPending(true);
    setReviewPreflightError(false);
    fetchFirstRunPreflight()
      .then((preflight) => {
        if (alive) dispatch({ type: "preflight", preflight });
      })
      .catch(() => {
        if (alive) setReviewPreflightError(true);
      })
      .finally(() => {
        if (alive) setReviewPreflightPending(false);
      });
    return () => {
      alive = false;
    };
  }, [dispatch, state.platform]);

  // Never launch from a stale platform check. Connection, write scope, and a
  // promotable page must all be present; billing remains Meta's own launch-time
  // validation because its API does not always expose that field.
  const metaReady =
    state.platform === "meta" &&
    state.preflight?.metaConnected === true &&
    state.preflight.adsScope &&
    state.preflight.pageOk &&
    !reviewPreflightPending &&
    !reviewPreflightError;

  const editCreative = (
    patch: Partial<CreativeFields>,
    animatePreview = false,
  ) => {
    if (!state.creative) return;
    dispatch({ type: "creative", creative: { ...state.creative, ...patch } });
    if (animatePreview) setPreviewRevision((revision) => revision + 1);
  };

  const replaceCreativeImage = async (file: File | null | undefined) => {
    if (!file || uploadingImage) return;
    setUploadingImage(true);
    try {
      const uploaded = await uploadCampaignCreativeImage(file);
      editCreative({ imageUrl: uploaded.url }, true);
    } catch (error) {
      const message =
        error instanceof DashboardApiError
          ? error.message
          : "Couldn't upload that image — try again.";
      app.toast(message, "x", "critical");
    } finally {
      setUploadingImage(false);
    }
  };

  const destinationIsValid = (() => {
    try {
      const url = new URL(state.creative?.destinationUrl ?? "");
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  })();

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const timeline = gsap.timeline({ defaults: { ease: "power2.out" } });
      const changed = reviewRootRef.current?.querySelectorAll(
        ".cd-cw-created-state, .cd-cw-launch-message",
      );
      if (changed?.length) {
        timeline.fromTo(
          changed,
          { autoAlpha: 0, y: 5, scale: 0.99, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: 0.28,
            clearProps: "transform,opacity,visibility,willChange",
          },
        );
      }
      if (creating || turningOn) {
        const activeButton = reviewRootRef.current?.querySelector(
          ".cd-cw-launch-buttons .cd-btn:last-child, .cd-cw-created-state .cd-btn",
        );
        if (activeButton) {
          timeline.fromTo(
            activeButton,
            { scale: 0.975 },
            {
              scale: 1,
              duration: 0.24,
              ease: "back.out(1.5)",
              clearProps: "transform",
            },
            "<",
          );
        }
      }
    },
    {
      scope: reviewRootRef,
      dependencies: [
        Boolean(created),
        turnedOn,
        Boolean(createError),
        creating,
        turningOn,
      ],
      revertOnUpdate: true,
    },
  );

  const createOnMeta = async () => {
    if (
      creating ||
      created ||
      !metaReady ||
      !destinationIsValid ||
      uploadingImage ||
      !state.creative ||
      !state.creative.imageUrl ||
      !state.productId
    )
      return;
    setCreating(true);
    setCreateError(null);
    setCreateErrorCode(null);
    try {
      const result = await createFirstCampaignRun({
        runId: state.runId,
        productId: state.productId,
        budgetCents: state.budgetCents,
        placement:
          state.placement === "facebook" || state.placement === "instagram"
            ? state.placement
            : undefined,
        creative: {
          headline: state.creative.headline,
          primaryText: state.creative.primaryText,
          cta: state.creative.cta,
          imageUrl: state.creative.imageUrl,
          destinationUrl: state.creative.destinationUrl,
        },
      });
      setCreated({ campaignDimId: result.campaignDimId });
      // Pull fresh data now: in the embedded (Campaigns empty-state) instance
      // navigate("campaigns") is a no-op, so without this the new campaign
      // wouldn't appear until the next background poll.
      app.refresh();
    } catch (err) {
      if (
        err instanceof DashboardApiError &&
        err.code === "run_input_mismatch"
      ) {
        // The runId was used before with different details (the merchant went
        // back and edited something after a failed attempt). Safe to start a
        // fresh run — the server only reopens runs that created nothing on
        // Meta, and it refuses this one rather than redirecting it.
        dispatch({ type: "newRunId" });
        setCreateError(
          "Your campaign details changed since the last attempt — click Create on Meta to start fresh.",
        );
      } else {
        // Honest server message — the SAME runId is reused on the next click
        // (state.runId is stable), so a retry resumes this run instead of
        // creating a second campaign on Meta. run_needs_review keeps the dead
        // runId but additionally renders a "Start over" link (below) that
        // mints a fresh one, so the merchant isn't stranded.
        const message =
          err instanceof DashboardApiError
            ? err.message
            : "Couldn't create the campaign — try again.";
        setCreateError(message);
        setCreateErrorCode(err instanceof DashboardApiError ? err.code : null);
      }
    } finally {
      setCreating(false);
    }
  };

  const turnOn = async () => {
    // Single-use: once the resume succeeded, a second click must never fire
    // another resume (in the embedded instance the card stays mounted, since
    // navigate("campaigns") is a no-op there).
    if (!created || turningOn || turnedOn) return;
    setTurningOn(true);
    try {
      await executeCampaignAction(created.campaignDimId, {
        type: "resume_campaign",
      });
      setTurnedOn(true);
      app.toast("Campaign is live.", "check", "success");
      app.refresh();
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't turn it on — try from Campaigns.";
      app.toast(message, "x", "critical");
    } finally {
      setTurningOn(false);
      app.navigate("campaigns");
    }
  };

  const saveDraft = async () => {
    if (saving) return;
    setSaving(true);
    // Prefer the live selection over the name the draft was originally saved
    // under — the merchant may have picked a different product since.
    const rawName =
      state.productTitle || prefill?.name?.trim() || "New campaign";
    const name = rawName.slice(0, MAX_CAMPAIGN_DRAFT_NAME_LENGTH);
    if (!state.productId || !state.productTitle || !state.creative) {
      app.toast(
        "Choose a product and creative before saving.",
        "x",
        "critical",
      );
      setSaving(false);
      return;
    }
    const draftState: CampaignDraftState = {
      version: 1,
      runId: state.runId,
      placement: state.placement,
      productId: state.productId,
      productTitle: state.productTitle,
      productImageUrl: state.productImageUrl,
      budgetCents: state.budgetCents,
      creative: state.creative,
      creativeVariants: state.creativeVariants ?? [],
      selectedCreativeIndex: state.selectedCreativeIndex,
      regenerationsLeft: state.regenerationsLeft,
    };
    try {
      if (prefill?.id) {
        await updateCampaignDraft(prefill.id, {
          name,
          platform: state.platform,
          state: draftState,
        });
      } else {
        await createCampaignDraft({
          name,
          platform: state.platform,
          state: draftState,
        });
      }
      app.toast("Draft saved.", "check", "success");
      onExit();
    } catch (err) {
      const message =
        err instanceof DashboardApiError
          ? err.message
          : "Couldn't save the draft — try again.";
      app.toast(message, "x", "critical");
      setSaving(false);
    }
  };

  return (
    <div
      ref={reviewRootRef}
      className="cd-cw-step-content cd-cw-review flex flex-col"
      style={{ gap: 16 }}
    >
      <h2 className="cd-h2">Customize it in the real placement</h2>

      <div className="cd-cw-review-layout">
        <section
          className="cd-cw-ad-preview-panel"
          aria-labelledby="ad-preview-title"
        >
          <div className="cd-cw-ad-preview-toolbar">
            <div
              className="cd-cw-preview-platform-tabs"
              role="tablist"
              aria-label="Preview platform"
            >
              {REVIEW_PREVIEW_PLACEMENTS.map((option) => {
                const label = placementLabel(option);
                const isCampaignPlacement = option === state.placement;
                return (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={previewPlacement === option}
                    aria-label={`${label}${isCampaignPlacement ? ", selected campaign placement" : ""}`}
                    data-campaign-placement={isCampaignPlacement ? "1" : "0"}
                    onClick={() => selectPreviewPlacement(option)}
                  >
                    <PlatformMark platform={label} size={20} />
                    <span>{label}</span>
                    {isCampaignPlacement && <small>Selected</small>}
                  </button>
                );
              })}
            </div>
            <div className="cd-cw-preview-toolbar-meta">
              <div className="cd-cw-preview-title">
                <PlatformMark platform={placementLabel(previewPlacement)} size={22} />
                <span id="ad-preview-title">
                  {placementLabel(previewPlacement)} preview
                </span>
                {previewPlacement !== state.placement && (
                  <span className="cd-cw-preview-only">Preview only</span>
                )}
              </div>
              {isMobileOnlyPreview(previewPlacement) ? (
                <span className="cd-cw-mobile-placement">Mobile placement</span>
              ) : (
                <div className="cd-cw-placement-toggle" aria-label="Preview device">
                  <button
                    type="button"
                    aria-pressed={device === "mobile"}
                    onClick={() => setDevice("mobile")}
                  >
                    Phone
                  </button>
                  <button
                    type="button"
                    aria-pressed={device === "desktop"}
                    onClick={() => setDevice("desktop")}
                  >
                    Desktop
                  </button>
                </div>
              )}
            </div>
          </div>

          <LiveAdPreview
            state={state}
            storeLabel={app.storeLabel || "Your store"}
            device={device}
            previewPlacement={previewPlacement}
            previewDirection={previewDirection}
            revision={previewRevision}
          />

          <p className="cd-cw-preview-note">
            <CDIcon name="check" size={13} />
            {previewPlacement === state.placement
              ? "Selected placement with your exact creative."
              : `Preview only. Campaign remains set to ${placementLabel(state.placement)}.`}
          </p>
        </section>

        <aside className="cd-cw-launch-panel" aria-label="Edit and launch ad">
          <div className="cd-cw-launch-head">
            <span>Edit ad</span>
            <span className="cd-cw-linked">
              <CDIcon name="check" size={12} /> Page linked
            </span>
          </div>
          {state.creative && (
            <div className="cd-cw-review-editor">
              <div className="cd-cw-review-media">
                {state.creative.imageUrl ? (
                  <img src={state.creative.imageUrl} alt="" />
                ) : (
                  <CDIcon name="image" size={18} />
                )}
                <span>
                  <b>Creative image</b>
                  <small>From {state.productTitle}</small>
                </span>
                <Btn
                  small
                  disabled={uploadingImage}
                  onClick={() => imageInputRef.current?.click()}
                >
                  {uploadingImage ? "Uploading…" : "Replace"}
                </Btn>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  hidden
                  onChange={(event) => {
                    void replaceCreativeImage(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </div>
              <div className="cd-cw-creative-fields">
                <label>
                  <span>
                    <b>Primary text</b>
                    <small>{state.creative.primaryText.length}/125</small>
                  </span>
                  <textarea
                    className="cd-input"
                    rows={3}
                    maxLength={125}
                    value={state.creative.primaryText}
                    onChange={(event) =>
                      editCreative({ primaryText: event.target.value })
                    }
                    onBlur={() =>
                      setPreviewRevision((revision) => revision + 1)
                    }
                  />
                </label>
                <label>
                  <span>
                    <b>Headline</b>
                    <small>{state.creative.headline.length}/40</small>
                  </span>
                  <input
                    className="cd-input"
                    maxLength={40}
                    value={state.creative.headline}
                    onChange={(event) =>
                      editCreative({ headline: event.target.value })
                    }
                    onBlur={() =>
                      setPreviewRevision((revision) => revision + 1)
                    }
                  />
                </label>
                <label className="cd-cw-creative-cta">
                  <span>
                    <b>Button</b>
                  </span>
                  <span className="cd-cw-select-wrap">
                    <select
                      className="cd-input"
                      value={state.creative.cta}
                      onChange={(event) =>
                        editCreative({ cta: event.target.value }, true)
                      }
                    >
                      {META_CTA_TYPES.map((cta) => (
                        <option key={cta} value={cta}>
                          {cta.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                    <CDIcon name="chevronDown" size={14} />
                  </span>
                </label>
                <label>
                  <span>
                    <b>Landing page</b>
                    <small>Your product page</small>
                  </span>
                  <input
                    className="cd-input"
                    type="url"
                    value={state.creative.destinationUrl}
                    readOnly
                  />
                </label>
              </div>
            </div>
          )}
          <div className="cd-cw-launch-summary">
            <SummaryRow
              label="Placement"
              value={placementLabel(state.placement)}
            />
            <SummaryRow
              label="Starting budget"
              value={`${money(state.budgetCents)}/day`}
            />
            <SummaryRow
              label="Audience"
              value={
                state.platform === "meta"
                  ? "Broad · United States"
                  : "Broad · your country"
              }
            />
          </div>
          <p className="cd-cw-launch-note">
            <b>Calderyn recommendation.</b> Start small, learn quickly, and
            scale the winner.{" "}
            {state.platform === "meta"
              ? "The campaign is created paused."
              : `Save this plan and launch it in ${placementLabel(state.placement)} Ads.`}
          </p>

          {state.platform === "meta" ? (
            created ? (
              <Card className="cd-cw-created-state">
                <div
                  className="flex items-center justify-between"
                  style={{ flexWrap: "wrap", gap: 12 }}
                >
                  <div>
                    <div className="cd-h3">
                      {turnedOn
                        ? "Campaign is live"
                        : `Created on ${placementLabel(state.placement)} — paused`}
                    </div>
                    <p className="cd-caption">
                      {turnedOn
                        ? "Manage it anytime from Campaigns."
                        : "Nothing spends until you turn it on."}
                    </p>
                  </div>
                  <Btn
                    kind="primary"
                    disabled={turningOn || turnedOn}
                    icon={turnedOn ? "check" : undefined}
                    onClick={turnOn}
                  >
                    {turnedOn
                      ? "Running"
                      : turningOn
                        ? "Turning on…"
                        : "Turn on"}
                  </Btn>
                </div>
                {!turnedOn && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="cd-link"
                      onClick={() => {
                        // The campaign list must show the new (paused) campaign on
                        // exit — in the embedded instance navigate is a no-op, so
                        // the refresh is what actually updates the screen.
                        app.refresh();
                        app.navigate("campaigns");
                      }}
                    >
                      Keep it paused for now
                    </button>
                  </div>
                )}
              </Card>
            ) : (
              <div className="cd-cw-launch-actions">
                <div className="cd-cw-launch-buttons">
                  {/* Same saveDraft path as Google/TikTok (replace semantics from a
                  resumed draft included) — an escape hatch if the merchant would
                  rather finish setting up Meta before it goes live. */}
                  <Btn disabled={saving || creating} onClick={saveDraft}>
                    {saving ? "Saving…" : "Save as draft"}
                  </Btn>
                  <Btn
                    kind="primary"
                    disabled={
                      !META_CREATE_ENABLED ||
                      !metaReady ||
                      !destinationIsValid ||
                      !state.creative?.imageUrl ||
                      creating ||
                      uploadingImage
                    }
                    onClick={createOnMeta}
                  >
                    {creating
                      ? "Creating…"
                      : `Create on ${placementLabel(state.placement)}`}
                  </Btn>
                </div>
                {createError && createErrorCode === "run_needs_review" ? (
                  // Retrying the SAME runId would just 409 again — offer a fresh
                  // start instead of the generic "try again" suffix. Safe: the new
                  // runId creates a new run; the old attempt's campaign (if any)
                  // is paused and spending nothing.
                  <span
                    className="cd-caption cd-cw-launch-message"
                    style={{ color: "var(--red)" }}
                  >
                    {createError}{" "}
                    <button
                      type="button"
                      className="cd-link"
                      onClick={() => {
                        dispatch({ type: "newRunId" });
                        setCreateError(null);
                        setCreateErrorCode(null);
                      }}
                    >
                      Start over
                    </button>
                  </span>
                ) : createError ? (
                  <span
                    className="cd-caption cd-cw-launch-message"
                    style={{ color: "var(--red)" }}
                  >
                    {createError} — try again, or save as a draft instead.
                  </span>
                ) : reviewPreflightPending ? (
                  <span className="cd-caption cd-cw-launch-message">
                    Checking Meta…
                  </span>
                ) : reviewPreflightError ? (
                  <span
                    className="cd-caption cd-cw-launch-message"
                    style={{ color: "var(--red)" }}
                  >
                    Couldn't verify Meta. Go back to Platform and try again.
                  </span>
                ) : !metaReady ? (
                  <span className="cd-caption cd-cw-launch-message">
                    Reconnect Meta on the first step to create this directly —
                    save as a draft for now.
                  </span>
                ) : !state.creative?.imageUrl ? (
                  <span className="cd-caption cd-cw-launch-message">
                    Add an image before creating this campaign.
                  </span>
                ) : null}
              </div>
            )
          ) : (
            <div className="cd-cw-launch-actions">
              <div className="cd-cw-launch-buttons">
                <Btn kind="primary" disabled={saving} onClick={saveDraft}>
                  {saving ? "Saving…" : "Save as draft"}
                </Btn>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ---------- Wizard shell ---------- */

export function CampaignWizard({
  app,
  prefill,
  onExit,
  embedded = false,
}: {
  app: DashboardCtx;
  prefill: WizardPrefill;
  onExit: () => void;
  /** True when the wizard lives inside an existing card (the Campaigns
   *  empty state) — skips the full-page cd-screen chrome so padding and
   *  max-width come from the host container, not doubled up. */
  embedded?: boolean;
}) {
  const [state, dispatch] = useReducer(wizardReducer, prefill, initWizardState);
  const [creativeRegenerating, setCreativeRegenerating] = useState(false);
  const [generationConfirmationOpen, setGenerationConfirmationOpen] =
    useState(false);
  const idx = STEP_ORDER.indexOf(state.step);
  const rootRef = useRef<HTMLDivElement>(null);
  const previousStepRef = useRef(idx);
  const continueTriggerRef = useRef<HTMLElement | null>(null);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const direction = idx >= previousStepRef.current ? 1 : -1;
      previousStepRef.current = idx;
      const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
      const currentStep = rootRef.current?.querySelector(
        ".cd-cw-progress li[data-state='current']",
      );
      const currentDot = currentStep?.querySelector(".cd-cw-progress-dot");
      const step = rootRef.current?.querySelector(".cd-cw-step");
      const content = rootRef.current?.querySelectorAll(
        ".cd-cw-step-content > *",
      );
      if (currentStep) {
        timeline.fromTo(
          currentStep,
          { autoAlpha: 0.55, y: -4 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.3,
            clearProps: "transform,opacity,visibility",
          },
        );
      }
      if (currentDot) {
        timeline.fromTo(
          currentDot,
          { scale: 0.62, rotation: direction * -9 },
          {
            scale: 1,
            rotation: 0,
            duration: 0.42,
            ease: "back.out(1.8)",
            clearProps: "transform",
          },
          "<",
        );
      }
      if (step) {
        timeline.fromTo(
          step,
          { autoAlpha: 0, x: direction * 14, willChange: "transform,opacity" },
          {
            autoAlpha: 1,
            x: 0,
            duration: 0.36,
            clearProps: "transform,opacity,visibility,willChange",
          },
          "-=0.24",
        );
      }
      if (content?.length) {
        timeline.fromTo(
          content,
          { autoAlpha: 0, y: 6 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.28,
            stagger: 0.035,
            ease: "power2.out",
            clearProps: "transform,opacity,visibility",
          },
          "-=0.23",
        );
      }
    },
    { scope: rootRef, dependencies: [state.step], revertOnUpdate: true },
  );

  const goBack = () => {
    if (idx === 0) return;
    dispatch({ type: "step", step: STEP_ORDER[idx - 1] });
  };
  const goNext = () => {
    if (idx === STEP_ORDER.length - 1) return;
    if (
      state.step === "product" &&
      state.productId &&
      !state.creative &&
      state.generationApprovedProductId !== state.productId
    ) {
      continueTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setGenerationConfirmationOpen(true);
      return;
    }
    dispatch({ type: "step", step: STEP_ORDER[idx + 1] });
  };

  const cancelGenerationConfirmation = () => {
    setGenerationConfirmationOpen(false);
    requestAnimationFrame(() =>
      continueTriggerRef.current?.focus({ preventScroll: true }),
    );
  };

  const confirmGeneration = () => {
    if (!state.productId) return;
    dispatch({ type: "confirmGeneration", productId: state.productId });
    setGenerationConfirmationOpen(false);
    dispatch({ type: "step", step: "creative" });
  };

  useEffect(() => {
    if (state.step !== "creative") setCreativeRegenerating(false);
  }, [state.step]);

  const platformReady =
    state.platform !== "meta" ||
    (state.preflight?.metaConnected === true &&
      state.preflight.adsScope === true &&
      state.preflight.pageOk === true);
  const creativeReady = Boolean(
    state.creative &&
      state.creative.headline.trim() !== "" &&
      state.creative.primaryText.trim() !== "" &&
      state.creative.cta.trim() !== "" &&
      state.creative.destinationUrl.trim() !== "",
  );
  const continueDisabled =
    state.step === "platform"
      ? !platformReady
      : state.step === "product"
        ? state.productId == null
        : state.step === "creative"
          ? !creativeReady || creativeRegenerating
          : true;
  const continueLabel: Record<WizardStep, string> = {
    platform: "Continue to product",
    product: "Continue to creative",
    creative: "Customize & preview",
    review: "Review campaign",
  };

  const body = (
    <div
      ref={rootRef}
      className="cd-cw-shell"
      data-embedded={embedded ? "1" : "0"}
    >
      <WizardHeader
        step={state.step}
        canBack={idx > 0}
        onBack={goBack}
        onStepSelect={(step) => {
          if (STEP_ORDER.indexOf(step) < idx) dispatch({ type: "step", step });
        }}
        onExit={onExit}
      />
      <div
        className="cd-cw-layout"
        data-review={state.step === "review" ? "1" : "0"}
      >
        <main className="cd-cw-step">
          {state.step === "platform" && (
            <PlatformStep
              state={state}
              dispatch={dispatch}
              app={app}
            />
          )}
          {state.step === "product" && (
            <ProductStep
              state={state}
              dispatch={dispatch}
              app={app}
            />
          )}
          {state.step === "creative" && (
            <CreativeStep
              state={state}
              dispatch={dispatch}
              regenerating={creativeRegenerating}
              setRegenerating={setCreativeRegenerating}
            />
          )}
          {state.step === "review" && (
            <ReviewStep
              state={state}
              dispatch={dispatch}
              app={app}
              prefill={prefill}
              onExit={onExit}
            />
          )}
        </main>
        {state.step !== "review" && (
          <CampaignDraftPreview
            state={state}
            continueLabel={continueLabel[state.step]}
            continueDisabled={continueDisabled}
            onContinue={goNext}
          />
        )}
      </div>
      {generationConfirmationOpen && state.step === "product" && (
        <CreativeGenerationConfirmationDialog
          productTitle={state.productTitle}
          onCancel={cancelGenerationConfirmation}
          onConfirm={confirmGeneration}
        />
      )}
    </div>
  );

  if (embedded) return <div>{body}</div>;
  return (
    <div className="cd-screen cd-cw-screen" data-screen-label="New campaign">
      {body}
    </div>
  );
}
