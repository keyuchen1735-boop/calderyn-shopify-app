// app/routes/app.simulator.tsx
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack,
  Page, RangeSlider, Select, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { executeSimulation } from "~/lib/simulator/orchestrate.server";
import { getLatestRun, listRuns } from "~/lib/simulator/runs.server";
import { sampleFunnel, seedFromString } from "~/lib/simulator/sample";
import { MAX_SHOPPERS, MIN_SHOPPERS, type SimulationRun } from "~/lib/simulator/types";

// Run a single structured Claude call synchronously; fits the function budget.
export const config = { maxDuration: 60 };

export function clampN(raw: FormDataEntryValue | null): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MAX_SHOPPERS;
  return Math.min(Math.max(n, MIN_SHOPPERS), MAX_SHOPPERS);
}

type LoaderPayload = { latest: SimulationRun | null; history: SimulationRun[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
  ]);
  return json<LoaderPayload>({ latest, history });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const requestedN = clampN(form.get("requestedN"));
  const run = await executeSimulation({ shop: session.shop, requestedN });
  return json(run);
};

export default function Simulator() {
  const { latest, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const run: SimulationRun | null = (fetcher.data as SimulationRun | undefined) ?? latest;
  const running = fetcher.state !== "idle";

  const [n, setN] = useState<number>(latest?.requestedN ?? MAX_SHOPPERS);

  const sample = useMemo(() => {
    if (!run?.model) return null;
    return sampleFunnel(run.model, n, seedFromString(run.id));
  }, [run, n]);

  return (
    <Page
      title="Synthetic Shopper Simulator"
      subtitle="Send LLM-driven shoppers through your store before you spend on ads"
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <Box>
                <RangeSlider
                  label={`Shoppers to simulate: ${n.toLocaleString()}`}
                  min={MIN_SHOPPERS}
                  max={MAX_SHOPPERS}
                  step={10}
                  value={n}
                  onChange={(v) => setN(Array.isArray(v) ? v[0] : v)}
                  helpText="Drag to re-sample instantly — no new run."
                />
              </Box>
              <Select
                label="Test target"
                options={[{ label: "Whole store (home → product → checkout)", value: "whole_store" }]}
                value="whole_store"
                disabled
                onChange={() => {}}
              />
              <Box paddingBlockStart="600">
                <fetcher.Form method="post">
                  <input type="hidden" name="requestedN" value={n} />
                  <Button submit variant="primary" loading={running}>
                    {run ? "Run new simulation" : "Run first simulation"}
                  </Button>
                </fetcher.Form>
              </Box>
            </InlineGrid>
            {run?.status === "error" && (
              <Banner tone="critical" title="Simulation failed">
                <p>{run.error}</p>
              </Banner>
            )}
            {run?.model?.shipping.estimated && (
              <Text as="p" tone="subdued" variant="bodySm">
                Shipping cost is estimated — connect real rates for sharper results.
              </Text>
            )}
          </BlockStack>
        </Card>

        {running && !run?.model && (
          <Card>
            <Text as="p" tone="subdued">Simulating shoppers… this takes ~30 seconds.</Text>
          </Card>
        )}

        {run?.model && sample && (
          <>
            {sample.biggestLeak && (
              <Banner tone="critical" title={`Biggest leak — ${sample.biggestLeak.label}`}>
                <p>
                  {sample.biggestLeak.count.toLocaleString()} of {sample.n.toLocaleString()} shoppers
                  dropped at the {sample.biggestLeak.label.toLowerCase()} stage.
                </p>
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Where your {sample.n.toLocaleString()} shoppers fell out</Text>
                <BlockStack gap="150">
                  {sample.stages.map((st, i) => {
                    const pct = sample.n ? Math.round((st.reached / sample.n) * 100) : 0;
                    const isLeak = sample.biggestLeak?.stageId === st.id;
                    const isBought = st.id === "bought";
                    return (
                      <InlineStack key={st.id} gap="300" blockAlign="center">
                        <div style={{ width: 150 }}>
                          <Text as="span" variant="bodySm">{st.label}</Text>
                        </div>
                        <div style={{ flex: 1, background: "#f1f1f1", borderRadius: 4, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${Math.max(pct, 2)}%`,
                              background: isBought ? "#2b9d4b" : isLeak ? "#e03b3b" : "#3b6cff",
                              color: "#fff", padding: "6px 10px", whiteSpace: "nowrap", fontSize: 13,
                            }}
                          >
                            {st.reached.toLocaleString()}
                            {i > 0 ? ` (−${(sample.stages[i - 1].reached - st.reached).toLocaleString()})` : ""}
                          </div>
                        </div>
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              </BlockStack>
            </Card>

            {run.model.findings.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">Friction findings</Text>
                  {run.model.findings.map((f) => (
                    <Box key={f.id} padding="300" borderColor="border" borderBlockStartWidth="025">
                      <InlineStack align="space-between" blockAlign="start" gap="400">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={f.severity === "critical" ? "critical" : f.severity === "high" ? "warning" : "attention"}>
                              {f.severity}
                            </Badge>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{f.title}</Text>
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">Fix: {f.fix}</Text>
                        </BlockStack>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          −{(sample.findingCounts[f.id] ?? 0).toLocaleString()}
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Per-persona breakdown</Text>
                {run.model.archetypes.map((a) => {
                  const dropStage = a.dropReason ? Object.keys(a.dropReason)[0] : undefined;
                  const reason = dropStage ? a.dropReason[dropStage as keyof typeof a.dropReason] : "—";
                  return (
                    <InlineStack key={a.id} align="space-between">
                      <Text as="span" variant="bodySm" fontWeight="semibold">{a.name}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{reason ?? "Converted"}</Text>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            </Card>
          </>
        )}

        {!run && !running && (
          <Card>
            <Text as="p" tone="subdued">
              No simulations yet. Set the slider and run your first one to see where shoppers drop off.
            </Text>
          </Card>
        )}

        {history.length > 0 && (
          <Text as="p" tone="subdued" variant="bodySm">{history.length} previous run(s) on record.</Text>
        )}
      </BlockStack>
    </Page>
  );
}
