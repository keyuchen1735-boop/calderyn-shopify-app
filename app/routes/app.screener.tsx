// app/routes/app.screener.tsx
// NOTE: do NOT add `export const config = { maxDuration: ... }` here. With
// v3_singleFetch, a per-route config makes @vercel/remix split this route into its
// own serverless function that does NOT serve the single-fetch `/app/screener.data`
// path — so client-side nav 404s while the full page load works. If the live (Claude)
// path later needs a longer timeout, set it for the whole server function in
// vercel.json, not per-route.
//
// UI mirrors the Calderyn dashboard's Creative Predictor screen
// (app/components/dashboard/screens/Predictor.tsx): form → staged scoring run →
// result (ring gauge hero, grouped dimension bars, ROAS band, numbered tips,
// beating variants). Re-implemented with Polaris; behavior (manual + Meta
// sources, copy/image generation, push-to-Meta) is unchanged.
import { useEffect, useState, type ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  FormLayout,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { getLatestRun, listRuns, saveVariants } from "~/lib/screener/runs.server";
import { listScreenableAds, fetchCreativeInput } from "~/lib/screener/meta-creative.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  METRIC_GROUPS,
  METRIC_GROUP_LABELS,
  MIN_SPEND_CENTS,
  type CreativeInput,
  type CreativeScreenRun,
  type Grade,
  type MetricGroup,
  type ScoreCard,
  type ScreenableAd,
  type Variant,
} from "~/lib/screener/types";
import { getAnthropic, assistantModel } from "~/lib/assistant/anthropic.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { pickGenerator } from "~/lib/screener/pick-generator.server";
import { pushVariantToMeta, type PushResult } from "~/lib/screener/meta-push.server";
import { metaClientForShop } from "~/lib/meta/client.server";
import { checkAndReserveImageGen } from "~/lib/screener/image-gen-limit.server";
import { loadCalibrationInputs } from "~/lib/screener/history.server";
import { scoreCreative, type CreateMessageFn } from "~/lib/screener/score.server";
import { calibrate } from "~/lib/screener/calibrate.server";

// clampSpend: if raw is absent/empty/NaN → return DEFAULT.
// Any parseable number (including 0) is clamped to [MIN, MAX].
// This means clampSpend("0") === MIN (1000), clampSpend(null) === DEFAULT (50000).
export function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return DEFAULT_SPEND_CENTS;
  }
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export function parseCreativeForm(form: FormData): CreativeInput {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const imageUrl = str("imageUrl");
  return {
    imageUrl: imageUrl || null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
}

export function isMetaSubmit(form: FormData): { metaAdId: string } | null {
  if (String(form.get("source") ?? "") !== "meta_ad") return null;
  const metaAdId = String(form.get("metaAdId") ?? "").trim();
  return metaAdId ? { metaAdId } : null;
}

type LoaderPayload = {
  latest: CreativeScreenRun | null;
  history: CreativeScreenRun[];
  metaAds: ScreenableAd[];
  imageGenAvailable: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history, metaAds] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
    listScreenableAds(session.shop).catch(() => [] as ScreenableAd[]),
  ]);
  const imageGenAvailable =
    Boolean(process.env.HIGGSFIELD_API_KEY) && Boolean(process.env.HIGGSFIELD_API_SECRET);
  return json<LoaderPayload>({ latest, history, metaAds, imageGenAvailable });
};

function pushFail(error: string): PushResult {
  return { ok: false, adId: null, alreadyPushed: false, error };
}

function imageLimitMessage(r: { scope: "shop" | "global"; limit: number }): string {
  return r.scope === "shop"
    ? `You've hit today's image limit (${r.limit}/day). It resets tomorrow — or generate copy variations instead.`
    : "Image generation is at capacity right now. Try again shortly, or generate copy variations.";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  if (String(form.get("intent") ?? "") === "generate") {
    const latest = await getLatestRun(session.shop);
    if (!latest || latest.status !== "done" || !latest.scorecard || !latest.creativeInput) {
      return json({ generateError: "Screen an ad first, then generate improvements." });
    }
    const original = latest.creativeInput;
    const calib = await loadCalibrationInputs(session.shop, null);
    const createMessage: CreateMessageFn = (p) => getAnthropic().messages.create(p);
    const scoreOne = async (input: CreativeInput) => {
      const scored = await scoreCreative(input, calib.topAdNames, { createMessage, model: assistantModel() });
      const { composite } = calibrate(scored.metrics, calib, latest.assumedSpendCents);
      return { composite, summary: scored.summary, metrics: scored.metrics };
    };
    const mode = String(form.get("mode") ?? "copy");
    if (mode === "image") {
      const reservation = await checkAndReserveImageGen(session.shop);
      if (!reservation.ok) {
        return json({ generateError: imageLimitMessage(reservation) });
      }
    }
    const generator = pickGenerator(mode, { createMessage, model: assistantModel() });
    const result = await generateImprovements(
      {
        original,
        originalScorecard: latest.scorecard,
        styleRefs: calib.topAdNames,
        count: mode === "image" ? 1 : undefined,
      },
      { generator, scoreOne },
    );
    const saved = await saveVariants(latest.id, result.variants);
    return json(saved);
  }

  if (String(form.get("intent") ?? "") === "push") {
    const variantIndex = Number(form.get("variantIndex"));
    const latest = await getLatestRun(session.shop);
    if (!latest) {
      return json({ push: pushFail("Nothing to push yet — screen and generate first.") });
    }
    const conn = await metaClientForShop(session.shop);
    if (!conn) return json({ push: pushFail("Connect your Meta account first.") });
    const push = await pushVariantToMeta(
      { shop: session.shop, run: latest, variantIndex },
      { client: conn.client, adAccountId: conn.adAccountId },
    );
    return json({ push });
  }

  const assumedSpendCents = clampSpend(form.get("assumedSpendCents"));
  const meta = isMetaSubmit(form);
  if (meta) {
    let input;
    try {
      input = await fetchCreativeInput(session.shop, meta.metaAdId);
    } catch (err) {
      // Meta read can fail if the connection was revoked between page load and
      // submit — surface it in the in-app banner like every other failure
      // (rule 12) instead of crashing to Remix's error boundary.
      const message = err instanceof Error ? err.message : String(err);
      return json({
        id: "", status: "error", source: "meta_ad", metaAdId: meta.metaAdId,
        assumedSpendCents, scorecard: null, error: message,
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        creativeInput: null, variants: [],
      } satisfies CreativeScreenRun);
    }
    const run = await executeScreen({
      shop: session.shop, input, assumedSpendCents, source: "meta_ad", metaAdId: meta.metaAdId,
    });
    return json(run);
  }
  const input = parseCreativeForm(form);
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json(run);
};

const gradeTone: Record<Grade, "success" | "warning" | "critical"> = {
  winning: "success",
  okay: "warning",
  poor: "critical",
};

const gradeLabel: Record<Grade, string> = {
  winning: "Winning",
  okay: "Okay",
  poor: "Poor",
};

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`;

// Staged scoring run copy (mirrors the dashboard Predictor's SCORE_STEPS).
const SCORE_STEPS = [
  "Reading creative…",
  "Calibrating against your account history…",
  "Scoring 13 dimensions…",
  "Mapping to SKU economics…",
  "Predicting outcomes…",
];

type Phase = "form" | "running" | "result";

// Score → color, matching the dashboard thresholds (≥70 green / ≥50 orange / red).
const scoreColor = (score: number) =>
  score >= 70
    ? "var(--p-color-bg-fill-success)"
    : score >= 50
      ? "var(--p-color-bg-fill-caution)"
      : "var(--p-color-bg-fill-critical)";

const GRAY_BG = "var(--p-color-bg-surface-secondary)";
const ACCENT = "var(--p-color-text-emphasis)";

function CheckMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 10.5l3.5 3.5L15 7"
        stroke="var(--p-color-text-success)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ---------- Ring gauge for the composite score (dashboard RingGauge) ---------- */
function RingGauge({ value, size = 120 }: { value: number; size?: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(value), 120);
    return () => clearTimeout(t);
  }, [value]);
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={GRAY_BG} strokeWidth="8" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={scoreColor(value)}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: size * 0.26, fontWeight: 700, letterSpacing: "-0.02em" }}>
          {value}
        </span>
        <Text as="span" variant="bodySm" tone="subdued">
          composite
        </Text>
      </div>
    </div>
  );
}

/* ---------- Horizontal score bar (dashboard ScoreBar) ---------- */
function ScoreBar({ score }: { score: number }) {
  const [v, setV] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setV(score), 100);
    return () => clearTimeout(t);
  }, [score]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%" }}>
      <div style={{ flex: 1, height: 5, borderRadius: 99, background: GRAY_BG, overflow: "hidden" }}>
        <div
          style={{
            width: `${v}%`,
            height: "100%",
            borderRadius: 99,
            background: scoreColor(score),
            transition: "width 0.8s cubic-bezier(0.22,1,0.36,1)",
          }}
        />
      </div>
      <span style={{ width: 26, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        <Text as="span" variant="bodySm" fontWeight="semibold">
          {score}
        </Text>
      </span>
    </div>
  );
}

/* ---------- 13-dimension scorecard, grouped (dashboard GroupScores) ---------- */
function GroupScores({ metrics }: { metrics: ScoreCard["metrics"] }) {
  return (
    <BlockStack gap="500">
      {METRIC_GROUPS.map((g: MetricGroup) => {
        const ms = metrics.filter((m) => m.group === g);
        if (ms.length === 0) return null;
        const avg = Math.round(ms.reduce((s, m) => s + m.score, 0) / ms.length);
        return (
          <BlockStack key={g} gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingXs">
                {METRIC_GROUP_LABELS[g]}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                avg {avg}
              </Text>
            </InlineStack>
            <BlockStack gap="300">
              {ms.map((m) => (
                <BlockStack key={m.id} gap="050">
                  <Text as="span" variant="bodySm" fontWeight="medium">
                    {m.label}
                  </Text>
                  <ScoreBar score={m.score} />
                  <Text as="p" variant="bodySm" tone="subdued">
                    {m.reasoning || "No reasoning provided."}
                    {m.benchmarkAds && m.benchmarkAds.length > 0
                      ? ` Compared against: ${m.benchmarkAds.join(", ")}.`
                      : ""}
                  </Text>
                </BlockStack>
              ))}
            </BlockStack>
          </BlockStack>
        );
      })}
    </BlockStack>
  );
}

/* ---------- Mini stat tile (dashboard .cd-mini-stat) ---------- */
function MiniStat({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <div
      style={{
        background: GRAY_BG,
        borderRadius: 10,
        padding: "9px 11px",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        minWidth: 0,
      }}
    >
      <Text as="span" variant="bodyMd" fontWeight="semibold">
        {value}
      </Text>
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
    </div>
  );
}

/* ---------- Predicted outcomes: ROAS band + mini-stats (dashboard OutcomePanel) ---------- */
function OutcomePanel({ o }: { o: ScoreCard["outcomes"] }) {
  const above = o.estimatedRoas >= o.breakEvenRoas;
  const span = o.roasHigh - o.roasLow || 1;
  const clampPct = (x: number) => Math.min(100, Math.max(0, x));
  const markerLeft = clampPct(((o.estimatedRoas - o.roasLow) / span) * 100);
  const beLeft = clampPct(((o.breakEvenRoas - o.roasLow) / span) * 100);
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingSm">
          Predicted outcomes
        </Text>
        <div>
          <InlineStack align="space-between">
            <Text as="span" variant="bodySm" tone="subdued">
              {o.roasLow.toFixed(1)}×
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              est. ROAS range
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {o.roasHigh.toFixed(1)}×
            </Text>
          </InlineStack>
          <div
            style={{
              position: "relative",
              height: 8,
              borderRadius: 99,
              background: GRAY_BG,
              margin: "32px 0 4px",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 99,
                background: "linear-gradient(90deg, rgba(255,59,48,0.25), rgba(52,199,89,0.3))",
              }}
            />
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: `${markerLeft}%`,
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: ACCENT,
                border: "3px solid var(--p-color-bg-surface)",
                boxShadow: "0 1px 5px rgba(0,0,0,0.2)",
                transform: "translate(-50%, -50%)",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: -26,
                  left: "50%",
                  transform: "translateX(-50%)",
                  fontSize: 12.5,
                  fontWeight: 650,
                  color: ACCENT,
                  whiteSpace: "nowrap",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {o.estimatedRoas.toFixed(1)}×
              </span>
            </div>
            <div
              title={`Break-even ${o.breakEvenRoas.toFixed(1)}×`}
              style={{
                position: "absolute",
                top: -5,
                left: `${beLeft}%`,
                width: 2,
                height: 18,
                background: "var(--p-color-text-secondary)",
                borderRadius: 1,
              }}
            />
          </div>
          <Text as="p" variant="bodySm" tone={above ? "success" : "critical"}>
            {above ? "Above" : "Below"} your {o.breakEvenRoas.toFixed(1)}× break-even
          </Text>
        </div>
        <InlineGrid columns={2} gap="200">
          <MiniStat value={pct(o.predictedCtr)} label="predicted CTR" />
          <MiniStat value={pct(o.holdRate)} label="hold rate" />
          <MiniStat
            value={dollars(o.predictedRevenueCents)}
            label={`est. revenue @ ${dollars(o.assumedSpendCents)}`}
          />
          <MiniStat
            value={o.mappedSku ?? "No SKU"}
            label={
              o.mappedSku
                ? `mapped SKU${o.skuPriceCents ? ` · ${dollars(o.skuPriceCents)}` : ""}`
                : "no mapped SKU — using category averages"
            }
          />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

export default function Screener() {
  const { latest, history, metaAds, imageGenAvailable } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  // The generate action may return a run DTO or a { generateError } — only treat
  // it as a run when it actually is one, so an error doesn't clobber the display.
  const data = fetcher.data;
  const run: CreativeScreenRun | null =
    data && typeof data === "object" && "status" in data ? (data as CreativeScreenRun) : latest;
  const generateError =
    data && typeof data === "object" && "generateError" in data
      ? (data as { generateError?: string }).generateError
      : undefined;
  const busy = fetcher.state !== "idle";
  const intent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const scoring = busy && intent === "";
  const generating = busy && intent === "generate";
  const card = run?.scorecard ?? null;

  // A separate fetcher so a push never overwrites the screened/generated run display.
  const pushFetcher = useFetcher<typeof action>();
  const pushResult = (pushFetcher.data as { push?: PushResult } | undefined)?.push;
  const pushing = pushFetcher.state !== "idle";
  const [pushTarget, setPushTarget] = useState<number | null>(null);

  const [spend, setSpend] = useState<string>(
    String((latest?.assumedSpendCents ?? DEFAULT_SPEND_CENTS) / 100),
  );
  const [genMode, setGenMode] = useState<"copy" | "image">("copy");
  const hasMetaAds = metaAds.length > 0;

  // form → running (staged steps) → result, mirroring the dashboard Predictor.
  const [phase, setPhase] = useState<Phase>(latest?.scorecard ? "result" : "form");
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (scoring) {
      setPhase("running");
      setStep(0);
    }
  }, [scoring]);
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    const d = fetcher.data;
    if (d && typeof d === "object" && "status" in d) {
      const r = d as CreativeScreenRun;
      // Require a scorecard, not just status, so a malformed "done" run can't
      // strand the page on an empty result phase.
      setPhase(r.status === "done" && r.scorecard ? "result" : "form");
    }
  }, [fetcher.state, fetcher.data]);
  // Advance the staged copy while the real score request is in flight; the last
  // step holds until the action returns (scoring genuinely takes ~20–30s).
  useEffect(() => {
    if (phase !== "running" || step >= SCORE_STEPS.length - 1) return;
    const t = setTimeout(() => setStep((s) => s + 1), 3500 + Math.random() * 1500);
    return () => clearTimeout(t);
  }, [phase, step]);

  useEffect(() => {
    const d = fetcher.data as CreativeScreenRun | undefined;
    if (d?.assumedSpendCents) setSpend(String(d.assumedSpendCents / 100));
  }, [fetcher.data]);

  const spendCents = String(Math.round(Number(spend || 0) * 100));
  const heroTitle =
    run?.creativeInput?.headline || (run?.source === "meta_ad" ? "Meta ad" : "Your ad");

  return (
    <Page
      title="Ad Pre-Screen"
      subtitle="Score an ad before you spend — calibrated to your account history and SKU economics."
      primaryAction={
        phase === "result"
          ? { content: "Screen another", onAction: () => setPhase("form") }
          : undefined
      }
    >
      <BlockStack gap="500">
        {run?.status === "error" && phase !== "running" && (
          <Banner tone="critical" title="Couldn't score this ad">
            <p>{run.error}</p>
          </Banner>
        )}

        {phase === "form" && (
          <InlineGrid columns={{ xs: "1fr", md: "1.7fr 1fr" }} gap="400" alignItems="start">
            <Card>
              <fetcher.Form method="post">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingSm">
                    Creative
                  </Text>
                  <FormLayout>
                    <TextField
                      label="Headline"
                      name="headline"
                      autoComplete="off"
                      helpText="The bold one-liner that grabs attention at the top of the ad."
                    />
                    <TextField
                      label="Primary text"
                      name="primaryText"
                      multiline={3}
                      autoComplete="off"
                      helpText="The longer copy that sits below the headline."
                    />
                    <FormLayout.Group>
                      <TextField
                        label="Call to action"
                        name="cta"
                        autoComplete="off"
                        placeholder="Shop now"
                        helpText="What the click button says."
                      />
                      <TextField
                        label="Assumed spend (USD)"
                        type="number"
                        autoComplete="off"
                        value={spend}
                        onChange={setSpend}
                        helpText="Drives the ROAS estimate."
                      />
                    </FormLayout.Group>
                    <TextField
                      label="Audience"
                      name="audience"
                      autoComplete="off"
                      placeholder="Women 25–44 interested in skincare"
                      helpText="One-line description of who it targets."
                    />
                    <FormLayout.Group>
                      <TextField
                        label="Where the click goes"
                        name="destinationUrl"
                        autoComplete="off"
                        placeholder="https://yourstore.com/products/..."
                        helpText="The product or landing page URL."
                      />
                      <TextField
                        label="Image link (optional)"
                        name="imageUrl"
                        autoComplete="off"
                        placeholder="https://…/creative.jpg"
                        helpText="We'll score the visual too."
                      />
                    </FormLayout.Group>
                    <input type="hidden" name="assumedSpendCents" value={spendCents} />
                    <InlineStack gap="300" blockAlign="center">
                      <Button submit variant="primary" loading={scoring} disabled={busy}>
                        Score creative
                      </Button>
                      <Text as="span" variant="bodySm" tone="subdued">
                        ~20 seconds · uses your ad history
                      </Text>
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </fetcher.Form>
            </Card>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingSm">
                  Or pick a live ad
                </Text>
                {hasMetaAds ? (
                  <>
                    <BlockStack gap="200">
                      {metaAds.map((ad) => (
                        <Button
                          key={ad.id}
                          fullWidth
                          textAlign="left"
                          disabled={busy}
                          onClick={() =>
                            fetcher.submit(
                              {
                                source: "meta_ad",
                                metaAdId: ad.id,
                                assumedSpendCents: spendCents,
                              },
                              { method: "post" },
                            )
                          }
                        >
                          {ad.name}
                        </Button>
                      ))}
                    </BlockStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Paused ads pulled from Meta — scoring uses their real creative and
                      targeting, at the spend entered on the left.
                    </Text>
                  </>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Connect your Meta account to score a paused ad&apos;s real creative and
                    targeting.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </InlineGrid>
        )}

        {phase === "running" && (
          <Card>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 32,
                flexWrap: "wrap",
                padding: "60px 24px",
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  background: GRAY_BG,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Spinner size="large" accessibilityLabel="Scoring your ad" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 300 }}>
                {SCORE_STEPS.map((s, i) => (
                  <div
                    key={s}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      opacity: i <= step ? 1 : 0.35,
                      transition: "opacity 0.3s",
                    }}
                  >
                    {i < step ? (
                      <CheckMark />
                    ) : i === step ? (
                      <Spinner size="small" />
                    ) : (
                      <span style={{ width: 15 }} />
                    )}
                    <Text as="span" variant="bodyMd">
                      {s}
                    </Text>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        {phase === "result" && card && (
          <>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="600" blockAlign="center" wrap>
                  {run?.creativeInput?.imageUrl && (
                    <img
                      src={run.creativeInput.imageUrl}
                      alt="Ad creative"
                      style={{
                        width: 120,
                        height: 120,
                        objectFit: "cover",
                        borderRadius: 14,
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <RingGauge value={card.composite} />
                  <div style={{ minWidth: 240, flex: 1 }}>
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Text as="h2" variant="headingMd">
                        {heroTitle}
                      </Text>
                      <Badge tone={gradeTone[card.grade]}>{gradeLabel[card.grade]}</Badge>
                      <Badge>{`confidence: ${card.confidence}`}</Badge>
                    </InlineStack>
                    <Box paddingBlockStart="150">
                      <Text as="p">{card.summary}</Text>
                    </Box>
                  </div>
                </InlineStack>
                {card.confidence === "low" && (
                  <Banner tone="warning" title="Low-confidence estimate">
                    <p>
                      We don&apos;t have enough sales history for this product yet, so the
                      numbers below use category averages. Treat them as a directional read,
                      not a forecast.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <InlineGrid columns={{ xs: "1fr", md: "1.7fr 1fr" }} gap="400" alignItems="start">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingSm">
                      13 dimensions
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      scored 0–100 with reasoning
                    </Text>
                  </InlineStack>
                  <GroupScores metrics={card.metrics} />
                </BlockStack>
              </Card>

              <BlockStack gap="400">
                <OutcomePanel o={card.outcomes} />

                {card.tips.length > 0 && (
                  <Card>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingSm">
                        How to improve it
                      </Text>
                      {card.tips.map((tip, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <span
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: "50%",
                              flexShrink: 0,
                              marginTop: 1,
                              background: GRAY_BG,
                              color: ACCENT,
                              fontSize: 11.5,
                              fontWeight: 650,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                            }}
                          >
                            {i + 1}
                          </span>
                          <Text as="p" variant="bodySm">
                            {tip}
                          </Text>
                        </div>
                      ))}
                    </BlockStack>
                  </Card>
                )}

                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingSm">
                      Generated variants that beat it
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Calderyn rewrites your ad targeting its weak spots, scores each rewrite,
                      and only shows ones that beat the original.
                    </Text>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="generate" />
                      <input type="hidden" name="mode" value={genMode} />
                      <InlineStack gap="200" blockAlign="center">
                        <ButtonGroup variant="segmented">
                          <Button pressed={genMode === "copy"} onClick={() => setGenMode("copy")}>
                            Rewrite copy
                          </Button>
                          <Button
                            pressed={genMode === "image"}
                            disabled={!imageGenAvailable}
                            onClick={() => setGenMode("image")}
                          >
                            New image
                          </Button>
                        </ButtonGroup>
                        <Button submit variant="primary" loading={generating} disabled={busy}>
                          Generate
                        </Button>
                      </InlineStack>
                    </fetcher.Form>
                    {generateError && <Banner tone="warning">{generateError}</Banner>}
                    {pushResult && (
                      <Banner tone={pushResult.ok ? "success" : "critical"}>
                        {pushResult.ok
                          ? `Created a paused ad${pushResult.adId ? ` (${pushResult.adId})` : ""}${pushResult.alreadyPushed ? " — already pushed earlier" : ""}. Review it in Meta Ads Manager before activating.`
                          : pushResult.error}
                      </Banner>
                    )}
                    {!imageGenAvailable && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        Image generation isn&apos;t connected yet. Copy rewrites still work.
                      </Text>
                    )}
                    {(run?.variants ?? []).length === 0 ? (
                      <Text as="p" tone="subdued" variant="bodySm">
                        No rewrites yet — click Generate above to try a few.
                      </Text>
                    ) : (
                      (run?.variants ?? []).map((v: Variant, i: number) => (
                        <div
                          key={i}
                          style={{ background: GRAY_BG, borderRadius: 12, padding: "12px 14px" }}
                        >
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone="info">{v.mode}</Badge>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {v.composite}
                            </Text>
                            <Text as="span" variant="bodySm" tone="success">
                              {`+${v.delta}`}
                            </Text>
                            <span style={{ marginLeft: "auto" }}>
                              <Text as="span" variant="bodySm" tone="subdued">
                                vs original
                              </Text>
                            </span>
                          </InlineStack>
                          <Box paddingBlockStart="150">
                            <Text as="p" variant="bodyMd">
                              &ldquo;{v.input.headline}&rdquo; · CTA: {v.input.cta}
                            </Text>
                          </Box>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {v.input.primaryText}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {v.rationale}
                          </Text>
                          {run?.source === "meta_ad" && (
                            <Box paddingBlockStart="200">
                              <Button onClick={() => setPushTarget(i)} disabled={pushing}>
                                Save to Meta as paused ad
                              </Button>
                            </Box>
                          )}
                        </div>
                      ))
                    )}
                    <Modal
                      open={pushTarget !== null}
                      onClose={() => setPushTarget(null)}
                      title="Push this variant to Meta?"
                      primaryAction={{
                        content: "Create paused ad",
                        loading: pushing,
                        onAction: () => {
                          if (pushTarget !== null) {
                            pushFetcher.submit(
                              { intent: "push", variantIndex: String(pushTarget) },
                              { method: "post" },
                            );
                          }
                          setPushTarget(null);
                        },
                      }}
                      secondaryActions={[{ content: "Cancel", onAction: () => setPushTarget(null) }]}
                    >
                      <Modal.Section>
                        <Text as="p" variant="bodyMd">
                          This creates a new <Text as="span" fontWeight="semibold">paused</Text>{" "}
                          ad in the source ad&apos;s ad set. It won&apos;t spend until you
                          activate it in Meta Ads Manager.
                        </Text>
                      </Modal.Section>
                    </Modal>
                  </BlockStack>
                </Card>
              </BlockStack>
            </InlineGrid>
          </>
        )}

        {history.length > 0 && (
          <Text as="p" tone="subdued" variant="bodySm">
            {history.length} previously scored ad{history.length === 1 ? "" : "s"} on record.
          </Text>
        )}
      </BlockStack>
    </Page>
  );
}
