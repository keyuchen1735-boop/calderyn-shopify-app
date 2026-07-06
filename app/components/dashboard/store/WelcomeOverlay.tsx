// First-run welcome overlay: a cursive "Welcome" stroke-trace, then a branch
// (Shopify import in progress / no catalog at all / ready to build) with real
// signals driving the copy and the next action. Store.tsx owns every side
// effect (building, adding a product, picking a vibe); this component is
// choice-of-view plus the GSAP choreography.
import { useEffect, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { reduced } from "../hero/hero-motion";
import { Btn } from "../ui";
import type { ImportRunVM } from "~/lib/dashboard/client";
import type { StudioVibe } from "~/lib/dashboard/store-client";
import { buildStep, importStepRows, welcomeSubline, type BuildPhase, type WelcomeBranch } from "../screens/store-logic";
import BuildStepsCard from "./BuildStepsCard";

type Stage = "choice" | "styles" | "add-product";

const VIBE_CARDS: { vibe: StudioVibe; label: string; mini: string }[] = [
  { vibe: "minimal", label: "Clean & minimal", mini: "minimal" },
  { vibe: "bold", label: "Bold & dramatic", mini: "bold" },
  { vibe: "warm", label: "Warm & earthy", mini: "warm" },
];

export default function WelcomeOverlay({
  authBase,
  branch,
  importRun,
  buildPhase,
  productCount,
  onBuildPlain,
  onBuildWithVibe,
  onAddProduct,
}: {
  authBase?: string;
  branch: WelcomeBranch;
  importRun: ImportRunVM | null;
  buildPhase: BuildPhase | null;
  productCount: number;
  onBuildPlain: () => void;
  onBuildWithVibe: (vibe: StudioVibe) => void;
  onAddProduct: (line: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("choice");
  const [productLine, setProductLine] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const textRef = useRef<SVGTextElement>(null);
  const subRef = useRef<HTMLParagraphElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // Stroke-trace the cursive word, then rise from screen-center to its layout
  // spot, then cascade the copy/buttons in. Static under reduced-motion.
  useGSAP(
    () => {
      if (reduced() || !svgRef.current || !textRef.current) return;
      const svg = svgRef.current;
      const text = textRef.current;
      const wr = rootRef.current?.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const centerY = wr ? wr.top + wr.height / 2 - (sr.top + sr.height / 2) : 0;
      gsap.set(svg, { y: centerY });
      const play = () => {
        // A deferred start can outlive this mount (dev double-mount, fast
        // navigation) — never animate a detached tree.
        if (!svg.isConnected) return;
        let len = 0;
        try {
          len = text.getComputedTextLength();
        } catch {
          len = 0;
        }
        // fromTo + clearProps everywhere: an interrupted tween must never
        // strand the copy/buttons at autoAlpha 0 (the from-state).
        const cascade = [subRef.current, ...(actionsRef.current ? Array.from(actionsRef.current.children) : []), noteRef.current].filter(
          (el): el is HTMLElement => el != null,
        );
        const tl = gsap.timeline({
          onComplete: () => gsap.set(cascade, { clearProps: "opacity,visibility,transform" }),
        });
        if (len > 0) {
          gsap.set(text, { strokeDasharray: len, strokeDashoffset: len, fillOpacity: 0, autoAlpha: 1 });
          tl.to(text, { strokeDashoffset: 0, duration: 2.1, ease: "power1.inOut" }).to(
            text,
            { fillOpacity: 1, duration: 0.7 },
            "-=0.55",
          );
        }
        tl.to(svg, { y: 0, duration: 0.9, ease: "power3.inOut" }, "-=0.8");
        if (subRef.current) {
          tl.fromTo(subRef.current, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.45 }, "-=0.45");
        }
        if (actionsRef.current?.children.length) {
          tl.fromTo(
            actionsRef.current.children,
            { autoAlpha: 0, y: 12 },
            { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.09 },
            "-=0.2",
          );
        }
        if (noteRef.current) {
          tl.fromTo(noteRef.current, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.4 }, "-=0.1");
        }
      };
      if (document.fonts?.load) {
        let done = false;
        const go = () => {
          if (!done) {
            done = true;
            play();
          }
        };
        document.fonts.load('92px "Great Vibes"').then(go).catch(go);
        setTimeout(go, 900);
      } else {
        play();
      }
    },
    { scope: rootRef },
  );

  // A stage swap (choice -> styles / add-product) gets its own small entrance,
  // separate from the one-time welcome-word trace above.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduced() || !stageRef.current) return;
    gsap.from(stageRef.current, { autoAlpha: 0, y: 12, duration: 0.3, ease: "power3.out" });
    if (stageRef.current.querySelectorAll) {
      gsap.from(stageRef.current.querySelectorAll("[data-welcome-item]"), {
        autoAlpha: 0,
        y: 14,
        duration: 0.32,
        stagger: 0.07,
        delay: 0.05,
      });
    }
  }, [stage]);

  const step = branch.kind !== "importing" && buildPhase ? buildStep(buildPhase) : null;
  const working = step != null;
  const dashboardLoginHref = authBase ? `${authBase.replace(/\/+$/, "")}/dashboard/login` : "/dashboard/login";

  const subline = welcomeSubline({ branch, buildPhase, productCount });

  return (
    <div className="cd-welcome" ref={rootRef}>
      <div className="cd-welcome-inner">
        <svg
          className="cd-welcome-script"
          viewBox="0 0 560 170"
          aria-label="Welcome"
          ref={svgRef}
        >
          <text x="50%" y="120" textAnchor="middle" className="cd-welcome-text" ref={textRef}>
            Welcome
          </text>
        </svg>
        <p className="cd-welcome-sub" ref={subRef}>
          {subline}
        </p>

        {branch.kind === "importing" && (
          <BuildStepsCard
            className="cd-welcome-build"
            dimPending
            rows={importStepRows(importRun).map((r) => ({ dot: r.state, title: r.title, sub: r.sub }))}
          />
        )}

        {working && step && (
          <BuildStepsCard className="cd-welcome-build" dimPending rows={[step]} />
        )}

        {!working && branch.kind !== "importing" && (
          <div ref={stageRef}>
            {stage === "choice" && (
              <>
                <div className="cd-welcome-actions" ref={actionsRef}>
                  {branch.kind === "empty" ? (
                    <>
                      <a href={dashboardLoginHref} className="cd-btn cd-btn-primary cd-welcome-big">
                        Connect Shopify
                      </a>
                      <Btn className="cd-welcome-big" onClick={() => setStage("add-product")}>
                        Add my first product
                      </Btn>
                    </>
                  ) : (
                    <>
                      <Btn kind="primary" className="cd-welcome-big" onClick={onBuildPlain}>
                        Let's build my store
                      </Btn>
                      <Btn className="cd-welcome-big" onClick={() => setStage("styles")}>
                        How should it look?
                      </Btn>
                    </>
                  )}
                </div>
                <div className="cd-welcome-note" ref={noteRef}>
                  Everything can change later. Nothing goes live until you publish.
                </div>
              </>
            )}

            {stage === "styles" && (
              <div className="cd-welcome-styles">
                <div className="cd-welcome-styles-title">Pick a starting look</div>
                <div className="cd-welcome-cards">
                  {VIBE_CARDS.map((c) => (
                    <button
                      key={c.vibe}
                      type="button"
                      className="cd-welcome-card"
                      data-welcome-item=""
                      onClick={() => onBuildWithVibe(c.vibe)}
                    >
                      <span className={`cd-welcome-mini cd-welcome-mini-${c.mini}`}>
                        <i />
                        <i />
                        <i />
                        {c.vibe === "minimal" && <i />}
                      </span>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="cd-chip"
                    data-welcome-item=""
                    onClick={() => onBuildWithVibe(VIBE_CARDS[Math.floor(Math.random() * VIBE_CARDS.length)].vibe)}
                  >
                    Surprise me
                  </button>
                </div>
              </div>
            )}

            {stage === "add-product" && (
              <div className="cd-welcome-form">
                <input
                  value={productLine}
                  onChange={(e) => setProductLine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && productLine.trim()) onAddProduct(productLine.trim());
                  }}
                  placeholder="Describe it in one line, e.g. Hand-poured cedar candle, $18"
                  aria-label="Describe your first product"
                  autoFocus
                />
                <Btn
                  kind="primary"
                  onClick={() => productLine.trim() && onAddProduct(productLine.trim())}
                >
                  Create it
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
