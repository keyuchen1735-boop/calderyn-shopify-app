import { useEffect, useReducer, useState, type ReactNode } from "react";
import { Card, Btn, ClearableSearchInput, Placeholder, PlatformMark } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import {
  fetchFirstRunPreflight,
  generateFirstRunCreatives,
  createFirstCampaignRun,
  executeCampaignAction,
  startIntegrationConnect,
  fetchProducts,
  DashboardApiError,
  type FirstRunPreflight,
  type FirstRunCreativeVariant,
  type ProductSummaryVM,
} from "~/lib/dashboard/client";
import { createCampaignDraft, deleteCampaignDraft } from "~/lib/dashboard/campaign-drafts-client";
import { META_CTA_TYPES } from "~/lib/meta/cta-types";
import {
  CAMPAIGN_DRAFT_PLATFORM_LABELS,
  MAX_CAMPAIGN_DRAFT_NAME_LENGTH,
  type CampaignDraftPlatform,
} from "~/lib/ads/campaign-draft-types";
import type { DashboardCtx } from "../context";

/** Draft resume carries the id being replaced, alongside the name/platform the
 *  draft was saved with. */
type WizardPrefill = { id?: string; name?: string; platform?: CampaignDraftPlatform } | null;

/* ---------- Shared constants ---------- */

const MIN_BUDGET_CENTS = 500;
const MAX_BUDGET_CENTS = 20000;
const DEFAULT_BUDGET_CENTS = 1500;

/** Meta's actual create call landed in Task 13 — the review step's "Create on
 *  Meta" button is real, gated on a green preflight rather than a stub. */
const META_CREATE_ENABLED = true;

const BADGE_NEUTRAL = { color: "var(--text-2)", background: "var(--gray-bg)" } as const;
const BADGE_GOOD = { color: "var(--green)", background: "var(--green-bg)" } as const;

const STEP_ORDER = ["platform", "product", "creative", "review"] as const;
type WizardStep = (typeof STEP_ORDER)[number];

interface CreativeFields {
  headline: string;
  primaryText: string;
  cta: string;
  /** Signed product image the copy was scored against — server-resolved
   *  (Task 13's first-run/creatives route), not derivable in the browser. */
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
  preflight: FirstRunPreflight | null;
  productId: string | null;
  productTitle: string | null;
  productImageUrl: string | null;
  budgetCents: number;
  creative: CreativeFields | null;
}

type WizardAction =
  | { type: "step"; step: WizardStep }
  | { type: "platform"; platform: CampaignDraftPlatform }
  | { type: "preflight"; preflight: FirstRunPreflight }
  | { type: "product"; id: string; title: string; imageUrl: string | null }
  | { type: "budget"; cents: number }
  | { type: "creative"; creative: CreativeFields }
  /** Mint a fresh runId: the server 409s (run_input_mismatch) when a runId is
   *  replayed with different campaign details, so an edited run starts over. */
  | { type: "newRunId" };

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "step":
      return { ...state, step: action.step };
    case "platform":
      // Re-picking the already-selected platform is a no-op. Resetting
      // preflight here would leave PlatformStep's guarded effect dep unchanged
      // (state.platform), so the "Checking your Meta connection…" state would
      // never resolve again.
      if (action.platform === state.platform) return state;
      // Switching platform invalidates any Meta preflight read for the old pick.
      return { ...state, platform: action.platform, preflight: null };
    case "preflight":
      return { ...state, preflight: action.preflight };
    case "product":
      // A new product invalidates any creative generated for the old one.
      return {
        ...state,
        productId: action.id,
        productTitle: action.title,
        productImageUrl: action.imageUrl,
        creative: null,
      };
    case "budget":
      return { ...state, budgetCents: action.cents };
    case "creative":
      return { ...state, creative: action.creative };
    case "newRunId":
      return { ...state, runId: crypto.randomUUID() };
    default:
      return state;
  }
}

function initWizardState(prefill: WizardPrefill): WizardState {
  const platform = prefill?.platform ?? "meta";
  return {
    // A Google/TikTok draft already picked a platform — jump straight to the
    // product pick. A Meta draft still starts on the platform step (preselected)
    // so the connect button / readiness checks are never skipped: resuming a
    // draft is exactly when the account may still be unconnected.
    step: prefill?.platform && prefill.platform !== "meta" ? "product" : "platform",
    runId: crypto.randomUUID(),
    platform,
    preflight: null,
    productId: null,
    productTitle: null,
    productImageUrl: null,
    budgetCents: DEFAULT_BUDGET_CENTS,
    creative: null,
  };
}

/* ---------- Header ---------- */

function StepDots({ current }: { current: WizardStep }) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <div className="flex items-center" style={{ gap: 6 }} aria-hidden="true">
      {STEP_ORDER.map((s, i) => (
        <span
          key={s}
          style={{
            width: i === idx ? 18 : 6,
            height: 6,
            borderRadius: 3,
            background: i <= idx ? "var(--accent)" : "var(--hairline)",
            transition: "width .18s ease, background .18s ease",
          }}
        />
      ))}
    </div>
  );
}

function WizardHeader({
  step,
  canBack,
  onBack,
  onExit,
}: {
  step: WizardStep;
  canBack: boolean;
  onBack: () => void;
  onExit: () => void;
}) {
  return (
    <div className="flex items-center justify-between" style={{ marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
      <div className="flex items-center" style={{ gap: 12 }}>
        {canBack && (
          <Btn small icon="chevronLeft" onClick={onBack}>
            Back
          </Btn>
        )}
        <StepDots current={step} />
      </div>
      <button type="button" className="cd-link" onClick={onExit}>
        Skip — I know what I'm doing
      </button>
    </div>
  );
}

/* ---------- Step 1: platform ---------- */

function StatusRow({
  tone,
  icon,
  children,
}: {
  tone: "good" | "warn" | "info";
  icon: string;
  children: ReactNode;
}) {
  const color = tone === "good" ? "var(--green)" : tone === "warn" ? "var(--orange)" : "var(--text-2)";
  return (
    <div className="flex items-center" style={{ gap: 8, fontSize: 13.5, color, padding: "3px 0" }}>
      <CDIcon name={icon} size={15} />
      <span>{children}</span>
    </div>
  );
}

function PlatformStep({
  state,
  dispatch,
  app,
  onNext,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  app: DashboardCtx;
  onNext: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [preflightError, setPreflightError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

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
        err instanceof DashboardApiError ? err.message : "Couldn't start the connection — try again.";
      app.toast(message, "x", "critical");
      setConnecting(false);
    }
  };

  const isMeta = state.platform === "meta";
  const loadingPreflight = isMeta && state.preflight === null && !preflightError;
  const canContinue = !isMeta || state.preflight?.metaConnected === true;

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <div>
        <h2 className="cd-h2">Which platform?</h2>
        <p className="cd-caption">Pick where your first ad runs. You can add more later.</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {(["meta", "google", "tiktok"] as const).map((p) => (
          <Card
            key={p}
            hover
            onClick={() => dispatch({ type: "platform", platform: p })}
            className={state.platform === p ? "cd-tile-selected" : ""}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <PlatformMark platform={CAMPAIGN_DRAFT_PLATFORM_LABELS[p]} />
              {p === "meta" && (
                <span className="cd-badge" style={BADGE_GOOD}>
                  Recommended
                </span>
              )}
            </div>
            <div className="cd-h3">{CAMPAIGN_DRAFT_PLATFORM_LABELS[p]}</div>
          </Card>
        ))}
      </div>

      {isMeta && (
        <Card>
          {loadingPreflight ? (
            <p className="cd-caption">Checking your Meta connection…</p>
          ) : preflightError ? (
            <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 10 }}>
              <span className="cd-caption" style={{ color: "var(--red)" }}>
                Couldn't check your Meta connection — try again.
              </span>
              <Btn small onClick={() => setRetryTick((t) => t + 1)}>
                Try again
              </Btn>
            </div>
          ) : state.preflight && !state.preflight.metaConnected ? (
            <div className="flex flex-col" style={{ gap: 12 }}>
              <p className="cd-caption">Connect a Meta ad account to run this campaign.</p>
              <div className="flex items-center" style={{ gap: 10, flexWrap: "wrap" }}>
                <Btn kind="primary" disabled={connecting} onClick={connect}>
                  {connecting ? "Connecting…" : "I have a Meta ad account"}
                </Btn>
                <Btn onClick={() => setExpanded((v) => !v)}>I don't have one yet</Btn>
              </div>
              {expanded && (
                <div className="flex flex-col" style={{ gap: 8, fontSize: 13.5 }}>
                  <ol style={{ paddingLeft: 18, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    <li>
                      Create a business portfolio at{" "}
                      <a href="https://business.facebook.com" target="_blank" rel="noreferrer">
                        business.facebook.com
                      </a>
                      .
                    </li>
                    <li>Create an ad account and add a billing method.</li>
                    <li>Come back here and connect it.</li>
                  </ol>
                  <div>
                    <Btn kind="primary" disabled={connecting} onClick={connect}>
                      {connecting ? "Connecting…" : "Connect Meta"}
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          ) : state.preflight ? (
            <div className="flex flex-col">
              <StatusRow tone={state.preflight.adsScope ? "good" : "warn"} icon={state.preflight.adsScope ? "check" : "warn"}>
                {state.preflight.adsScope ? "Ad permissions granted" : "Missing ad permissions — reconnect to grant access"}
              </StatusRow>
              <StatusRow tone={state.preflight.pageOk ? "good" : "warn"} icon={state.preflight.pageOk ? "check" : "warn"}>
                {state.preflight.pageOk ? "Facebook Page connected" : "No Facebook Page connected yet"}
              </StatusRow>
              {state.preflight.fundingOk === null ? (
                <StatusRow tone="info" icon="card">
                  Make sure billing is set up —{" "}
                  <a href="https://business.facebook.com/billing_hub/accounts" target="_blank" rel="noreferrer">
                    check billing
                  </a>
                </StatusRow>
              ) : (
                // The preflight contract only ever produces true | null for
                // fundingOk (see FirstRunPreflight) — this branch is only
                // reachable when it's true.
                <StatusRow tone="good" icon="check">
                  Billing is set up
                </StatusRow>
              )}
            </div>
          ) : null}
        </Card>
      )}

      <div className="flex justify-end">
        <Btn kind="primary" disabled={!canContinue} onClick={onNext}>
          Continue
        </Btn>
      </div>
    </div>
  );
}

/* ---------- Step 2: product + budget ---------- */

function ProductStep({
  state,
  dispatch,
  app,
  onNext,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  app: DashboardCtx;
  onNext: () => void;
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
  const [loadError, setLoadError] = useState(false);
  const [budgetInput, setBudgetInput] = useState(String(state.budgetCents / 100));
  const [budgetError, setBudgetError] = useState<string | null>(null);

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

  const commitBudget = (raw: string) => {
    setBudgetInput(raw);
    const dollars = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(dollars)) {
      setBudgetError("Enter an amount between $5 and $200 a day.");
      return;
    }
    const cents = Math.round(dollars * 100);
    if (cents < MIN_BUDGET_CENTS || cents > MAX_BUDGET_CENTS) {
      setBudgetError("Enter an amount between $5 and $200 a day.");
      return;
    }
    setBudgetError(null);
    dispatch({ type: "budget", cents });
  };

  const canContinue =
    state.productId != null &&
    !budgetError &&
    state.budgetCents >= MIN_BUDGET_CENTS &&
    state.budgetCents <= MAX_BUDGET_CENTS;

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <div>
        <h2 className="cd-h2">Which product?</h2>
        <p className="cd-caption">Pick the product this ad sends people to.</p>
      </div>

      <ClearableSearchInput
        value={search}
        onChange={setSearch}
        placeholder="Search products"
        ariaLabel="Search products"
      />

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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
          {(products ?? []).map((p) => (
            <Card
              key={p.id}
              hover
              onClick={() => dispatch({ type: "product", id: p.id, title: p.title, imageUrl: p.imageUrl })}
              className={state.productId === p.id ? "cd-tile-selected" : ""}
            >
              <div
                style={{
                  width: "100%",
                  aspectRatio: "1",
                  borderRadius: 8,
                  background: p.imageUrl ? `center/cover no-repeat url(${p.imageUrl})` : "var(--gray-bg)",
                  marginBottom: 8,
                }}
              />
              <div className="cd-row-title truncate" style={{ fontSize: 13.5 }}>
                {p.title}
              </div>
              <div className="cd-caption tabular-nums">{p.priceCents != null ? money(p.priceCents) : "—"}</div>
            </Card>
          ))}
        </div>
      )}

      <div>
        <label className="cd-caption" htmlFor="wizard-budget">
          Daily budget
        </label>
        <div className="flex items-center" style={{ gap: 8, marginTop: 4 }}>
          <span>$</span>
          <input
            id="wizard-budget"
            className="cd-input"
            type="number"
            min={5}
            max={200}
            step={1}
            value={budgetInput}
            onChange={(e) => commitBudget(e.target.value)}
            style={{ width: 100 }}
          />
          <span className="cd-caption">/ day</span>
        </div>
        {budgetError ? (
          <p className="cd-caption" style={{ color: "var(--red)", marginTop: 4 }}>
            {budgetError}
          </p>
        ) : (
          <p className="cd-caption" style={{ marginTop: 4 }}>
            Most stores start at $10–20/day. About {money(state.budgetCents * 30)}/month.
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <Btn kind="primary" disabled={!canContinue} onClick={onNext}>
          Continue
        </Btn>
      </div>
    </div>
  );
}

/* ---------- Step 3: creative ---------- */

function CreativeStep({
  state,
  dispatch,
  onNext,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onNext: () => void;
}) {
  const [variants, setVariants] = useState<FirstRunCreativeVariant[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const productId = state.productId;
  const productTitle = state.productTitle;

  useEffect(() => {
    // Skip when a creative already exists for this product — this effect
    // fires on every remount (Back to ProductStep, then Continue again re-
    // mounts CreativeStep), and without this guard it would re-bill Claude
    // and clobber whatever the merchant just edited. The reducer nulls
    // state.creative whenever the product changes (see "product" case), so
    // this is safe: a real product change always clears it and re-generates.
    // retryTick still re-fires this on a failed load: state.creative stays
    // null on that path (below), so the guard falls through.
    if (!productId || state.creative) return;
    let alive = true;
    setVariants(null);
    setLoadError(false);
    generateFirstRunCreatives(productId)
      .then((res) => {
        if (!alive) return;
        setAvailable(res.available);
        if (res.available && res.variants.length > 0) {
          setVariants(res.variants);
          setSelectedIdx(0);
          const first = res.variants[0];
          dispatch({
            type: "creative",
            creative: {
              headline: first.headline,
              primaryText: first.primaryText,
              cta: first.cta,
              imageUrl: res.imageUrl,
              destinationUrl: res.destinationUrl,
              audience: "Broad — your country",
            },
          });
        } else {
          setVariants(null);
          dispatch({
            type: "creative",
            creative: {
              headline: productTitle ?? "",
              primaryText: "",
              cta: "SHOP_NOW",
              imageUrl: res.imageUrl,
              destinationUrl: res.destinationUrl,
              audience: "Broad — your country",
            },
          });
        }
      })
      .catch(() => {
        // No destinationUrl to fall back to (server-only resolution) — leave
        // state.creative null and show a real retry rather than silently
        // continuing with an ad that has no landing page.
        if (!alive) return;
        setLoadError(true);
        setAvailable(false);
        setVariants(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, state.creative, retryTick]);

  const loading = state.creative === null && !loadError;
  const creative = state.creative;

  const selectVariant = (i: number) => {
    if (!variants || !creative) return;
    setSelectedIdx(i);
    const v = variants[i];
    dispatch({
      type: "creative",
      creative: { ...creative, headline: v.headline, primaryText: v.primaryText, cta: v.cta },
    });
  };

  const editCreative = (patch: Partial<CreativeFields>) => {
    if (!creative) return;
    dispatch({ type: "creative", creative: { ...creative, ...patch } });
  };

  const canContinue =
    !!creative &&
    creative.headline.trim() !== "" &&
    creative.primaryText.trim() !== "" &&
    creative.cta.trim() !== "" &&
    creative.destinationUrl.trim() !== "";

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <div>
        <h2 className="cd-h2">Your ad</h2>
        <p className="cd-caption">Everything here is editable — change anything before you continue.</p>
      </div>

      {loading ? (
        <p className="cd-caption">Writing your ad…</p>
      ) : loadError ? (
        <Card>
          <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="cd-caption" style={{ color: "var(--red)" }}>
              Couldn't prepare your ad — try again.
            </span>
            <Btn small onClick={() => setRetryTick((t) => t + 1)}>
              Try again
            </Btn>
          </div>
        </Card>
      ) : available && variants ? (
        <div className="flex flex-col" style={{ gap: 12 }}>
          {variants.map((v, i) => {
            const selected = i === selectedIdx;
            return (
              <Card key={i} className={selected ? "cd-tile-selected" : ""}>
                <label className="flex items-start" style={{ gap: 10, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="wizard-variant"
                    checked={selected}
                    onChange={() => selectVariant(i)}
                    style={{ marginTop: 4 }}
                  />
                  <div className="flex flex-col" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                    {selected && creative ? (
                      <>
                        <input
                          className="cd-input"
                          value={creative.headline}
                          onChange={(e) => editCreative({ headline: e.target.value })}
                          aria-label="Headline"
                        />
                        <textarea
                          className="cd-input"
                          rows={2}
                          value={creative.primaryText}
                          onChange={(e) => editCreative({ primaryText: e.target.value })}
                          aria-label="Primary text"
                          style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
                        />
                        <input
                          className="cd-input"
                          value={creative.cta}
                          onChange={(e) => editCreative({ cta: e.target.value })}
                          aria-label="Call to action"
                          list="wizard-cta-options"
                          style={{ width: 160 }}
                        />
                        <p className="cd-caption" style={{ opacity: 0.8 }}>
                          Button label — pick from Meta's list; anything else becomes “Shop now”.
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="cd-row-title">{v.headline}</div>
                        <p className="cd-caption">{v.primaryText}</p>
                        <span className="cd-badge" style={BADGE_NEUTRAL}>
                          {v.cta}
                        </span>
                      </>
                    )}
                    <p className="cd-caption" style={{ opacity: 0.8 }}>
                      {v.rationale}
                    </p>
                  </div>
                </label>
              </Card>
            );
          })}
        </div>
      ) : (
        creative && (
          <Card>
            <p className="cd-caption" style={{ marginBottom: 10 }}>
              Wrote a starting point — edit anything.
            </p>
            <div className="flex flex-col" style={{ gap: 8 }}>
              <input
                className="cd-input"
                value={creative.headline}
                onChange={(e) => editCreative({ headline: e.target.value })}
                aria-label="Headline"
              />
              <textarea
                className="cd-input"
                rows={2}
                value={creative.primaryText}
                onChange={(e) => editCreative({ primaryText: e.target.value })}
                aria-label="Primary text"
                style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
              />
              <input
                className="cd-input"
                value={creative.cta}
                onChange={(e) => editCreative({ cta: e.target.value })}
                aria-label="Call to action"
                list="wizard-cta-options"
                style={{ width: 160 }}
              />
              <p className="cd-caption" style={{ opacity: 0.8 }}>
                Button label — pick from Meta's list; anything else becomes “Shop now”.
              </p>
            </div>
          </Card>
        )
      )}

      {/* Meta's call_to_action is an enum — offer the allowed values so a
          hand-typed label isn't a trap (the server normalizes either way). */}
      <datalist id="wizard-cta-options">
        {META_CTA_TYPES.map((cta) => (
          <option key={cta} value={cta} />
        ))}
      </datalist>

      <div className="flex justify-end">
        <Btn kind="primary" disabled={!canContinue} onClick={onNext}>
          Continue
        </Btn>
      </div>
    </div>
  );
}

/* ---------- Step 4: review ---------- */

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: "7px 0", fontSize: 13.5 }}>
      <span className="cd-caption">{label}</span>
      <b style={{ fontWeight: 600 }}>{value}</b>
    </div>
  );
}

function buildPlanText(state: WizardState): string {
  return [
    `Platform: ${CAMPAIGN_DRAFT_PLATFORM_LABELS[state.platform]}`,
    `Product: ${state.productTitle ?? ""}`,
    `Daily budget: ${money(state.budgetCents)}`,
    `Audience: Broad — your country`,
    `Headline: ${state.creative?.headline ?? ""}`,
    `Primary text: ${state.creative?.primaryText ?? ""}`,
    `Call to action: ${state.creative?.cta ?? ""}`,
  ].join("\n");
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
  const [created, setCreated] = useState<{ campaignDimId: string } | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  /** True once resume_campaign succeeded — makes the Turn on button single-use. */
  const [turnedOn, setTurnedOn] = useState(false);
  const monthlyCents = state.budgetCents * 30;

  // Re-checked here, not just trusted from an earlier step: the preflight read
  // happened on PlatformStep, and a merchant can sit on Review for a while (or
  // resume a draft that skipped it) — never fire a real Meta create off a stale
  // or unconfirmed connection state.
  const metaReady = state.platform === "meta" && state.preflight?.metaConnected === true;

  const createOnMeta = async () => {
    if (creating || created || !metaReady || !state.creative || !state.productId) return;
    setCreating(true);
    setCreateError(null);
    setCreateErrorCode(null);
    try {
      const result = await createFirstCampaignRun({
        runId: state.runId,
        productId: state.productId,
        budgetCents: state.budgetCents,
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
      if (err instanceof DashboardApiError && err.code === "run_input_mismatch") {
        // The runId was used before with different details (the merchant went
        // back and edited something after a failed attempt). Safe to start a
        // fresh run — the server only reopens runs that created nothing on
        // Meta, and it refuses this one rather than redirecting it.
        dispatch({ type: "newRunId" });
        setCreateError("Your campaign details changed since the last attempt — click Create on Meta to start fresh.");
      } else {
        // Honest server message — the SAME runId is reused on the next click
        // (state.runId is stable), so a retry resumes this run instead of
        // creating a second campaign on Meta. run_needs_review keeps the dead
        // runId but additionally renders a "Start over" link (below) that
        // mints a fresh one, so the merchant isn't stranded.
        const message = err instanceof DashboardApiError ? err.message : "Couldn't create the campaign — try again.";
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
      await executeCampaignAction(created.campaignDimId, { type: "resume_campaign" });
      setTurnedOn(true);
      app.toast("Campaign is live.", "check", "success");
      app.refresh();
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't turn it on — try from Campaigns.";
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
    const rawName = state.productTitle || prefill?.name?.trim() || "New campaign";
    const name = rawName.slice(0, MAX_CAMPAIGN_DRAFT_NAME_LENGTH);
    try {
      await createCampaignDraft({ name, platform: state.platform });
      if (prefill?.id) {
        // There's no update endpoint for drafts, so resuming one is really
        // "create the new row, then remove the old one" — replace semantics.
        // Best-effort: a failed delete must not fail the save itself.
        try {
          await deleteCampaignDraft(prefill.id);
        } catch (err) {
          console.error("[campaign wizard] failed to delete superseded draft", err);
        }
      }
      app.toast("Draft saved.", "check", "success");
      onExit();
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Couldn't save the draft — try again.";
      app.toast(message, "x", "critical");
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <div>
        <h2 className="cd-h2">Review</h2>
        <p className="cd-caption">Nothing spends until you turn it on.</p>
      </div>

      <Card>
        <SummaryRow label="Product" value={state.productTitle ?? "—"} />
        <SummaryRow label="Budget" value={`${money(state.budgetCents)}/day · about ${money(monthlyCents)}/month`} />
        {/* Honest about what the Meta create actually targets today: the server
            has no shop-country source yet (shop-country.server.ts), so first
            campaigns target the United States. Non-Meta plans are executed by
            the merchant in that platform's own Ads manager. */}
        <SummaryRow
          label="Audience"
          value={state.platform === "meta" ? "Broad — United States" : "Broad — your country"}
        />
        <SummaryRow label="Platform" value={CAMPAIGN_DRAFT_PLATFORM_LABELS[state.platform]} />
        {state.platform === "meta" && (
          <p className="cd-caption" style={{ marginTop: 4 }}>
            First campaigns target the United States — regional targeting is coming.
          </p>
        )}
      </Card>

      <Card>
        <p className="cd-caption" style={{ marginBottom: 8 }}>
          Ad preview
        </p>
        <div className="cd-h3">{state.creative?.headline}</div>
        <p className="cd-caption" style={{ margin: "6px 0" }}>
          {state.creative?.primaryText}
        </p>
        <span className="cd-badge" style={BADGE_NEUTRAL}>
          {state.creative?.cta}
        </span>
      </Card>

      {state.platform === "meta" ? (
        created ? (
          <Card>
            <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <div className="cd-h3">{turnedOn ? "Campaign is live" : "Created on Meta — paused"}</div>
                <p className="cd-caption">
                  {turnedOn ? "Manage it anytime from Campaigns." : "Nothing spends until you turn it on."}
                </p>
              </div>
              <Btn kind="primary" disabled={turningOn || turnedOn} icon={turnedOn ? "check" : undefined} onClick={turnOn}>
                {turnedOn ? "Running" : turningOn ? "Turning on…" : "Turn on"}
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
          <div className="flex flex-col items-end" style={{ gap: 6 }}>
            <div className="flex items-center" style={{ gap: 10 }}>
              {/* Same saveDraft path as Google/TikTok (replace semantics from a
                  resumed draft included) — an escape hatch if the merchant would
                  rather finish setting up Meta before it goes live. */}
              <Btn disabled={saving || creating} onClick={saveDraft}>
                {saving ? "Saving…" : "Save as draft"}
              </Btn>
              <Btn kind="primary" disabled={!META_CREATE_ENABLED || !metaReady || creating} onClick={createOnMeta}>
                {creating ? "Creating…" : "Create on Meta"}
              </Btn>
            </div>
            {createError && createErrorCode === "run_needs_review" ? (
              // Retrying the SAME runId would just 409 again — offer a fresh
              // start instead of the generic "try again" suffix. Safe: the new
              // runId creates a new run; the old attempt's campaign (if any)
              // is paused and spending nothing.
              <span className="cd-caption" style={{ color: "var(--red)" }}>
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
              <span className="cd-caption" style={{ color: "var(--red)" }}>
                {createError} — try again, or save as a draft instead.
              </span>
            ) : !metaReady ? (
              <span className="cd-caption">
                Reconnect Meta on the first step to create this directly — save as a draft for now.
              </span>
            ) : null}
          </div>
        )
      ) : (
        <div className="flex flex-col" style={{ gap: 10 }}>
          <p className="cd-caption">
            Your plan — copy this into {CAMPAIGN_DRAFT_PLATFORM_LABELS[state.platform]} Ads, or save it as a draft and
            come back later.
          </p>
          <textarea
            className="cd-input"
            readOnly
            rows={7}
            value={buildPlanText(state)}
            style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
          />
          <div className="flex justify-end">
            <Btn kind="primary" disabled={saving} onClick={saveDraft}>
              {saving ? "Saving…" : "Save as draft"}
            </Btn>
          </div>
        </div>
      )}
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
  const idx = STEP_ORDER.indexOf(state.step);

  const goBack = () => {
    if (idx === 0) return;
    dispatch({ type: "step", step: STEP_ORDER[idx - 1] });
  };
  const goNext = () => {
    if (idx === STEP_ORDER.length - 1) return;
    dispatch({ type: "step", step: STEP_ORDER[idx + 1] });
  };

  const body = (
    <>
      <WizardHeader step={state.step} canBack={idx > 0} onBack={goBack} onExit={onExit} />
      {state.step === "platform" && <PlatformStep state={state} dispatch={dispatch} app={app} onNext={goNext} />}
      {state.step === "product" && <ProductStep state={state} dispatch={dispatch} app={app} onNext={goNext} />}
      {state.step === "creative" && <CreativeStep state={state} dispatch={dispatch} onNext={goNext} />}
      {state.step === "review" && (
        <ReviewStep state={state} dispatch={dispatch} app={app} prefill={prefill} onExit={onExit} />
      )}
    </>
  );

  if (embedded) return <div>{body}</div>;
  return (
    <div className="cd-screen" data-screen-label="New campaign">
      {body}
    </div>
  );
}
