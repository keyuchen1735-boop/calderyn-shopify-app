import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  calderynClient,
  type CalderynError,
  type IntegrationProvider,
} from "~/lib/calderyn.server";
import { useActionToast } from "~/lib/toast";
import { providerPaired } from "~/lib/integrations";
import { DEFAULT_GUARDRAILS } from "~/lib/guardrail-defaults";
import { fmtMoney } from "~/lib/format";
import { GuardrailMeter } from "~/components/calderyn";
import type { GuardrailConfig, Integration } from "~/lib/types";

// Only Shop + Guardrails are required; the stepper marks the rest so an
// 8-step wall doesn't read as 8 mandatory commitments.
const STEPS = [
  { key: "shopify", label: "Shop" },
  { key: "guardrails", label: "Guardrails" },
  { key: "google", label: "Google Ads (optional)" },
  { key: "meta", label: "Meta Ads (optional)" },
  { key: "quickbooks", label: "QuickBooks (optional)" },
  { key: "creative", label: "Creative mapping" },
  { key: "consent", label: "Consent" },
  { key: "complete", label: "Complete" },
] as const;

type LoaderPayload = {
  step: number;
  done: boolean;
  shopDomain: string;
  guardrails: GuardrailConfig | null;
  integrations: Record<string, Integration>;
  error: { code: string; message: string } | null;
  devBypass: boolean;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
  // External OAuth URL to open at the top level (escaping the embedded iframe).
  redirectUrl?: string;
};

// ⚠️ TEMPORARY PRE-LAUNCH BYPASS — REMOVE BEFORE REAL MERCHANTS GET ACCESS ⚠️
// Renders an onboarding "skip" button that jumps straight to the dashboard,
// bypassing guardrail setup and the privacy/peer-baseline consent step. This is
// a deliberate, known shortcut for testing before Google/QuickBooks OAuth is
// wired. It is now OFF by default and only enabled when ONBOARDING_DEV_BYPASS is
// explicitly set to "true" (e.g. on preview/staging) — it must never be "true"
// in the production merchant environment. Tracked in agent memory: onboarding-prod-bypass.
const ONBOARDING_DEV_BYPASS = process.env.ONBOARDING_DEV_BYPASS === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [state, guardrails, integrations] = await Promise.all([
      client.onboarding.getState(request.signal),
      client.guardrails.get(request.signal),
      client.integrations.list(request.signal),
    ]);
    return json<LoaderPayload>({
      step: state.step,
      done: state.done,
      shopDomain: session.shop,
      guardrails,
      integrations,
      error: null,
      devBypass: ONBOARDING_DEV_BYPASS,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      step: 0,
      done: false,
      shopDomain: session.shop,
      guardrails: null,
      integrations: {},
      error: { code: e.code ?? "ERROR", message: e.message },
      devBypass: ONBOARDING_DEV_BYPASS,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "advance") {
      const step = Number(formData.get("step") || 0);
      await client.onboarding.advance(step, request.signal);
      return json<ActionPayload>({ ok: true });
    }
    if (intent === "save_guardrails") {
      const patch: Partial<GuardrailConfig> = {
        daily_action_budget_cents: Math.max(0, Math.round(Number(formData.get("budget") || 0)) * 100),
        dollar_cap_cents: Math.max(0, Math.round(Number(formData.get("cap") || 0)) * 100),
        cooldown_minutes: Math.max(0, Math.round(Number(formData.get("cooldown") || 0))),
      };
      await client.guardrails.update(patch, request.signal);
      const step = Number(formData.get("step") || 0);
      await client.onboarding.advance(step, request.signal);
      return json<ActionPayload>({ ok: true, toast: { message: "Guardrails saved" } });
    }
    if (intent === "connect_integration") {
      const provider = String(formData.get("provider") || "") as IntegrationProvider;
      // Carry the embedded App Bridge `host` through the OAuth round-trip: the
      // provider callback lands at the top level (outside the admin iframe) and
      // needs host to redirect the merchant back INTO the embedded admin.
      const host = String(formData.get("host") || "") || null;
      const { redirectUrl } = await client.integrations.startOAuth(provider, host);
      // Don't 302 the iframe to the provider — third-party OAuth pages refuse to
      // be framed. Hand the URL back so the client opens it at the top level.
      return json<ActionPayload>({ ok: true, redirectUrl });
    }
    if (intent === "finish") {
      await client.onboarding.advance(STEPS.length, request.signal);
      return redirect("/app");
    }
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: "INVALID_INTENT", message: `Unknown intent: ${intent}` },
        toast: { message: "Unknown intent", isError: true },
      },
      { status: 400 },
    );
  } catch (err) {
    if (err instanceof Response) throw err;
    const e = err as CalderynError;
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: e.code ?? "ERROR", message: e.message },
        toast: { message: e.message, isError: true },
      },
      { status: e.status >= 400 && e.status < 600 ? e.status : 500 },
    );
  }
};

export default function Onboarding() {
  const { step, shopDomain, guardrails, integrations, error, devBypass } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  const safeStep = Math.min(Math.max(step, 0), STEPS.length - 1);
  const key = STEPS[safeStep].key;

  return (
    <Page title="Welcome to Calderyn" subtitle="A 4-minute setup that gets Calderyn watching your store.">
      <BlockStack gap="500">
        {devBypass && (
          <Banner tone="warning" title="Temporary testing shortcut">
            <BlockStack gap="200">
              <p>
                OAuth providers aren&apos;t fully wired yet. Skip setup to jump straight to the
                dashboard. This is a temporary pre-launch shortcut and must be removed before
                real merchants get access.
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="finish" />
                <Button submit loading={submitting} disabled={submitting}>
                  Skip setup → dashboard (dev only)
                </Button>
              </Form>
            </BlockStack>
          </Banner>
        )}
        {error && (
          <Banner tone="critical" title="Couldn't load onboarding state">
            <p>{error.message}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Onboarding action failed">
            <p>{actionData.error.message}</p>
          </Banner>
        )}

        <Card>
          <InlineStack gap="200" wrap>
            {STEPS.map((s, i) => (
              <Badge
                key={s.key}
                tone={i < safeStep ? "success" : i === safeStep ? "info" : undefined}
              >
                {`${i + 1}. ${s.label}`}
              </Badge>
            ))}
          </InlineStack>
        </Card>

        <Card>
          {key === "shopify" && (
            <ShopifyStep nextStep={safeStep + 1} shopDomain={shopDomain} submitting={submitting} />
          )}
          {key === "guardrails" && (
            <GuardrailsStep
              guardrails={guardrails}
              nextStep={safeStep + 1}
              submitting={submitting}
            />
          )}
          {(key === "google" || key === "meta" || key === "quickbooks") && (
            <OAuthStep
              provider={key}
              connected={providerPaired(integrations, key)}
              nextStep={safeStep + 1}
              prevStep={Math.max(0, safeStep - 1)}
              submitting={submitting}
            />
          )}
          {key === "creative" && (
            <CreativeStep nextStep={safeStep + 1} prevStep={safeStep - 1} submitting={submitting} />
          )}
          {key === "consent" && (
            <ConsentStep nextStep={safeStep + 1} prevStep={safeStep - 1} submitting={submitting} />
          )}
          {key === "complete" && (
            <CompleteStep prevStep={safeStep - 1} submitting={submitting} />
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}

function AdvanceForm({
  step,
  children,
}: {
  step: number;
  children: React.ReactNode;
}) {
  return (
    <Form method="post" style={{ display: "inline" }}>
      <input type="hidden" name="intent" value="advance" />
      <input type="hidden" name="step" value={String(step)} />
      {children}
    </Form>
  );
}

function ShopifyStep({
  nextStep,
  shopDomain,
  submitting,
}: {
  nextStep: number;
  shopDomain: string;
  submitting: boolean;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Confirm your Shopify shop
      </Text>
      <Text as="p" tone="subdued">
        Calderyn syncs the last 60 days of orders, inventory levels at every location, and
        product cost. This happens once and runs in the background.
      </Text>
      <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="100">
            <Text as="p" fontWeight="semibold">
              {shopDomain}
            </Text>
            <Badge tone="success">Connected</Badge>
          </BlockStack>
        </Box>
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <BlockStack gap="100">
            <Text as="p" fontWeight="semibold">
              First sync
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Calderyn is pulling products, orders, inventory, and webhooks. You can continue
              while the sync finishes in the background.
            </Text>
          </BlockStack>
        </Box>
      </InlineGrid>
      <InlineStack align="end">
        <AdvanceForm step={nextStep}>
          <Button submit variant="primary" loading={submitting} disabled={submitting}>
            Continue
          </Button>
        </AdvanceForm>
      </InlineStack>
    </BlockStack>
  );
}

function GuardrailsStep({
  guardrails,
  nextStep,
  submitting,
}: {
  guardrails: GuardrailConfig | null;
  nextStep: number;
  submitting: boolean;
}) {
  const [budget, setBudget] = useState(
    String(
      Math.round(
        (guardrails?.daily_action_budget_cents ?? DEFAULT_GUARDRAILS.daily_action_budget_cents) /
          100,
      ),
    ),
  );
  const [cap, setCap] = useState(
    String(Math.round((guardrails?.dollar_cap_cents ?? DEFAULT_GUARDRAILS.dollar_cap_cents) / 100)),
  );
  const [cooldown, setCooldown] = useState(
    String(guardrails?.cooldown_minutes ?? DEFAULT_GUARDRAILS.cooldown_minutes),
  );

  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Set your guardrails
      </Text>
      <Text as="p" tone="subdued">
        By default, Calderyn only acts when you approve it — nothing runs on its own. These
        limits apply if you later turn on Autopilot, and cap any action you approve. Every
        limit is enforced before a change reaches your ad accounts. You can adjust them
        anytime in Settings.
      </Text>
      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
        <GuardrailMeter
          usedCents={guardrails?.daily_action_budget_used_cents ?? 0}
          totalCents={Math.max(0, Number(budget) * 100)}
          checks={[
            {
              label: `Daily action budget · ${fmtMoney(Math.max(0, Number(budget) * 100))}`,
              ok: Number(budget) > 0,
            },
            {
              label: `Per-action cap · ${fmtMoney(Math.max(0, Number(cap) * 100))}`,
              ok: Number(cap) > 0,
            },
            { label: `Cooldown · ${cooldown} min between actions`, ok: true },
          ]}
        />
      </Box>
      <BlockStack gap="300">
        <TextField
          label="Daily action budget cap (USD)"
          type="number"
          value={budget}
          onChange={setBudget}
          autoComplete="off"
          helpText={`Used today: ${fmtMoney(
            guardrails?.daily_action_budget_used_cents ?? 0,
          )} of ${fmtMoney(Number(budget) * 100)}`}
        />
        <TextField
          label="Per-action dollar cap (USD)"
          type="number"
          value={cap}
          onChange={setCap}
          autoComplete="off"
          helpText="Single-action impact above this prompts re-authentication."
        />
        <TextField
          label="Cooldown between actions (minutes)"
          type="number"
          value={cooldown}
          onChange={setCooldown}
          autoComplete="off"
        />
        {/* The Back button renders its own <form>, so it must stay a sibling of
            this one — a form nested inside a form is dropped by the HTML parser
            and Back would silently submit save_guardrails instead. */}
        <InlineStack align="space-between">
          <BackButton step={Math.max(0, nextStep - 2)} submitting={submitting} />
          <Form method="post" style={{ display: "inline" }}>
            <input type="hidden" name="intent" value="save_guardrails" />
            <input type="hidden" name="step" value={String(nextStep)} />
            <input type="hidden" name="budget" value={budget} />
            <input type="hidden" name="cap" value={cap} />
            <input type="hidden" name="cooldown" value={cooldown} />
            <Button submit variant="primary" loading={submitting} disabled={submitting}>
              Continue
            </Button>
          </Form>
        </InlineStack>
      </BlockStack>
    </BlockStack>
  );
}

function OAuthStep({
  provider,
  connected,
  nextStep,
  prevStep,
  submitting,
}: {
  provider: IntegrationProvider;
  connected: boolean;
  nextStep: number;
  prevStep: number;
  submitting: boolean;
}) {
  // App Bridge appends `host` to the embedded URL; forward it on connect so the
  // OAuth callback can re-embed the merchant in the Shopify admin afterwards.
  const [searchParams] = useSearchParams();
  // Connect runs through its own fetcher so the provider's OAuth page can be
  // opened at the top level — embedded iframes can't load third-party OAuth
  // pages (they refuse to be framed).
  const connectFetcher = useFetcher<ActionPayload>();
  const connecting = connectFetcher.state !== "idle";
  useActionToast(connectFetcher.data ?? undefined);
  useEffect(() => {
    const url = connectFetcher.data?.redirectUrl;
    if (url) window.open(url, "_top");
  }, [connectFetcher.data]);
  const labels: Record<IntegrationProvider, { title: string; blurb: string }> = {
    google: {
      title: "Connect Google Ads",
      blurb:
        "Calderyn reads spend, impressions, and conversions to compute true ROAS. You can skip and connect later from Settings.",
    },
    meta: {
      title: "Connect Meta Ads",
      blurb:
        "Calderyn reads Meta Ads spend, attribution, and ad-set structure. You can skip and connect later from Settings.",
    },
    tiktok: {
      title: "Connect TikTok Ads",
      blurb:
        "Calderyn reads TikTok Ads spend and advertiser performance. You can skip and connect later from Settings.",
    },
    quickbooks: {
      title: "Connect QuickBooks (optional)",
      blurb:
        "Optional. Calderyn reads COGS journal entries to validate landed cost. Skip to use Shopify cost-per-item only.",
    },
  };
  const cfg = labels[provider];

  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        {cfg.title}
      </Text>
      <Text as="p" tone="subdued">
        {cfg.blurb}
      </Text>
      <Text as="p" tone="subdued" variant="bodySm">
        Clicking Connect opens the provider&apos;s secure sign-in in this window — you&apos;ll
        be brought back here after you approve access.
      </Text>
      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" fontWeight="semibold">
            {provider === "google" ? "Google Ads" : provider === "meta" ? "Meta Ads" : "QuickBooks Online"}
          </Text>
          {connected ? (
            <Badge tone="success">Connected</Badge>
          ) : (
            <connectFetcher.Form method="post">
              <input type="hidden" name="intent" value="connect_integration" />
              <input type="hidden" name="provider" value={provider} />
              <input type="hidden" name="host" value={searchParams.get("host") ?? ""} />
              <Button submit variant="primary" loading={connecting} disabled={connecting}>
                Connect
              </Button>
            </connectFetcher.Form>
          )}
        </InlineStack>
      </Box>
      <InlineStack align="space-between">
        <BackButton step={prevStep} submitting={submitting} />
        <InlineStack gap="200">
          {!connected && (
            <AdvanceForm step={nextStep}>
              <Button submit loading={submitting} disabled={submitting}>
                Skip for now
              </Button>
            </AdvanceForm>
          )}
          <AdvanceForm step={nextStep}>
            <Button
              submit
              variant="primary"
              loading={submitting}
              disabled={submitting || !connected}
            >
              Continue
            </Button>
          </AdvanceForm>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  );
}

function CreativeStep({
  nextStep,
  prevStep,
  submitting,
}: {
  nextStep: number;
  prevStep: number;
  submitting: boolean;
}) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Map creative to SKUs
      </Text>
      <Text as="p" tone="subdued">
        Calderyn auto-detects which SKU each ad creative drives from your campaign UTM tags and
        ad copy. You can review mappings after onboarding.
      </Text>
      <InlineStack align="space-between">
        <BackButton step={prevStep} submitting={submitting} />
        <AdvanceForm step={nextStep}>
          <Button submit variant="primary" loading={submitting} disabled={submitting}>
            Continue
          </Button>
        </AdvanceForm>
      </InlineStack>
    </BlockStack>
  );
}

function ConsentStep({
  nextStep,
  prevStep,
  submitting,
}: {
  nextStep: number;
  prevStep: number;
  submitting: boolean;
}) {
  const [consent, setConsent] = useState(true);
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Peer baseline (optional)
      </Text>
      <Text as="p" tone="subdued">
        Calderyn benchmarks your performance against anonymized peer shops in your category. Your
        shop ID is hashed with HMAC-SHA256 before any aggregation. Withdraw anytime — your data is
        purged within 30 days.
      </Text>
      <Checkbox
        label="I consent to contributing pseudonymous metrics to peer baselines."
        checked={consent}
        onChange={setConsent}
      />
      <InlineStack align="space-between">
        <BackButton step={prevStep} submitting={submitting} />
        <AdvanceForm step={nextStep}>
          <Button submit variant="primary" loading={submitting} disabled={submitting}>
            Continue
          </Button>
        </AdvanceForm>
      </InlineStack>
    </BlockStack>
  );
}

function CompleteStep({ prevStep, submitting }: { prevStep: number; submitting: boolean }) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        You&apos;re ready
      </Text>
      <Text as="p" tone="subdued">
        Calderyn is now watching your store. The first pass over your historical data is running
        — alerts will populate as detections complete.
      </Text>
      <InlineStack align="space-between">
        <BackButton step={prevStep} submitting={submitting} />
        <Form method="post">
          <input type="hidden" name="intent" value="finish" />
          <Button submit variant="primary" loading={submitting} disabled={submitting}>
            Open dashboard
          </Button>
        </Form>
      </InlineStack>
    </BlockStack>
  );
}

function BackButton({ step, submitting }: { step: number; submitting: boolean }) {
  return (
    <AdvanceForm step={step}>
      <Button submit loading={submitting} disabled={submitting}>
        Back
      </Button>
    </AdvanceForm>
  );
}
