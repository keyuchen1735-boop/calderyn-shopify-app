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
import { CDIcon } from "../icons";
import type { ImportRunVM } from "~/lib/dashboard/client";
import { resolveStudioDesign } from "~/lib/dashboard/store-client";
import { STORE_TEMPLATE_REGISTRY } from "~/lib/storefront-bundle/registry";
import type {
  StoreDesignMode,
  StoreDesignRequest,
  StoreDesignResolution,
  StoreTemplateId,
} from "~/lib/storefront-bundle/types";
import { buildStep, importStepRows, welcomeSubline, type BuildPhase, type WelcomeBranch } from "../screens/store-logic";
import BuildStepsCard from "./BuildStepsCard";

type Stage = "choice" | "styles" | "add-product";

export default function WelcomeOverlay({
  authBase,
  branch,
  importRun,
  buildPhase,
  productCount,
  onBuildPlain,
  onBuildDesign,
  onAddProduct,
}: {
  authBase?: string;
  branch: WelcomeBranch;
  importRun: ImportRunVM | null;
  buildPhase: BuildPhase | null;
  productCount: number;
  onBuildPlain: () => void;
  onBuildDesign: (request: StoreDesignRequest, recommendation?: StoreDesignResolution) => void;
  onAddProduct: (line: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("choice");
  const [productLine, setProductLine] = useState("");
  const [templatePrompt, setTemplatePrompt] = useState("");
  const [designMode, setDesignMode] = useState<StoreDesignMode>("auto");
  const [selectedTemplateId, setSelectedTemplateId] = useState<StoreTemplateId | null>(null);
  const [recommendation, setRecommendation] = useState<StoreDesignResolution | undefined>();
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
  useEffect(() => {
    if (stage !== "styles" || designMode !== "auto") return;
    let active = true;
    const timer = setTimeout(() => {
      void resolveStudioDesign({ prompt: templatePrompt, mode: "auto" })
        .then((result) => {
          if (active) setRecommendation(result);
        })
        .catch(() => {
          if (active) setRecommendation(undefined);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [designMode, stage, templatePrompt]);

  const recommendedTemplateId = recommendation?.kind === "recipe" ? recommendation.templateId : null;
  const recommendedTemplates = [...STORE_TEMPLATE_REGISTRY.templates].sort((left, right) => {
    if (left.id === recommendedTemplateId) return -1;
    if (right.id === recommendedTemplateId) return 1;
    return left.name.localeCompare(right.name);
  });
  const previewTemplateId = selectedTemplateId ?? recommendedTemplateId;
  const previewTemplate = previewTemplateId
    ? STORE_TEMPLATE_REGISTRY.templates.find((template) => template.id === previewTemplateId)
    : null;
  const matchReasons = recommendation?.kind === "recipe" && recommendation.templateId === previewTemplateId
    ? recommendation.reasons
    : [];

  const submitDesign = () => {
    const prompt = templatePrompt.trim();
    if (designMode === "recipe" && selectedTemplateId) {
      onBuildDesign({ prompt, mode: "recipe", templateId: selectedTemplateId });
      return;
    }
    onBuildDesign({ prompt, mode: "auto" }, recommendation);
  };

  return (
    <div className="cd-welcome" data-stage={stage} ref={rootRef}>
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
                <div className="cd-welcome-styles-title">What should your store feel like?</div>
                <label className="cd-template-search">
                  <CDIcon name="search" size={17} strokeWidth={1.8} />
                  <input
                    value={templatePrompt}
                    onChange={(event) => setTemplatePrompt(event.target.value)}
                    placeholder="Quiet luxury skincare, energetic outdoor gear..."
                    aria-label="Describe your store's visual direction"
                    autoFocus
                  />
                </label>
                <div className="cd-welcome-cards">
                  {recommendedTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="cd-welcome-card"
                      data-welcome-item=""
                      aria-pressed={designMode === "recipe" && selectedTemplateId === template.id}
                      onClick={() => {
                        setDesignMode("recipe");
                        setSelectedTemplateId(template.id);
                      }}
                    >
                      <span className="cd-template-preview">
                        <img src={template.previewSrc} alt="" />
                        {template.id === recommendedTemplateId && <span>Best match</span>}
                      </span>
                      <span className="cd-template-meta">
                        <strong>{template.name}</strong>
                        <small>{template.descriptor}</small>
                      </span>
                    </button>
                  ))}
                </div>
                {designMode !== "custom" && previewTemplate && (
                  <section className="cd-template-live" aria-label={`${previewTemplate.name} interactive preview`}>
                    <div className="cd-template-live__copy">
                      <div>
                        <strong>{previewTemplate.name}, with your store data</strong>
                        <span>Interactive home, collections, products, cart and checkout. This preview does not install anything.</span>
                      </div>
                      <span className="cd-template-cost">Recipe build · no AI design credit</span>
                    </div>
                    {matchReasons.length > 0 && (
                      <ul className="cd-template-reasons" aria-label="Why this matches">
                        {matchReasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    )}
                    <iframe
                      className="cd-template-live__frame"
                      title={`${previewTemplate.name} with your catalog`}
                      src={`/dashboard/store/preview?template=${encodeURIComponent(previewTemplate.id)}&route=home`}
                      sandbox="allow-same-origin allow-scripts allow-popups"
                    />
                  </section>
                )}
                <div className="cd-template-actions">
                  <button
                    type="button"
                    className="cd-chip"
                    data-welcome-item=""
                    onClick={() => setStage("choice")}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    className="cd-chip"
                    data-welcome-item=""
                    onClick={() => {
                      const template = recommendedTemplates[Math.floor(Math.random() * recommendedTemplates.length)];
                      setDesignMode("recipe");
                      setSelectedTemplateId(template.id);
                    }}
                  >
                    Surprise me
                  </button>
                  <button
                    type="button"
                    className="cd-chip"
                    data-welcome-item=""
                    aria-pressed={designMode === "auto"}
                    onClick={() => {
                      setDesignMode("auto");
                      setSelectedTemplateId(null);
                    }}
                  >
                    Use recommendation
                  </button>
                  <Btn
                    kind="primary"
                    data-welcome-item=""
                    disabled={designMode === "recipe" && !selectedTemplateId}
                    onClick={submitDesign}
                  >
                    {designMode === "recipe" && selectedTemplateId
                        ? `Build ${STORE_TEMPLATE_REGISTRY.templates.find((template) => template.id === selectedTemplateId)?.name ?? "selected recipe"}`
                        : recommendedTemplateId
                          ? `Build ${STORE_TEMPLATE_REGISTRY.templates.find((template) => template.id === recommendedTemplateId)?.name ?? "recommended store"}`
                          : "Build recommended store"}
                  </Btn>
                </div>
                <div className="cd-welcome-note">Ask for a full redesign after your first draft if you want an entirely original direction.</div>
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
