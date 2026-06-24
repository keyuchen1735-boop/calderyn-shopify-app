import { useState, type ReactNode } from "react";
import { Card, Btn, Pill, Segmented } from "../ui";
import { CDIcon } from "../icons";
import { GENERATOR } from "../demo";
import CreativePreviewPlaceholder from "../CreativePreviewPlaceholder";
import type { DashboardCtx } from "../context";
import type { GeneratorFix, GeneratorOutput } from "../view-models";

type Phase = "brief" | "running" | "result";

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

/* ---------- Brief: one weakest-dimension fix row ---------- */
function GenFixRow({ f }: { f: GeneratorFix }) {
  return (
    <div className="flex items-start gap-3">
      <span className="cd-gen-score tabular-nums">{f.before}</span>
      <div className="min-w-0">
        <div className="cd-row-title">{f.dim}</div>
        <div className="cd-caption" style={{ maxWidth: "44ch" }}>
          {f.fix}
        </div>
      </div>
    </div>
  );
}

/* ---------- Meta-style output preview card ---------- */
function GenAdCard({
  app,
  out,
  aspect,
}: {
  app: DashboardCtx;
  out: GeneratorOutput;
  aspect: string;
}) {
  const [pushed, setPushed] = useState(false);
  const ratio = ({ "1:1": "1 / 1", "4:5": "4 / 5", "9:16": "9 / 16" } as Record<string, string>)[
    aspect
  ] || "1 / 1";
  return (
    <Card pad={false} className="cd-gen-card">
      <div className="cd-pad flex items-center gap-2" style={{ paddingBottom: 12 }}>
        <span className="cd-gen-avatar">P</span>
        <div className="min-w-0 flex-1">
          <div className="cd-row-title truncate">Peak &amp; Pine Outfitters</div>
          <div className="cd-caption">Sponsored</div>
        </div>
        {out.recommended && (
          <Pill tone="accent" icon="sparkle">
            Best remake
          </Pill>
        )}
      </div>
      <div className="cd-gen-media" style={{ aspectRatio: ratio }}>
        <CreativePreviewPlaceholder
          label={out.format === "video" ? "Video preview unavailable" : "Image preview unavailable"}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
        {out.format === "video" && (
          <span className="cd-gen-play">
            <CDIcon name="play" size={14} strokeWidth={2} />
            {out.duration}
          </span>
        )}
      </div>
      <div className="cd-gen-ctabar">
        <div className="min-w-0 flex-1">
          <div className="cd-row-title truncate">{out.headline}</div>
          <div className="cd-caption truncate">{out.primaryText}</div>
        </div>
        <span className="cd-gen-cta">{out.cta}</span>
      </div>
      <div className="cd-pad flex flex-col gap-3" style={{ paddingTop: 14 }}>
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className="cd-stat-value tabular-nums"
            style={{ fontSize: "calc(22px * var(--type-scale))" }}
          >
            {out.composite}
          </span>
          <span className="cd-sev" style={{ color: "var(--green)" }}>
            <span className="cd-sev-dot"></span>+{out.delta} vs original
          </span>
          <span className="cd-kv ml-auto">
            <span>est. ROAS</span>
            <b className="tabular-nums" style={{ color: "var(--green)" }}>
              {out.estRoas.toFixed(1)}×
            </b>
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {out.fixed.map(([label, a, b]) => (
            <span
              key={label}
              className="cd-badge"
              style={{ background: "var(--gray-bg)", color: "var(--text-2)" }}
            >
              {label}{" "}
              <b className="tabular-nums" style={{ color: "var(--green)" }}>
                {a}→{b}
              </b>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {/* pushAdDraft is a local-only sim (action history + feed + toast). */}
          <Btn
            kind="primary"
            small
            icon={pushed ? "check" : "arrowUpRight"}
            disabled={pushed}
            onClick={() => {
              setPushed(true);
              app.pushAdDraft(out.name);
            }}
          >
            {pushed ? "Draft pushed" : "Push to Meta as draft"}
          </Btn>
          <Btn
            small
            icon="sparkle"
            onClick={() => app.toast("Re-scored — composite holds at " + out.composite + ".", "sparkle")}
          >
            Re-score
          </Btn>
        </div>
      </div>
    </Card>
  );
}

export default function ScreenGenerator({ app }: { app: DashboardCtx }) {
  const g = GENERATOR;
  const [phase, setPhase] = useState<Phase>("brief");
  const [step, setStep] = useState(0);
  const [format, setFormat] = useState("UGC video");
  const [style, setStyle] = useState(g.styles[1]);
  const [aspect, setAspect] = useState("4:5");
  const [direction, setDirection] = useState("");

  // Simulated Higgsfield render pipeline.
  const run = () => {
    setPhase("running");
    setStep(0);
    let i = 0;
    const next = () => {
      i++;
      if (i < g.steps.length) {
        setStep(i);
        setTimeout(next, 700 + Math.random() * 500);
      } else {
        setPhase("result");
        app.toast("2 remakes rendered — best scores 74 (+16).", "sparkle");
      }
    };
    setTimeout(next, 700);
  };

  return (
    <div className="cd-screen">
      <button className="cd-back" onClick={() => app.navigate("predictor")}>
        <CDIcon name="chevronLeft" size={15} />
        Creative Predictor
      </button>
      <ScreenHeader
        title="Ad Generator"
        sub="Turns the predictor's critique into a remake brief, rendered by Higgsfield and re-scored before you spend."
      >
        {phase === "result" && (
          <Btn small icon="undo" onClick={() => setPhase("brief")}>
            New remake
          </Btn>
        )}
      </ScreenHeader>

      {phase !== "result" && (
        <div className="cd-grid-main">
          <div className="flex flex-col gap-4 min-w-0">
            <Card pad={false}>
              <div className="cd-pad flex items-center gap-4" style={{ paddingBottom: 12 }}>
                <CreativePreviewPlaceholder
                  label="Original creative"
                  style={{ width: 84, height: 84, flexShrink: 0 }}
                />
                <div className="min-w-0 flex-1">
                  <h2 className="cd-h2">Brief from critique</h2>
                  <p className="cd-caption mt-1">
                    Source: {g.source_ad} · composite {g.source_composite}. The four weakest
                    dimensions become the remake instructions.
                  </p>
                </div>
              </div>
              <div className="cd-pad flex flex-col gap-4" style={{ paddingTop: 4 }}>
                {g.fixes.map((f) => (
                  <GenFixRow key={f.dim} f={f} />
                ))}
                <label className="cd-field">
                  <span>Extra direction (optional)</span>
                  <input
                    className="cd-input"
                    placeholder="e.g. keep the forest backdrop, golden hour"
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                  />
                </label>
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-4 min-w-0">
            <Card className="flex flex-col gap-4">
              <h2 className="cd-h2">Render settings</h2>
              <div className="cd-field">
                <span>Format</span>
                <Segmented
                  small
                  value={format}
                  onChange={setFormat}
                  options={["Static", "UGC video", "Carousel"]}
                />
              </div>
              <div className="cd-field">
                <span>Higgsfield style</span>
                <div className="flex flex-wrap gap-1.5">
                  {g.styles.map((s) => (
                    <button
                      key={s}
                      className="cd-gen-style"
                      data-active={s === style ? "1" : "0"}
                      onClick={() => setStyle(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="cd-field">
                <span>Aspect</span>
                <Segmented small value={aspect} onChange={setAspect} options={["1:1", "4:5", "9:16"]} />
              </div>
              {phase === "brief" ? (
                <>
                  <Btn kind="primary" icon="sparkle" onClick={run}>
                    Generate 2 remakes
                  </Btn>
                  <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <CDIcon name="bolt" size={13} /> Rendered by Higgsfield · re-scored automatically
                  </p>
                </>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {g.steps.map((s, i) => (
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
                      <span className="cd-body" style={{ fontSize: "calc(13px * var(--type-scale))" }}>
                        {s}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {phase === "result" && (
        <>
          <div className="cd-grid-duo" style={{ alignItems: "start" }}>
            {g.outputs.map((out) => (
              <GenAdCard
                key={out.id}
                app={app}
                out={out}
                aspect={aspect}
              />
            ))}
          </div>
          <p className="cd-caption" style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <CDIcon name="sparkle" size={13} /> Scores are predictor re-runs on the remade creative —
            same 13 dimensions, calibrated to your account. Drop real Higgsfield renders onto the
            previews.
          </p>
        </>
      )}
    </div>
  );
}
