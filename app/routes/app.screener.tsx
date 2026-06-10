// app/routes/app.screener.tsx
// NOTE: do NOT add `export const config = { maxDuration: ... }` here. With
// v3_singleFetch, a per-route config makes @vercel/remix split this route into its
// own serverless function that does NOT serve the single-fetch `/app/screener.data`
// path — so client-side nav 404s while the full page load works. If the live (Claude)
// path later needs a longer timeout, set it for the whole server function in
// vercel.json, not per-route.
import { useEffect, useState } from "react";
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
  Collapsible,
  Divider,
  FormLayout,
  InlineGrid,
  InlineStack,
  Modal,
  Page,
  ProgressBar,
  Tabs,
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

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (frac: number) => `${(frac * 100).toFixed(1)}%`;

function MetricRow({ m }: { m: ScoreCard["metrics"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <Box>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((o) => !o);
        }}
        style={{ cursor: "pointer" }}
        aria-expanded={open}
      >
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm">
            {open ? "▾" : "▸"} {m.label}
          </Text>
          <Text as="span" variant="bodySm" fontWeight="semibold">
            {m.score}
          </Text>
        </InlineStack>
        <Box paddingBlockStart="100">
          <ProgressBar progress={m.score} size="small" />
        </Box>
      </div>
      <Collapsible open={open} id={`metric-${m.id}`}>
        <Box paddingBlockStart="200" paddingInlineStart="200">
          <Text as="p" variant="bodySm" tone="subdued">
            {m.reasoning || "No reasoning provided."}
          </Text>
          {m.benchmarkAds && m.benchmarkAds.length > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">
              Compared against: {m.benchmarkAds.join(", ")}
            </Text>
          )}
        </Box>
      </Collapsible>
    </Box>
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
  const running = fetcher.state !== "idle";
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasMetaAds = metaAds.length > 0;
  const [sourceTab, setSourceTab] = useState(0);
  const tabs = hasMetaAds
    ? [
        {
          id: "draft",
          content: "Score a draft",
          accessibilityLabel: "Score an ad you're drafting",
          panelID: "screener-draft-panel",
        },
        {
          id: "meta",
          content: "Score a paused Meta ad",
          accessibilityLabel: "Score a paused ad from your Meta account",
          panelID: "screener-meta-panel",
        },
      ]
    : [
        {
          id: "draft",
          content: "Score a draft",
          accessibilityLabel: "Score an ad you're drafting",
          panelID: "screener-draft-panel",
        },
      ];
  useEffect(() => {
    const d = fetcher.data as CreativeScreenRun | undefined;
    if (d?.assumedSpendCents)
      setSpend(String(d.assumedSpendCents / 100));
  }, [fetcher.data]);

  return (
    <Page
      title="Ad Pre-Screen"
      subtitle="Score an ad before you spend money on it — paste in a draft, get a 0–100 grade and the exact fixes."
    >
      <BlockStack gap="500">
        {!card && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingSm">How this works</Text>
              <Box paddingInlineStart="200">
                <ol style={{ margin: 0, paddingInlineStart: 18 }}>
                  <li>
                    <Text as="span" variant="bodySm">
                      Drop in your ad's headline, body copy, and (optionally) an image link.
                    </Text>
                  </li>
                  <li>
                    <Text as="span" variant="bodySm">
                      Calderyn scores it 0–100 against your top-performing ads.
                    </Text>
                  </li>
                  <li>
                    <Text as="span" variant="bodySm">
                      You get a verdict, the top fixes, and (optionally) better versions to try.
                    </Text>
                  </li>
                </ol>
              </Box>
            </BlockStack>
          </Card>
        )}

        <Card padding="0">
          <Tabs tabs={tabs} selected={sourceTab} onSelect={setSourceTab} />
          <Box padding="400">
            {sourceTab === 0 || !hasMetaAds ? (
              <fetcher.Form method="post">
                <FormLayout>
                  <TextField
                    label="Headline"
                    name="headline"
                    autoComplete="off"
                    helpText="The bold one-liner that grabs attention at the top of the ad."
                  />
                  <TextField
                    label="Body text"
                    name="primaryText"
                    multiline={3}
                    autoComplete="off"
                    helpText="The longer copy that sits below the headline."
                  />
                  <FormLayout.Group>
                    <TextField
                      label="Button text"
                      name="cta"
                      autoComplete="off"
                      placeholder="Shop now"
                      helpText="What the click button says."
                    />
                    <TextField
                      label="Where the click goes"
                      name="destinationUrl"
                      autoComplete="off"
                      placeholder="https://yourstore.com/products/..."
                      helpText="The product or landing page URL."
                    />
                  </FormLayout.Group>
                  <TextField
                    label="Who's it targeting?"
                    name="audience"
                    autoComplete="off"
                    placeholder="Women 25–44 interested in skincare"
                    helpText="One-line description of the audience."
                  />
                  <TextField
                    label="Image link (optional)"
                    name="imageUrl"
                    autoComplete="off"
                    placeholder="https://…/creative.jpg"
                    helpText="Paste the link to your ad creative — we'll score the visual too."
                  />
                  <TextField
                    label="How much would you spend on this ad? (USD)"
                    type="number"
                    autoComplete="off"
                    value={spend}
                    onChange={setSpend}
                    helpText="Drives the ROAS estimate. Edit and re-screen to see the impact."
                  />
                  <input
                    type="hidden"
                    name="assumedSpendCents"
                    value={Math.round(Number(spend || 0) * 100)}
                  />
                  <Button submit variant="primary" loading={running} disabled={running}>
                    Score this ad
                  </Button>
                </FormLayout>
              </fetcher.Form>
            ) : (
              <BlockStack gap="300">
                <Text as="p" tone="subdued" variant="bodySm">
                  These are the paused ads in your connected Meta account. Pick one to
                  score its real creative and targeting.
                </Text>
                <BlockStack gap="200">
                  {metaAds.map((ad) => (
                    <InlineStack key={ad.id} align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="span" variant="bodyMd">{ad.name}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">{ad.effectiveStatus}</Text>
                      </BlockStack>
                      <fetcher.Form method="post">
                        <input type="hidden" name="source" value="meta_ad" />
                        <input type="hidden" name="metaAdId" value={ad.id} />
                        <input type="hidden" name="assumedSpendCents" value={Math.round(Number(spend || 0) * 100)} />
                        <Button submit loading={running} disabled={running}>Score this ad</Button>
                      </fetcher.Form>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            )}
          </Box>
        </Card>

        {running && !card && (
          <Card>
            <Text as="p" tone="subdued">
              Scoring your ad… this usually takes 20–30 seconds.
            </Text>
          </Card>
        )}

        {run?.status === "error" && (
          <Banner tone="critical" title="Couldn't score this ad">
            <p>{run.error}</p>
          </Banner>
        )}

        {card && (
          <>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="400" blockAlign="center" wrap={false}>
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="baseline">
                      <Text as="span" variant="heading2xl">
                        {card.composite}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        out of 100
                      </Text>
                    </InlineStack>
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={gradeTone[card.grade]}>{card.grade}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Confidence: {card.confidence}
                        {card.confidence === "low" ? " — limited history" : ""}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </InlineStack>
                <Text as="p">
                  {card.summary}
                </Text>
                {card.confidence === "low" && (
                  <Banner tone="warning" title="Low-confidence estimate">
                    <p>
                      We don't have enough sales history for this product yet, so the numbers below use
                      category averages. Treat them as a directional read, not a forecast.
                    </p>
                  </Banner>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingSm">
                    What this ad would likely do
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Based on the score, your spend assumption, and how your past ads performed.
                  </Text>
                </BlockStack>
                <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Estimated ROAS
                    </Text>
                    <Text as="p" variant="headingLg">
                      {card.outcomes.estimatedRoas}x
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      range {card.outcomes.roasLow}–{card.outcomes.roasHigh}x · break-even{" "}
                      {card.outcomes.breakEvenRoas}x
                    </Text>
                  </Box>
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Click-through rate
                    </Text>
                    <Text as="p" variant="headingLg">
                      {pct(card.outcomes.predictedCtr)}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      share of viewers who'll click
                    </Text>
                  </Box>
                  <Box>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Viewer hold
                    </Text>
                    <Text as="p" variant="headingLg">
                      {pct(card.outcomes.holdRate)}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      share who watch past 3 seconds
                    </Text>
                  </Box>
                </InlineGrid>
                <Text as="span" variant="bodySm" tone="subdued">
                  Based on{" "}
                  {card.outcomes.mappedSku ? `SKU ${card.outcomes.mappedSku}` : "no mapped SKU"}
                  {card.outcomes.skuPriceCents
                    ? ` @ ${dollars(card.outcomes.skuPriceCents)}`
                    : ""}{" "}
                  · assumed spend {dollars(card.outcomes.assumedSpendCents)} · projected revenue{" "}
                  {dollars(card.outcomes.predictedRevenueCents)}
                </Text>
              </BlockStack>
            </Card>

            {card.tips.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">
                    Top fixes
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    The highest-impact changes you can make before going live.
                  </Text>
                  <ol style={{ margin: 0, paddingInlineStart: 18 }}>
                    {card.tips.map((t, i) => (
                      <li key={i}>
                        <Text as="span" variant="bodySm">
                          {t}
                        </Text>
                      </li>
                    ))}
                  </ol>
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="200">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((o) => !o)}
                  aria-expanded={detailsOpen}
                  aria-controls="screener-breakdown"
                  style={{
                    all: "unset",
                    cursor: "pointer",
                    display: "block",
                    width: "100%",
                  }}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text as="h2" variant="headingSm">
                        See the details
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Per-metric scores across hook, message, design, and offer.
                      </Text>
                    </BlockStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {detailsOpen ? "Hide ▴" : "Show ▾"}
                    </Text>
                  </InlineStack>
                </button>
                <Collapsible open={detailsOpen} id="screener-breakdown">
                  <Box paddingBlockStart="300">
                    <BlockStack gap="400">
                      {METRIC_GROUPS.map((g: MetricGroup) => {
                        const rows = card.metrics.filter((m) => m.group === g);
                        if (rows.length === 0) return null;
                        return (
                          <BlockStack key={g} gap="200">
                            <Text as="h3" variant="headingXs">
                              {METRIC_GROUP_LABELS[g]}
                            </Text>
                            {rows.map((m) => (
                              <MetricRow key={m.id} m={m} />
                            ))}
                            <Divider />
                          </BlockStack>
                        );
                      })}
                    </BlockStack>
                  </Box>
                </Collapsible>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingSm">Try better versions</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Calderyn rewrites your ad targeting its weak spots, scores each rewrite, and only shows ones that beat the original.
                    </Text>
                  </BlockStack>
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
                      <Button submit variant="primary" loading={running} disabled={running}>
                        Generate
                      </Button>
                    </InlineStack>
                  </fetcher.Form>
                </InlineStack>
                {generateError && (
                  <Banner tone="warning">{generateError}</Banner>
                )}
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
                    <Box key={i} padding="300" borderColor="border" borderBlockStartWidth="025">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">{v.input.headline}</Text>
                        <Badge tone="success">{`${v.composite} (+${v.delta} vs original)`}</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodySm">{v.input.primaryText}</Text>
                      <Text as="p" variant="bodySm" tone="subdued">Button: {v.input.cta} · {v.rationale}</Text>
                      {run?.source === "meta_ad" && (
                        <Box paddingBlockStart="200">
                          <Button onClick={() => setPushTarget(i)} disabled={pushing}>
                            Save to Meta as paused ad
                          </Button>
                        </Box>
                      )}
                    </Box>
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
                      This creates a new <Text as="span" fontWeight="semibold">paused</Text> ad in
                      the source ad&apos;s ad set. It won&apos;t spend until you activate it in Meta
                      Ads Manager.
                    </Text>
                  </Modal.Section>
                </Modal>
              </BlockStack>
            </Card>
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
