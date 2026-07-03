import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Banner, BlockStack, Button, Page, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient } from "~/lib/calderyn.server";
import { buildLiveEnginePageData } from "~/lib/calibration/live-engine-page.server";
import type { LiveEnginePageData } from "~/lib/calibration/live-engine-page.server";
import { autopilotToasts, autopilotFailureLines, type AutopilotDecisionVM } from "~/lib/autopilot-banner";
import type { ActionKind, Campaign } from "~/lib/types";
import LiveEngineView, { LiveBadge } from "~/components/calderyn/LiveEngineView";

type LoaderPayload = {
  engine: LiveEnginePageData;
  /** Drives autopilot-on-load: whether shop-level autopilot is enabled. */
  autopilotEnabled: boolean;
  /** Campaign id → name lookup for the autopilot result banner lines. */
  campaigns: Campaign[];
  /** Sign-in link to the external web dashboard (same product, fuller surface). */
  dashboardLoginUrl: string;
  error: { code: string; message: string } | null;
};

// Browser-safe shape of /app/autopilot/run's reply (the server AutopilotSummary).
// Only the fields the home reads — landed `decisions` for the banner lines,
// `acted` to decide whether to revalidate.
type AutopilotRunResult = {
  acted: number;
  decisions: AutopilotDecisionVM[];
  /** Set when the run failed server-side — surfaced quietly (rule 12: fail visibly). */
  error?: string;
};

// Safe empty Live Engine view, mirroring the server-side EMPTY default, so a
// failed load degrades to an inert page rather than trapping the merchant.
const EMPTY_ENGINE: LiveEnginePageData = {
  autopilotEnabled: false,
  moneyProtectedWeekCents: 0,
  features: [],
  pipeline: [],
  trace: [],
  pending: [],
  predictions: [],
  watchScan: { inv: [], ads: [], price: [], ret: [] },
  calibrationPct: null,
  nearGraduation: 0,
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // Carried onto the onboarding redirect below so the embedded iframe keeps its
  // shop/host/embedded params and can re-authenticate on the document request.
  const url = new URL(request.url);

  // Sign-in entry point of the external merchant dashboard; the merchant's live
  // admin session completes the OAuth round-trip silently.
  const dashboardLoginUrl = `${
    process.env.DASHBOARD_PUBLIC_URL || "https://calderyncompany.com"
  }/dashboard/login?shop=${encodeURIComponent(session.shop)}`;

  const client = calderynClient(session.shop);

  // Gate on onboarding FIRST, decisively, and server-side. An unreadable state
  // almost always means the shops row isn't provisioned yet (afterAuth swallows
  // provisioning errors): route to onboarding, which provisions defensively and
  // shows its own error UI, rather than render a broken home. An incomplete
  // state likewise belongs in the wizard. url.search preserves shop/host/embedded
  // so the embedded document request re-auths.
  let onboardingDone: boolean;
  try {
    onboardingDone = (await client.onboarding.getState(request.signal)).done;
  } catch {
    throw redirect(`/app/onboarding${url.search}`);
  }
  if (!onboardingDone) {
    throw redirect(`/app/onboarding${url.search}`);
  }

  // Onboarded: load the Live Engine view, failing soft (error banner) on a
  // transient error instead of trapping the merchant. guardrails + campaigns
  // back the autopilot-on-load behavior below.
  try {
    const [engine, guardrails, campaigns] = await Promise.all([
      buildLiveEnginePageData(client, request.signal),
      client.guardrails.get(request.signal),
      client.campaigns.list(request.signal),
    ]);
    return json<LoaderPayload>({
      engine,
      autopilotEnabled: Boolean(guardrails?.autopilot_enabled),
      campaigns,
      dashboardLoginUrl,
      error: null,
    });
  } catch (err) {
    // Any auth bounce thrown as a Response must propagate, not be misread as a
    // data-load failure.
    if (err instanceof Response) throw err;
    const e = err as { code?: string; message?: string };
    return json<LoaderPayload>({
      engine: EMPTY_ENGINE,
      autopilotEnabled: false,
      campaigns: [],
      dashboardLoginUrl,
      error: { code: e.code ?? "ERROR", message: e.message ?? "Something went wrong" },
    });
  }
};

/* ---------- action (per-feature autonomy toggle) ---------- */
type ActionPayload = { ok: true; enabled: boolean } | { error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "toggle-feature") {
    const detectorId = String(formData.get("detectorId") ?? "").trim();
    const actionKind = String(formData.get("actionKind") ?? "").trim() as ActionKind;
    const enabled = String(formData.get("enabled") ?? "") === "true";
    if (!detectorId || !actionKind) {
      return json<ActionPayload>({ error: "Missing feature" }, { status: 400 });
    }
    const r = await client.calibration.setFeatureAutonomy(detectorId, actionKind, enabled);
    if (!r.ok) return json<ActionPayload>({ error: "Could not update this feature" }, { status: 500 });
    return json<ActionPayload>({ ok: true, enabled });
  }

  return json<ActionPayload>({ error: "Unknown intent" }, { status: 400 });
};

export default function Home() {
  const navigate = useEmbeddedNavigate();
  const { engine, autopilotEnabled, campaigns, dashboardLoginUrl, error } = useLoaderData<typeof loader>();

  // ----- autopilot: act immediately on load (extension parity) -----
  // When autopilot is on, run it the moment the embedded home opens — draining
  // every actionable alert now instead of at the next cron tick. /cron/autopilot
  // is the same engine for when the admin is closed. Fires once per mount; the
  // run is idempotent server-side. Each landed action becomes a line in an info
  // Banner, and a run that changed something revalidates so the trace and
  // autopilot money reflect the new rows.
  const autopilotFetcher = useFetcher<AutopilotRunResult>();
  const revalidator = useRevalidator();
  const autopilotFiredRef = useRef(false);
  const autopilotRevalidatedRef = useRef(false);
  const [autopilotDismissed, setAutopilotDismissed] = useState(false);

  useEffect(() => {
    if (autopilotFiredRef.current || !autopilotEnabled) return;
    autopilotFiredRef.current = true;
    autopilotFetcher.submit(null, { method: "post", action: "/app/autopilot/run" });
  }, [autopilotEnabled, autopilotFetcher]);

  useEffect(() => {
    if (
      autopilotFetcher.state === "idle" &&
      autopilotFetcher.data &&
      ((autopilotFetcher.data.acted ?? 0) > 0 ||
        (autopilotFetcher.data.decisions ?? []).some((d) => d.outcome === "failed")) &&
      !autopilotRevalidatedRef.current
    ) {
      autopilotRevalidatedRef.current = true;
      revalidator.revalidate();
    }
  }, [autopilotFetcher.state, autopilotFetcher.data, revalidator]);

  const autopilotLines = autopilotFetcher.data
    ? autopilotToasts(
        autopilotFetcher.data.decisions ?? [],
        (id) => campaigns.find((c) => c.id === id)?.name ?? "",
      ).map((b) => b.text)
    : [];
  const autopilotFailures = autopilotFetcher.data
    ? autopilotFailureLines(
        autopilotFetcher.data.decisions ?? [],
        (id) => campaigns.find((c) => c.id === id)?.name ?? "",
      )
    : [];
  const autopilotError = autopilotFetcher.data?.error ?? null;

  return (
    <Page
      title="Calderyn"
      subtitle="Your autopilot features running on their own. What they are doing, and why."
      titleMetadata={<LiveBadge />}
      secondaryActions={[
        {
          content: "Open web dashboard",
          onAction: () => window.open(dashboardLoginUrl, "_blank", "noopener,noreferrer"),
        },
      ]}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load the engine">
            <p>{error.message}</p>
          </Banner>
        )}

        {/* Autopilot just acted on load — one line per landed action (the
            embedded-admin mirror of the dashboard's per-action toasts). */}
        {!autopilotDismissed && autopilotLines.length > 0 && (
          <Banner
            tone="info"
            title={`Autopilot handled ${autopilotLines.length} alert${
              autopilotLines.length === 1 ? "" : "s"
            }`}
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <BlockStack gap="100">
              <BlockStack gap="050">
                {autopilotLines.map((line, i) => (
                  <Text as="p" variant="bodySm" key={`${i}:${line}`}>
                    {line}
                  </Text>
                ))}
              </BlockStack>
              <Button variant="plain" onClick={() => navigate("/app/audit")}>
                View action history
              </Button>
            </BlockStack>
          </Banner>
        )}

        {!autopilotDismissed && autopilotError && (
          <Banner
            tone="warning"
            title="Autopilot couldn't run just now"
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <p>
              {autopilotError} It runs again on your next visit, and the scheduled
              backstop keeps watching.
            </p>
          </Banner>
        )}

        {/* Failed autopilot actions — surfaced so a silent failed run (e.g. a
            disconnected ad platform) reads as a clear signal, not "nothing
            happened". The reason lives in Action history. */}
        {!autopilotDismissed && autopilotFailures.length > 0 && (
          <Banner
            tone="warning"
            title={`Autopilot couldn't finish ${autopilotFailures.length} action${
              autopilotFailures.length === 1 ? "" : "s"
            }`}
            onDismiss={() => setAutopilotDismissed(true)}
          >
            <BlockStack gap="100">
              <BlockStack gap="050">
                {autopilotFailures.map((line, i) => (
                  <Text as="p" variant="bodySm" key={`${i}:${line}`}>
                    {line}
                  </Text>
                ))}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Often a disconnected ad platform — check the connection in Settings.
              </Text>
              <Button variant="plain" onClick={() => navigate("/app/audit")}>
                View action history
              </Button>
            </BlockStack>
          </Banner>
        )}

        <LiveEngineView data={engine} />
      </BlockStack>
    </Page>
  );
}
