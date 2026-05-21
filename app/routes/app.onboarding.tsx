import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
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
  CalderynError,
  calderynClient,
  type IntegrationProvider,
} from "~/lib/calderyn.server";
import { useActionToast } from "~/lib/toast";
import { fmtMoney } from "~/lib/format";
import type { GuardrailConfig, Integration } from "~/lib/types";

const STEPS = [
  { key: "shopify", label: "Shop" },
  { key: "guardrails", label: "Guardrails" },
  { key: "google", label: "Google Ads" },
  { key: "meta", label: "Meta Ads" },
  { key: "quickbooks", label: "QuickBooks" },
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
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

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
      const { redirectUrl } = await client.integrations.startOAuth(provider, request.signal);
      return redirect(redirectUrl);
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
  const { step, shopDomain, guardrails, integrations, error } =
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
        {error && (
          <Banner tone="critical" title="Couldn't load onboarding state">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Onboarding action failed">
            <p>
              {actionData.error.code}: {actionData.error.message}
            </p>
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
              connected={integrations[key]?.status === "connected"}
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
          {key === "complete" && <CompleteStep submitting={submitting} />}
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
    String(Math.round((guardrails?.daily_action_budget_cents ?? 250000) / 100)),
  );
  const [cap, setCap] = useState(
    String(Math.round((guardrails?.dollar_cap_cents ?? 100000) / 100)),
  );
  const [cooldown, setCooldown] = useState(String(guardrails?.cooldown_minutes ?? 30));

  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        Set your guardrails
      </Text>
      <Text as="p" tone="subdued">
        Calderyn will never execute an action that violates these. Every guardrail is enforced
        inside the action gateway before any external API call.
      </Text>
      <Form method="post">
        <input type="hidden" name="intent" value="save_guardrails" />
        <input type="hidden" name="step" value={String(nextStep)} />
        <input type="hidden" name="budget" value={budget} />
        <input type="hidden" name="cap" value={cap} />
        <input type="hidden" name="cooldown" value={cooldown} />
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
          <InlineStack align="space-between">
            <BackButton step={Math.max(0, nextStep - 2)} submitting={submitting} />
            <Button submit variant="primary" loading={submitting} disabled={submitting}>
              Continue
            </Button>
          </InlineStack>
        </BlockStack>
      </Form>
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
  const labels: Record<IntegrationProvider, { title: string; blurb: string; optional?: boolean }> = {
    google: {
      title: "Connect Google Ads",
      blurb: "Calderyn reads spend, impressions, and conversions to compute true ROAS. Required.",
    },
    meta: {
      title: "Connect Meta Ads",
      blurb: "Calderyn reads Meta Ads spend, attribution, and ad-set structure.",
    },
    quickbooks: {
      title: "Connect QuickBooks (optional)",
      blurb:
        "Optional. Calderyn reads COGS journal entries to validate landed cost. Skip to use Shopify cost-per-item only.",
      optional: true,
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
      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="p" fontWeight="semibold">
            {provider === "google" ? "Google Ads" : provider === "meta" ? "Meta Ads" : "QuickBooks Online"}
          </Text>
          {connected ? (
            <Badge tone="success">Connected</Badge>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="connect_integration" />
              <input type="hidden" name="provider" value={provider} />
              <Button submit variant="primary" loading={submitting} disabled={submitting}>
                Connect
              </Button>
            </Form>
          )}
        </InlineStack>
      </Box>
      <InlineStack align="space-between">
        <BackButton step={prevStep} submitting={submitting} />
        <InlineStack gap="200">
          {cfg.optional && (
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
              disabled={submitting || (!connected && !cfg.optional)}
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

function CompleteStep({ submitting }: { submitting: boolean }) {
  return (
    <BlockStack gap="400">
      <Text as="h2" variant="headingMd">
        You&apos;re ready
      </Text>
      <Text as="p" tone="subdued">
        Calderyn is now watching your store. The first pass over your historical data is running
        — alerts will populate as detections complete.
      </Text>
      <InlineStack align="end">
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
