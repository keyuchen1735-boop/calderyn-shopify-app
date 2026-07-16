import { useState } from "react";
import { Btn } from "../ui";
import type { ImportRunVM } from "~/lib/dashboard/client";
import {
  buildStep,
  importStepRows,
  welcomeSubline,
  type BuildPhase,
  type WelcomeBranch,
} from "../screens/store-logic";
import BuildStepsCard from "./BuildStepsCard";

type Stage = "choice" | "direction" | "add-product";

export default function WelcomeOverlay({
  authBase,
  branch,
  importRun,
  buildPhase,
  terminalMessage,
  productCount,
  onBuildPrompt,
  onAddProduct,
}: {
  authBase?: string;
  branch: WelcomeBranch;
  importRun: ImportRunVM | null;
  buildPhase: BuildPhase | null;
  terminalMessage?: string | null;
  productCount: number;
  onBuildPrompt: (prompt: string) => void;
  onAddProduct: (line: string) => void;
}) {
  const [stage, setStage] = useState<Stage>("choice");
  const [productLine, setProductLine] = useState("");
  const [direction, setDirection] = useState("");
  const dashboardLoginHref = authBase ? `${authBase.replace(/\/+$/, "")}/dashboard/login` : "/dashboard/login";
  const step = branch.kind !== "importing" && buildPhase ? buildStep(buildPhase) : null;

  return (
    <div className="cd-welcome" data-stage={stage}>
      <div className="cd-welcome-inner">
        <svg className="cd-welcome-script" viewBox="0 0 560 170" aria-label="Welcome">
          <text x="50%" y="120" textAnchor="middle" className="cd-welcome-text">Welcome</text>
        </svg>
        <p className="cd-welcome-sub">{welcomeSubline({ branch, buildPhase, productCount })}</p>
        {terminalMessage ? <p className="cd-welcome-note" role="status">{terminalMessage}</p> : null}

        {branch.kind === "importing" ? (
          <BuildStepsCard
            className="cd-welcome-build"
            dimPending
            rows={importStepRows(importRun).map((row) => ({ dot: row.state, title: row.title, sub: row.sub }))}
          />
        ) : null}
        {step ? <BuildStepsCard className="cd-welcome-build" dimPending rows={[step]} /> : null}

        {!step && branch.kind !== "importing" ? (
          <div>
            {stage === "choice" ? (
              <>
                <div className="cd-welcome-actions">
                  {branch.kind === "empty" ? (
                    <>
                      <a href={dashboardLoginHref} className="cd-btn cd-btn-primary cd-welcome-big">Connect Shopify</a>
                      <Btn className="cd-welcome-big" onClick={() => setStage("add-product")}>Add my first product</Btn>
                    </>
                  ) : (
                    <>
                      <Btn kind="primary" className="cd-welcome-big" onClick={() => onBuildPrompt("Build my store")}>
                        Let's build my store
                      </Btn>
                      <Btn className="cd-welcome-big" onClick={() => setStage("direction")}>How should it look?</Btn>
                    </>
                  )}
                </div>
                <div className="cd-welcome-note">Everything can change later. Nothing goes live until you publish.</div>
              </>
            ) : null}

            {stage === "direction" ? (
              <div className="cd-welcome-form">
                <input
                  value={direction}
                  onChange={(event) => setDirection(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") onBuildPrompt(direction.trim() || "Build my store");
                  }}
                  placeholder="Quiet editorial skincare, energetic outdoor gear..."
                  aria-label="Describe your store's visual direction"
                  autoFocus
                />
                <Btn onClick={() => setStage("choice")}>Back</Btn>
                <Btn kind="primary" onClick={() => onBuildPrompt(direction.trim() || "Build my store")}>Build my store</Btn>
              </div>
            ) : null}

            {stage === "add-product" ? (
              <div className="cd-welcome-form">
                <input
                  value={productLine}
                  onChange={(event) => setProductLine(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && productLine.trim()) onAddProduct(productLine.trim());
                  }}
                  placeholder="Describe it in one line, e.g. Hand-poured cedar candle, $18"
                  aria-label="Describe your first product"
                  autoFocus
                />
                <Btn kind="primary" onClick={() => productLine.trim() && onAddProduct(productLine.trim())}>Create it</Btn>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
