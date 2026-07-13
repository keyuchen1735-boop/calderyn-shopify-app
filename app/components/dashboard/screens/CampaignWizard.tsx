import { useEffect, useReducer, useState, type ReactNode } from "react";
import { Card, Btn, PlatformMark } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import {
  fetchFirstRunPreflight,
  generateFirstRunCreatives,
  startIntegrationConnect,
  fetchProducts,
  DashboardApiError,
  type FirstRunPreflight,
  type FirstRunCreativeVariant,
  type ProductSummaryVM,
} from "~/lib/dashboard/client";
import { createCampaignDraft } from "~/lib/dashboard/campaign-drafts-client";
import {
  CAMPAIGN_DRAFT_PLATFORM_LABELS,
  type CampaignDraftPlatform,
} from "~/lib/ads/campaign-draft-types";
import type { DashboardCtx } from "../context";

/* ---------- Shared constants ---------- */

const MIN_BUDGET_CENTS = 500;
const MAX_BUDGET_CENTS = 20000;
const DEFAULT_BUDGET_CENTS = 1500;

/** Meta's actual create call is Task 13's job — this stub keeps the button
 *  disabled and the copy honest until that lands. Flip this to gate on real
 *  wiring, not a guess. */
const META_CREATE_ENABLED = false;

const BADGE_NEUTRAL = { color: "var(--text-2)", background: "var(--gray-bg)" } as const;
const BADGE_GOOD = { color: "var(--green)", background: "var(--green-bg)" } as const;

const STEP_ORDER = ["platform", "product", "creative", "review"] as const;
type WizardStep = (typeof STEP_ORDER)[number];

interface CreativeFields {
  headline: string;
  primaryText: string;
  cta: string;
}

interface WizardState {
  step: WizardStep;
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
  | { type: "creative"; creative: CreativeFields };

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "step":
      return { ...state, step: action.step };
    case "platform":
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
    default:
      return state;
  }
}

function initWizardState(prefill: { name?: string; platform?: CampaignDraftPlatform } | null): WizardState {
  const platform = prefill?.platform ?? "meta";
  return {
    // A draft already picked a platform — jump straight to product pick.
    step: prefill?.platform ? "product" : "platform",
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
    if (state.platform !== "meta") return;
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
  }, [state.platform, retryTick]);

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
                <StatusRow tone={state.preflight.fundingOk ? "good" : "warn"} icon={state.preflight.fundingOk ? "check" : "warn"}>
                  {state.preflight.fundingOk ? "Billing is set up" : "Billing isn't set up yet"}
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
  onNext,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  onNext: () => void;
}) {
  const [search, setSearch] = useState("");
  const [products, setProducts] = useState<ProductSummaryVM[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [budgetInput, setBudgetInput] = useState(String(state.budgetCents / 100));
  const [budgetError, setBudgetError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    fetchProducts({ status: "active", search: search || undefined })
      .then((res) => {
        if (alive) setProducts(res.products);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [search]);

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

      <input
        className="cd-input"
        placeholder="Search products"
        aria-label="Search products"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: "100%" }}
      />

      {products === null && !loadError ? (
        <p className="cd-caption">Loading products…</p>
      ) : loadError ? (
        <p className="cd-caption" style={{ color: "var(--red)" }}>
          Couldn't load your products — try again.
        </p>
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
  const productId = state.productId;
  const productTitle = state.productTitle;

  useEffect(() => {
    if (!productId) return;
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
            creative: { headline: first.headline, primaryText: first.primaryText, cta: first.cta },
          });
        } else {
          setVariants(null);
          dispatch({
            type: "creative",
            creative: { headline: productTitle ?? "", primaryText: "", cta: "Shop now" },
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setLoadError(true);
        setAvailable(false);
        setVariants(null);
        dispatch({
          type: "creative",
          creative: { headline: productTitle ?? "", primaryText: "", cta: "Shop now" },
        });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  const loading = state.creative === null && !loadError;
  const creative = state.creative;

  const selectVariant = (i: number) => {
    if (!variants) return;
    setSelectedIdx(i);
    const v = variants[i];
    dispatch({ type: "creative", creative: { headline: v.headline, primaryText: v.primaryText, cta: v.cta } });
  };

  const editCreative = (patch: Partial<CreativeFields>) => {
    dispatch({ type: "creative", creative: { ...(creative ?? { headline: "", primaryText: "", cta: "" }), ...patch } });
  };

  const canContinue = !!creative && creative.headline.trim() !== "" && creative.primaryText.trim() !== "" && creative.cta.trim() !== "";

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      <div>
        <h2 className="cd-h2">Your ad</h2>
        <p className="cd-caption">Everything here is editable — change anything before you continue.</p>
      </div>

      {loading ? (
        <p className="cd-caption">Writing your ad…</p>
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
                          style={{ width: 160 }}
                        />
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
                style={{ width: 160 }}
              />
            </div>
          </Card>
        )
      )}

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
  app,
  prefill,
  onExit,
}: {
  state: WizardState;
  app: DashboardCtx;
  prefill: { name?: string; platform?: CampaignDraftPlatform } | null;
  onExit: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const monthlyCents = state.budgetCents * 30;

  const saveDraft = async () => {
    if (saving) return;
    setSaving(true);
    const name = prefill?.name?.trim() || state.productTitle || "New campaign";
    try {
      await createCampaignDraft({ name, platform: state.platform });
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
        <SummaryRow label="Audience" value="Broad — your country" />
        <SummaryRow label="Platform" value={CAMPAIGN_DRAFT_PLATFORM_LABELS[state.platform]} />
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
        <div className="flex flex-col items-end" style={{ gap: 6 }}>
          <Btn kind="primary" disabled={!META_CREATE_ENABLED}>
            Create on Meta
          </Btn>
          <span className="cd-caption">Creating on Meta lands in the next update</span>
        </div>
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
}: {
  app: DashboardCtx;
  prefill: { name?: string; platform?: CampaignDraftPlatform } | null;
  onExit: () => void;
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

  return (
    <div className="cd-screen" data-screen-label="New campaign">
      <WizardHeader step={state.step} canBack={idx > 0} onBack={goBack} onExit={onExit} />
      {state.step === "platform" && <PlatformStep state={state} dispatch={dispatch} app={app} onNext={goNext} />}
      {state.step === "product" && <ProductStep state={state} dispatch={dispatch} onNext={goNext} />}
      {state.step === "creative" && <CreativeStep state={state} dispatch={dispatch} onNext={goNext} />}
      {state.step === "review" && <ReviewStep state={state} app={app} prefill={prefill} onExit={onExit} />}
    </div>
  );
}
