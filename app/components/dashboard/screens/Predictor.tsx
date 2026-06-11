// Calderyn DashV2 — Creative Predictor screen.
// Scores an ad creative before spend: mandatory media drop box (the actual
// image/video) → live /dashboard/api/screener run → composite RingGauge →
// 13-dimension scorecard → predicted ROAS band + outcomes → tips.
//
// The manual form scores LIVE. The "pick a live ad" list and the generated-
// variants demo remain simulated (SCORECARD from demo.ts) —
// TODO(other-agent): wire those to the live predictor/generator API too.
import { useEffect, useState, type ReactNode } from "react";
import { Card, RingGauge, ScoreBar, Btn, Pill, GradePill } from "../ui";
import { CDIcon } from "../icons";
import { money } from "../format";
import { SCORECARD, GROUP_LABELS } from "../demo";
// Side-effect import: registers the <image-slot> custom element on the client.
// Self-guards SSR (typeof window) so this is import-safe under Remix SSR.
import "../image-slot";
import MediaDrop from "../MediaDrop";
import type { DashboardCtx } from "../context";
import type { Scorecard, ScorecardMetric } from "../view-models";
import {
  adaptScreenRun,
  fetchLatestScreenRun,
  screenCreative,
} from "~/lib/dashboard/client";
import type { ProcessedCreativeMedia } from "~/lib/creative-media";
import type { CreativeScreenRun } from "~/lib/screener/types";

// Staged scoring run copy (matches the prototype's SCORE_STEPS).
const SCORE_STEPS = [
  "Reading creative…",
  "Calibrating against your account history (38 ads)…",
  "Scoring 13 dimensions…",
  "Mapping to SKU economics…",
  "Predicting outcomes…",
];

type Phase = "form" | "running" | "result";

/* ---------- Header (mirrors the prototype's ScreenHeader) ---------- */
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

/* ---------- 13-dimension scorecard, grouped by GROUP_LABELS ---------- */
function GroupScores({ metrics }: { metrics: ScorecardMetric[] }) {
  const groups = ["attention", "message", "offer_conversion", "trust_safety"];
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => {
        const ms = metrics.filter((m) => m.group === g);
        const avg = Math.round(ms.reduce((s, m) => s + m.score, 0) / ms.length);
        return (
          <div key={g}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="cd-h3">{GROUP_LABELS[g]}</h3>
              <span className="cd-caption tabular-nums">avg {avg}</span>
            </div>
            <div className="flex flex-col gap-2.5">
              {ms.map((m) => (
                <div key={m.id} className="cd-dim" title={m.reasoning}>
                  <span className="cd-dim-label">{m.label}</span>
                  <ScoreBar score={m.score} />
                  <p className="cd-dim-why">{m.reasoning}</p>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Predicted outcomes: ROAS band + mini-stats ---------- */
function OutcomePanel({ o }: { o: Scorecard["outcomes"] }) {
  const above = o.estimatedRoas >= o.breakEvenRoas;
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="cd-h2">Predicted outcomes</h2>
      <div className="cd-roas-band">
        <div className="cd-caption flex justify-between">
          <span>{o.roasLow.toFixed(1)}×</span>
          <span>est. ROAS range</span>
          <span>{o.roasHigh.toFixed(1)}×</span>
        </div>
        <div className="cd-band">
          <div className="cd-band-fill"></div>
          <div
            className="cd-band-marker"
            style={{
              left: `${((o.estimatedRoas - o.roasLow) / (o.roasHigh - o.roasLow)) * 100}%`,
            }}
          >
            <span className="cd-band-val tabular-nums">{o.estimatedRoas.toFixed(1)}×</span>
          </div>
          <div
            className="cd-band-be"
            style={{
              left: `${((o.breakEvenRoas - o.roasLow) / (o.roasHigh - o.roasLow)) * 100}%`,
            }}
            title={`Break-even ${o.breakEvenRoas.toFixed(1)}×`}
          ></div>
        </div>
        <div className="cd-caption" style={{ color: above ? "var(--green)" : "var(--red)" }}>
          {above ? "Above" : "Below"} your {o.breakEvenRoas.toFixed(1)}× break-even
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="cd-mini-stat">
          <b className="tabular-nums">{(o.predictedCtr * 100).toFixed(1)}%</b>
          <span>predicted CTR</span>
        </div>
        <div className="cd-mini-stat">
          <b className="tabular-nums">{(o.holdRate * 100).toFixed(1)}%</b>
          <span>hold rate</span>
        </div>
        <div className="cd-mini-stat">
          <b className="tabular-nums">{money(o.predictedRevenueCents)}</b>
          <span>est. revenue @ {money(o.assumedSpendCents)}</span>
        </div>
        <div className="cd-mini-stat">
          <b>{o.mappedSku}</b>
          <span>mapped SKU · {money(o.skuPriceCents)}</span>
        </div>
      </div>
    </Card>
  );
}

export default function ScreenPredictor({ app }: { app: DashboardCtx }) {
  // Default to the scored result (matches the prototype's initial "result" phase).
  const [phase, setPhase] = useState<Phase>("result");
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    headline: "The tee that survives the trail",
    primaryText:
      "Heavyweight organic cotton, reinforced seams, and a fit tested on 40-mile weekends. The Summit Tee is the one you'll reach for every time.",
    cta: "Shop Now",
    audience: "Broad US, outdoors interests, 24–54",
    destinationUrl: "",
    spend: "500",
  });
  // Mandatory creative media: processed client-side (downscale / frame-extract).
  const [media, setMedia] = useState<ProcessedCreativeMedia | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  // The latest real run; the demo SCORECARD stays as the first-visit preview.
  const [liveRun, setLiveRun] = useState<CreativeScreenRun | null>(null);
  const liveSc = liveRun ? adaptScreenRun(liveRun) : null;
  const sc = liveSc ?? SCORECARD;

  useEffect(() => {
    let cancelled = false;
    fetchLatestScreenRun()
      .then((run) => {
        if (!cancelled && run?.status === "done" && run.scorecard) setLiveRun(run);
      })
      .catch(() => {
        // No session / transient failure → keep the demo preview; the live
        // score path surfaces its own errors on submit.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live scoring genuinely takes ~20–30s: advance the staged copy slowly and
  // hold the last step until the request returns (mirrors the extension).
  useEffect(() => {
    if (!scoring || phase !== "running" || step >= SCORE_STEPS.length - 1) return;
    const t = setTimeout(() => setStep((s) => s + 1), 3500 + Math.random() * 1500);
    return () => clearTimeout(t);
  }, [scoring, phase, step]);

  // Live scoring for the manual form — the media drop is mandatory.
  const runLive = async () => {
    if (!media) {
      setFormError("Add the actual ad creative — drop its image or video in the box.");
      return;
    }
    setFormError(null);
    setScoring(true);
    setPhase("running");
    setStep(0);
    try {
      const spendNum = Number(form.spend);
      const run = await screenCreative({
        headline: form.headline,
        primaryText: form.primaryText,
        cta: form.cta,
        destinationUrl: form.destinationUrl,
        audience: form.audience,
        assumedSpendCents:
          Number.isFinite(spendNum) && spendNum > 0 ? Math.round(spendNum * 100) : 50_000,
        mediaKind: media.kind,
        imageUrl: media.imageUrl,
        ...(media.kind === "video"
          ? { videoFrameUrls: media.frameUrls, videoDurationSec: media.durationSec }
          : {}),
      });
      if (run.status !== "done" || !run.scorecard) {
        throw new Error(run.error ?? "Couldn't score this ad — try again.");
      }
      setLiveRun(run);
      setPhase("result");
      app.toast(`Creative scored — composite ${run.scorecard.composite}.`, "sparkle");
    } catch (err) {
      setPhase("form");
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setScoring(false);
    }
  };

  // Simulated staged run for the demo "pick a live ad" placeholders.
  const runDemo = () => {
    setFormError(null);
    setLiveRun(null);
    setPhase("running");
    setStep(0);
    let i = 0;
    const next = () => {
      i++;
      if (i < SCORE_STEPS.length) {
        setStep(i);
        setTimeout(next, 650 + Math.random() * 450);
      } else {
        setPhase("result");
        app.toast("Creative scored — composite 58, grade Okay.", "sparkle");
      }
    };
    setTimeout(next, 700);
  };

  return (
    <div className="cd-screen">
      <ScreenHeader
        title="Creative Predictor"
        sub="Score an ad before you spend — calibrated to your account history and SKU economics."
      >
        {phase === "result" && (
          <Btn icon="sparkle" onClick={() => setPhase("form")} small>
            Screen another
          </Btn>
        )}
      </ScreenHeader>

      {phase === "form" && (
        <div className="cd-grid-main">
          <Card className="flex flex-col gap-3.5">
            <h2 className="cd-h2">Creative</h2>
            <label className="cd-field">
              <span>Headline</span>
              <input
                className="cd-input"
                value={form.headline}
                onChange={(e) => setForm({ ...form, headline: e.target.value })}
              />
            </label>
            <label className="cd-field">
              <span>Primary text</span>
              <textarea
                className="cd-input"
                rows={3}
                value={form.primaryText}
                onChange={(e) => setForm({ ...form, primaryText: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="cd-field">
                <span>Call to action</span>
                <input
                  className="cd-input"
                  value={form.cta}
                  onChange={(e) => setForm({ ...form, cta: e.target.value })}
                />
              </label>
              <label className="cd-field">
                <span>Assumed spend</span>
                <input
                  className="cd-input tabular-nums"
                  type="number"
                  value={form.spend}
                  onChange={(e) => setForm({ ...form, spend: e.target.value })}
                />
              </label>
            </div>
            <label className="cd-field">
              <span>Audience</span>
              <input
                className="cd-input"
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
              />
            </label>
            <label className="cd-field">
              <span>Where the click goes</span>
              <input
                className="cd-input"
                placeholder="https://yourstore.com/products/..."
                value={form.destinationUrl}
                onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })}
              />
            </label>
            <MediaDrop
              value={media}
              onChange={(m) => {
                setMedia(m);
                setFormError(null);
              }}
              disabled={scoring}
            />
            {formError && <p className="cd-mediadrop-err">{formError}</p>}
            <div className="flex items-center gap-3 mt-1">
              <Btn kind="primary" icon="sparkle" onClick={runLive} disabled={!media || scoring}>
                Score creative
              </Btn>
              <span className="cd-caption">
                {media
                  ? "~20 seconds · uses your last 90 days of ad history"
                  : "Add the ad's image or video to score it"}
              </span>
            </div>
          </Card>
          <Card className="flex flex-col gap-3">
            <h2 className="cd-h2">Or pick a live ad</h2>
            {[
              "Static — Summit Tee flat lay",
              "UGC — “Three weeks on the JMT”",
              "Carousel — Rain shell in real rain",
            ].map((name) => (
              <button key={name} className="cd-action-btn" onClick={runDemo}>
                <CDIcon name="megaphone" size={15} />
                <span className="flex-1 text-left truncate">{name}</span>
                <CDIcon name="chevronRight" size={14} />
              </button>
            ))}
            <p className="cd-caption">Pulled from Meta — creatives sync automatically.</p>
          </Card>
        </div>
      )}

      {phase === "running" && (
        <Card className="cd-runner">
          <div className="cd-runner-orb">
            <CDIcon name="sparkle" size={26} />
          </div>
          <div className="flex flex-col gap-2.5" style={{ minWidth: 300 }}>
            {SCORE_STEPS.map((s, i) => (
              <div
                key={s}
                className="flex items-center gap-2.5"
                style={{ opacity: i <= step ? 1 : 0.35, transition: "opacity 0.3s" }}
              >
                {i < step ? (
                  <CDIcon name="check" size={15} style={{ color: "var(--green)" }} />
                ) : i === step ? (
                  <span className="cd-spinner"></span>
                ) : (
                  <span style={{ width: 15 }}></span>
                )}
                <span className="cd-body">{s}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {phase === "result" && (
        <>
          <Card className="flex items-center gap-6 flex-wrap">
            {liveRun?.creativeInput?.imageUrl ? (
              <img
                src={liveRun.creativeInput.imageUrl}
                alt="Ad creative"
                style={{
                  width: 120,
                  height: 120,
                  objectFit: "cover",
                  borderRadius: 14,
                  flexShrink: 0,
                }}
              />
            ) : (
              <image-slot
                id="original-ad"
                shape="rounded"
                radius="14"
                fit="cover"
                placeholder="Drop the original ad"
                style={{ width: 120, height: 120, flexShrink: 0 }}
              ></image-slot>
            )}
            <RingGauge value={sc.composite} size={120} label="composite" />
            <div className="min-w-0 flex-1" style={{ minWidth: 240 }}>
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <h2 className="cd-h2">{sc.ad_name}</h2>
                <GradePill grade={sc.grade} />
                <Pill>confidence: {sc.confidence}</Pill>
                {liveRun?.creativeInput?.mediaKind === "video" && <Pill>video creative</Pill>}
              </div>
              <p className="cd-body" style={{ maxWidth: "60ch" }}>
                {sc.summary}
              </p>
            </div>
            <Btn kind="primary" icon="bolt" onClick={() => app.navigate("generator")}>
              Remake with Higgsfield
            </Btn>
          </Card>

          <div className="cd-grid-main">
            <Card pad={false}>
              <div className="cd-pad-x cd-pad-t flex items-center justify-between">
                <h2 className="cd-h2">13 dimensions</h2>
                <span className="cd-caption">scored 0–100 with reasoning</span>
              </div>
              <div className="cd-pad" style={{ paddingTop: 12 }}>
                <GroupScores metrics={sc.metrics} />
              </div>
            </Card>
            <div className="flex flex-col gap-4 min-w-0">
              <OutcomePanel o={sc.outcomes} />
              <Card className="flex flex-col gap-2.5">
                <h2 className="cd-h2">How to improve it</h2>
                {sc.tips.map((tip, i) => (
                  <div key={i} className="flex gap-2.5 items-start">
                    <span className="cd-tip-num">{i + 1}</span>
                    <p className="cd-body" style={{ fontSize: "calc(13.5px * var(--type-scale))" }}>
                      {tip}
                    </p>
                  </div>
                ))}
              </Card>
              <Card className="flex flex-col gap-3">
                <h2 className="cd-h2">Generated variants that beat it</h2>
                {sc.variants.length === 0 && (
                  <p className="cd-caption">
                    No generated variants yet — remake it in the Ad Generator.
                  </p>
                )}
                {sc.variants.map((v) => (
                  <div key={v.mode} className="cd-variant">
                    <div className="flex items-center gap-2">
                      <Pill tone="accent" icon={v.mode === "copy" ? "doc" : "sparkle"}>
                        {v.mode}
                      </Pill>
                      <b className="tabular-nums">{v.composite}</b>
                      <span className="cd-caption tabular-nums" style={{ color: "var(--green)" }}>
                        +{v.delta}
                      </span>
                      <span className="cd-caption ml-auto">vs original</span>
                    </div>
                    <div className="cd-body mt-1.5">
                      “{v.headline}” · CTA: {v.cta}
                    </div>
                    <div className="cd-caption mt-0.5">{v.summary}</div>
                  </div>
                ))}
                <Btn small icon="bolt" onClick={() => app.navigate("generator")}>
                  Remake the visuals too — Ad Generator
                </Btn>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
