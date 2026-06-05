// app/lib/simulator/orchestrate.server.ts
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import { DEMO_MODEL } from "./demo";
import { fetchSnapshot as realFetchSnapshot } from "./fetch-pages.server";
import { buildBehaviorModel as realBuildModel } from "./simulate.server";
import {
  startRun as realStart,
  completeRun as realComplete,
  failRun as realFail,
} from "./runs.server";
import type { BehaviorModel, SimulationRun, StoreSnapshot } from "./types";

export interface ExecuteDeps {
  startRun: (shop: string, requestedN: number, target?: string) => Promise<SimulationRun>;
  completeRun: (id: string, model: BehaviorModel) => Promise<SimulationRun>;
  failRun: (id: string, message: string) => Promise<SimulationRun>;
  fetchSnapshot: (shop: string) => Promise<StoreSnapshot>;
  buildBehaviorModel: (snapshot: StoreSnapshot) => Promise<BehaviorModel>;
}

function defaultDeps(): ExecuteDeps {
  return {
    startRun: realStart,
    completeRun: realComplete,
    failRun: realFail,
    fetchSnapshot: (shop) => realFetchSnapshot(shop),
    // The default dep owns the Anthropic wiring so the orchestration test never
    // imports the SDK — it injects a plain fake instead.
    buildBehaviorModel: (snapshot) =>
      realBuildModel(snapshot, {
        createMessage: (p) => getAnthropic().messages.create(p),
        model: assistantModel(),
      }),
  };
}

export async function executeSimulation(
  input: { shop: string; requestedN: number; demo?: boolean },
  deps: ExecuteDeps = defaultDeps(),
): Promise<SimulationRun> {
  const target = input.demo ? "demo" : "whole_store";
  // startRun is inside the try so a DB blip there surfaces as an in-app error DTO
  // (caught and shown in the route banner) rather than crashing to Remix's error boundary.
  let run: SimulationRun | null = null;
  try {
    run = await deps.startRun(input.shop, input.requestedN, target);
    // Demo path: skip page fetch + the Anthropic call entirely and use built-in
    // sample data, so the teardown renders with no ANTHROPIC_API_KEY.
    const model = input.demo
      ? DEMO_MODEL
      : await deps.buildBehaviorModel(await deps.fetchSnapshot(input.shop));
    return await deps.completeRun(run.id, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        return await deps.failRun(run.id, message);
      } catch {
        // failRun itself failed — fall through to a synthetic error DTO below.
      }
    }
    return {
      id: run?.id ?? "",
      status: "error",
      target,
      requestedN: input.requestedN,
      model: null,
      error: message,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }
}
