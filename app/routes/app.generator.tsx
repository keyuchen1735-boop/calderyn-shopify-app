// app/routes/app.generator.tsx
// Ad Generator — mirrors the Calderyn dashboard's Generator screen
// (app/components/dashboard/screens/Generator.tsx): the latest pre-screen's
// critique becomes a remake brief, Higgsfield renders it, and every remake is
// re-scored by the same gate before it's shown. Images only for now — the
// scorer is vision-over-image, so video/carousel can't be re-scored yet.
// NOTE: no per-route `export const config` here (see app.screener.tsx).
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useEmbeddedNavigate } from "~/lib/embedded-nav";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getLatestRun, saveVariants } from "~/lib/screener/runs.server";
import { generateImprovements } from "~/lib/screener/generate.server";
import { imageGenerator, higgsfieldImageClient } from "~/lib/screener/higgsfield.server";
import {
  reserveImageGenSlots,
  releaseImageGen,
} from "~/lib/screener/image-gen-limit.server";
import { gateScoreDeps } from "~/lib/screener/score-one.server";
import type {
  CreativeScreenRun,
  MetricScore,
  ScoreCard,
  Variant,
} from "~/lib/screener/types";

/** Style presets — prompt fragments, not Higgsfield style ids (no API dependency). */
export const GENERATOR_STYLES = {
  studio: {
    label: "Studio product",
    prompt:
      "Studio product photography — clean seamless backdrop, controlled soft lighting, crisp product-true colors",
  },
  ugc: {
    label: "UGC handheld",
    prompt:
      "UGC handheld phone-camera feel — natural light, candid framing, authentic creator energy",
  },
  cinematic: {
    label: "Cinematic",
    prompt:
      "Cinematic lifestyle shot — dramatic golden-hour lighting, shallow depth of field, film-grade color",
  },
} as const;
export type GeneratorStyle = keyof typeof GENERATOR_STYLES;

/** Aspect labels → the platform API's accepted aspect_ratio values. */
export const GENERATOR_ASPECTS = {
  "1:1": "1:1",
  "3:4": "3:4",
  "9:16": "9:16",
} as const;
export type GeneratorAspect = keyof typeof GENERATOR_ASPECTS;

const EXTRA_DIRECTION_MAX = 500;

export function parseGeneratorForm(form: FormData): {
  style: GeneratorStyle;
  aspect: GeneratorAspect;
  count: 1 | 4;
  extraDirection: string;
} {
  const styleRaw = String(form.get("style") ?? "");
  const aspectRaw = String(form.get("aspect") ?? "");
  const style: GeneratorStyle = styleRaw in GENERATOR_STYLES ? (styleRaw as GeneratorStyle) : "studio";
  const aspect: GeneratorAspect =
    aspectRaw in GENERATOR_ASPECTS ? (aspectRaw as GeneratorAspect) : "1:1";
  // The generator offers batches of exactly 1 or 4 — anything else falls back to 1.
  const count = String(form.get("count") ?? "") === "4" ? 4 : 1;
  const extraDirection = String(form.get("extraDirection") ?? "")
    .trim()
    .slice(0, EXTRA_DIRECTION_MAX);
  return { style, aspect, count, extraDirection };
}

/** The n weakest dimensions, weakest first — they become the remake brief. */
export function weakestMetrics(card: ScoreCard, n: number): MetricScore[] {
  return [...card.metrics].sort((a, b) => a.score - b.score).slice(0, n);
}

type LoaderPayload = {
  latest: CreativeScreenRun | null;
  imageGenAvailable: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const latest = await getLatestRun(session.shop);
  const usable =
    latest && latest.status === "done" && latest.scorecard && latest.creativeInput ? latest : null;
  const imageGenAvailable =
    Boolean(process.env.HIGGSFIELD_API_KEY) && Boolean(process.env.HIGGSFIELD_API_SECRET);
  return json<LoaderPayload>({ latest: usable, imageGenAvailable });
};

type GenerateResult = {
  remakes: Variant[];
  generated: number;
  baseline: number;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const { style, aspect, count, extraDirection } = parseGeneratorForm(form);

  const latest = await getLatestRun(session.shop);
  if (!latest || latest.status !== "done" || !latest.scorecard || !latest.creativeInput) {
    return json({ generateError: "Screen an ad first — the generator works from its critique." });
  }
  if (!process.env.HIGGSFIELD_API_KEY || !process.env.HIGGSFIELD_API_SECRET) {
    return json({ generateError: "Image generation isn't connected yet (Higgsfield credentials missing)." });
  }

  const reservation = await reserveImageGenSlots(session.shop, count);
  if (!reservation.ok) {
    return json({
      generateError:
        reservation.scope === "shop"
          ? `You've hit today's image limit (${reservation.limit}/day). It resets tomorrow.`
          : "Image generation is at capacity right now. Try again shortly.",
    });
  }

  const { calib, scoreOne } = await gateScoreDeps(session.shop, latest.assumedSpendCents);

  const direction = [GENERATOR_STYLES[style].prompt, extraDirection].filter(Boolean).join(". ");
  const generator = imageGenerator({
    generateImage: higgsfieldImageClient({ aspectRatio: GENERATOR_ASPECTS[aspect] }),
  });

  try {
    const result = await generateImprovements(
      {
        original: latest.creativeInput,
        originalScorecard: latest.scorecard,
        styleRefs: calib.topAdNames,
        count,
        extraDirection: direction,
      },
      { generator, scoreOne },
    );
    // Winners also land on the pre-screen's "variants that beat it" card.
    if (result.variants.length > 0) await saveVariants(session.shop, latest.id, result.variants);
    // Release slots for images that were paid for but never produced.
    const unused = reservation.eventIds.slice(result.generated);
    for (const id of unused) await releaseImageGen(id);
    return json<GenerateResult>({
      remakes: result.allScored,
      generated: result.generated,
      baseline: latest.scorecard.composite,
    });
  } catch (err) {
    // Fail visibly in the in-app banner (rule 12) and refund the quota slots.
    for (const id of reservation.eventIds) await releaseImageGen(id);
    const message = err instanceof Error ? err.message : String(err);
    return json({ generateError: `Couldn't generate remakes: ${message}` });
  }
};

const GRAY_BG = "var(--p-color-bg-surface-secondary)";

function ScoreChip({ score }: { score: number }) {
  return (
    <span
      style={{
        width: "var(--p-space-800)",
        height: "var(--p-space-800)",
        minWidth: "var(--p-space-800)",
        borderRadius: "50%",
        flexShrink: 0,
        background: "var(--p-color-bg-fill-critical-secondary)",
        color: "var(--p-color-text-critical)",
        fontWeight: 650,
        fontSize: 13,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {score}
    </span>
  );
}

export default function Generator() {
  const { latest, imageGenAvailable } = useLoaderData<typeof loader>();
  const navigate = useEmbeddedNavigate();
  const fetcher = useFetcher<typeof action>();
  const generating = fetcher.state !== "idle";
  const data = fetcher.data;
  const result: GenerateResult | null =
    data && typeof data === "object" && "remakes" in data ? (data as GenerateResult) : null;
  const generateError =
    data && typeof data === "object" && "generateError" in data
      ? (data as { generateError?: string }).generateError
      : undefined;

  const [style, setStyle] = useState<GeneratorStyle>("studio");
  const [aspect, setAspect] = useState<GeneratorAspect>("1:1");
  const [count, setCount] = useState<1 | 4>(1);
  const [extra, setExtra] = useState("");

  const card = latest?.scorecard ?? null;
  const weak = card ? weakestMetrics(card, 4) : [];
  const sourceTitle =
    latest?.creativeInput?.headline || (latest?.source === "meta_ad" ? "Meta ad" : "Your ad");

  return (
    <Page
      fullWidth
      title="Ad Generator"
      subtitle="Turns the pre-screen's critique into a remake brief, rendered by Higgsfield and re-scored before you spend."
      backAction={{ content: "Creative Predictor", onAction: () => navigate("/app/screener") }}
    >
      <BlockStack gap="500">
        {!latest || !card ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                Screen an ad first
              </Text>
              <Text as="p" tone="subdued">
                The generator works from your latest pre-screen critique — score an ad and
                come back, the brief builds itself.
              </Text>
              <InlineStack>
                <Button variant="primary" onClick={() => navigate("/app/screener")}>
                  Go to Creative Predictor
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        ) : (
          <>
            {generateError && (
              <Banner tone="warning" title="Couldn't generate remakes">
                <p>{generateError}</p>
              </Banner>
            )}

            <InlineGrid columns={{ xs: "1fr", md: "1.7fr 1fr" }} gap="400" alignItems="start">
              <Card>
                <BlockStack gap="400">
                  <InlineStack gap="400" blockAlign="center" wrap={false}>
                    {latest.creativeInput?.imageUrl ? (
                      <img
                        src={latest.creativeInput.imageUrl}
                        alt="Original ad creative"
                        style={{
                          width: 96,
                          height: 96,
                          objectFit: "cover",
                          borderRadius: 14,
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 96,
                          height: 96,
                          borderRadius: 14,
                          flexShrink: 0,
                          border: "1.5px dashed var(--p-color-border)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          textAlign: "center",
                          padding: 8,
                        }}
                      >
                        <Text as="span" variant="bodySm" tone="subdued">
                          Original ad
                        </Text>
                      </div>
                    )}
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingSm">
                        Brief from critique
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Source: {sourceTitle} · composite {card.composite}. The {weak.length}{" "}
                        weakest dimensions become the remake instructions.
                      </Text>
                    </BlockStack>
                  </InlineStack>

                  <BlockStack gap="300">
                    {weak.map((m) => (
                      <InlineStack key={m.id} gap="300" blockAlign="start" wrap={false}>
                        <ScoreChip score={m.score} />
                        <BlockStack gap="050">
                          <Text as="h3" variant="headingXs">
                            {m.label}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {m.reasoning || "No reasoning provided."}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    ))}
                  </BlockStack>

                  <TextField
                    label="Extra direction (optional)"
                    autoComplete="off"
                    value={extra}
                    onChange={setExtra}
                    placeholder="e.g. keep the forest backdrop, golden hour"
                    maxLength={500}
                  />
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingSm">
                    Render settings
                  </Text>

                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" fontWeight="medium">
                      Format
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Static image — video and carousel can&apos;t be re-scored yet.
                    </Text>
                  </BlockStack>

                  <BlockStack gap="150">
                    <Text as="span" variant="bodySm" fontWeight="medium">
                      Higgsfield style
                    </Text>
                    <ButtonGroup variant="segmented">
                      {(Object.keys(GENERATOR_STYLES) as GeneratorStyle[]).map((s) => (
                        <Button key={s} pressed={style === s} onClick={() => setStyle(s)}>
                          {GENERATOR_STYLES[s].label}
                        </Button>
                      ))}
                    </ButtonGroup>
                  </BlockStack>

                  <BlockStack gap="150">
                    <Text as="span" variant="bodySm" fontWeight="medium">
                      Aspect
                    </Text>
                    <ButtonGroup variant="segmented">
                      {(Object.keys(GENERATOR_ASPECTS) as GeneratorAspect[]).map((a) => (
                        <Button key={a} pressed={aspect === a} onClick={() => setAspect(a)}>
                          {a}
                        </Button>
                      ))}
                    </ButtonGroup>
                  </BlockStack>

                  <BlockStack gap="150">
                    <Text as="span" variant="bodySm" fontWeight="medium">
                      Remakes
                    </Text>
                    <ButtonGroup variant="segmented">
                      <Button pressed={count === 1} onClick={() => setCount(1)}>
                        1
                      </Button>
                      <Button pressed={count === 4} onClick={() => setCount(4)}>
                        4
                      </Button>
                    </ButtonGroup>
                  </BlockStack>

                  <fetcher.Form method="post">
                    <input type="hidden" name="style" value={style} />
                    <input type="hidden" name="aspect" value={aspect} />
                    <input type="hidden" name="count" value={count} />
                    <input type="hidden" name="extraDirection" value={extra} />
                    <BlockStack gap="200">
                      <Button
                        submit
                        variant="primary"
                        fullWidth
                        loading={generating}
                        disabled={generating || !imageGenAvailable}
                      >
                        {`Generate ${count} remake${count === 1 ? "" : "s"}`}
                      </Button>
                      <Text as="p" variant="bodySm" tone="subdued" alignment="center">
                        {imageGenAvailable
                          ? "Rendered by Higgsfield · re-scored automatically"
                          : "Image generation isn't connected yet (Higgsfield credentials missing)."}
                      </Text>
                    </BlockStack>
                  </fetcher.Form>
                </BlockStack>
              </Card>
            </InlineGrid>

            {generating && (
              <Card>
                <Text as="p" tone="subdued">
                  Rendering with Higgsfield and re-scoring each remake… this usually takes
                  30–90 seconds.
                </Text>
              </Card>
            )}

            {result && (
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingSm">
                    Remakes
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    re-scored against your original ({result.baseline} composite) — winners
                    also appear on the pre-screen
                  </Text>
                </InlineStack>
                {result.remakes.length === 0 ? (
                  <Card>
                    <Text as="p" tone="subdued">
                      No remakes came back from this render — try again, or adjust the extra
                      direction.
                    </Text>
                  </Card>
                ) : (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400" alignItems="start">
                    {result.remakes.map((v, i) => (
                      <Card key={i}>
                        <BlockStack gap="300">
                          {v.input.imageUrl && (
                            <img
                              src={v.input.imageUrl}
                              alt={`Remake ${i + 1}`}
                              style={{
                                width: "100%",
                                borderRadius: 12,
                                display: "block",
                                background: GRAY_BG,
                              }}
                            />
                          )}
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="headingMd">
                              {v.composite}
                            </Text>
                            <Badge tone={v.delta > 0 ? "success" : "critical"}>
                              {`${v.delta > 0 ? "+" : ""}${v.delta} vs original`}
                            </Badge>
                            {v.delta > 0 && <Badge tone="info">beats your ad</Badge>}
                          </InlineStack>
                          <Text as="p" variant="bodySm">
                            {v.summary}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {v.rationale}
                          </Text>
                        </BlockStack>
                      </Card>
                    ))}
                  </InlineGrid>
                )}
              </BlockStack>
            )}
          </>
        )}
      </BlockStack>
    </Page>
  );
}
