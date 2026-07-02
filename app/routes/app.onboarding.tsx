import { useEffect, useRef, useState } from "react";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
 data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineStack,
  Modal,
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
import { provisionShop } from "~/lib/supabase.server";
import { useActionToast } from "~/lib/toast";
import { providerPaired } from "~/lib/integrations";
import { DEFAULT_GUARDRAILS } from "~/lib/guardrail-defaults";
import { digitsOnly, fmtGroup } from "~/lib/format";
import { Icon } from "~/components/calderyn";
import { BrandGlyph, type BrandName } from "~/components/calderyn/brand-icons";
import type { GuardrailConfig } from "~/lib/types";

// 5-step redesign (2026-06): Shop, Guardrails ("Set your limits"), Connect (all four
// ad/accounting providers on one screen), Consent, Complete. Mirrors the server-side
// ONBOARDING_STEPS in calderyn.server.ts; the index drives this wizard.
const STEPS = [
  { key: "shopify", label: "Shop" },
  { key: "guardrails", label: "Set your limits" },
  { key: "connect", label: "Connect accounts" },
  { key: "consent", label: "Compare" },
  { key: "complete", label: "Complete" },
] as const;

// The four onboarding OAuth providers shown on the single Connect screen. `id` is
// the OAuth provider short-name (what connect_integration + the status poll speak);
// `brand` indexes the shared BrandGlyph registry.
const CONNECT_PROVIDERS: ReadonlyArray<{
  id: "google" | "meta" | "tiktok" | "quickbooks";
  brand: BrandName;
  name: string;
}> = [
  { id: "google", brand: "google", name: "Google Ads" },
  { id: "meta", brand: "meta", name: "Meta Ads" },
  { id: "tiktok", brand: "tiktok", name: "TikTok Ads" },
  { id: "quickbooks", brand: "quickbooks", name: "QuickBooks" },
];

const ACCENT = "#23556e";

type PairedMap = { google: boolean; meta: boolean; tiktok: boolean; quickbooks: boolean };

type LoaderPayload = {
  step: number;
  shopDomain: string;
  shopName: string | null;
  shopLive: boolean;
  guardrails: GuardrailConfig | null;
  paired: PairedMap;
  consent: boolean;
  error: { code: string; message: string } | null;
  devBypass: boolean;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
  // External OAuth URL the client opens in a NEW TAB (escaping the embedded iframe).
  redirectUrl?: string;
};

// ⚠️ TEMPORARY PRE-LAUNCH BYPASS — REMOVE BEFORE REAL MERCHANTS GET ACCESS ⚠️
// Off by default; only enabled when ONBOARDING_DEV_BYPASS === "true" (preview/staging).
// Must never be "true" in production. Tracked in agent memory: onboarding-prod-bypass.
const ONBOARDING_DEV_BYPASS = process.env.ONBOARDING_DEV_BYPASS === "true";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Self-heal a missed install-time provision (afterAuth swallows its errors), so a
  // fresh merchant never dead-ends. provisionShop is idempotent.
  try {
    await provisionShop(session.shop);
  } catch (err) {
    console.error(`[onboarding.loader] provisionShop failed for ${session.shop}`, err);
  }

  const client = calderynClient(session.shop);
  try {
    const [state, guardrails, integrations, consent] = await Promise.all([
      client.onboarding.getState(request.signal),
      client.guardrails.get(request.signal),
      client.integrations.list(request.signal),
      client.consent.get(request.signal),
    ]);

    const safeStep = Math.min(Math.max(state.step, 0), STEPS.length - 1);

    // Step 1 "Connected to your store" does a REAL, live Admin API round-trip instead
    // of a hardcoded badge — proves the offline token actually works for this shop.
    // Only on the shopify step (avoids an Admin call on every wizard transition).
    let shopName: string | null = null;
    let shopLive = false;
    if (STEPS[safeStep].key === "shopify") {
      try {
        const resp = await admin.graphql(
          `#graphql
          query OnboardingShopCheck { shop { name myshopifyDomain } }`,
        );
        const body = (await resp.json()) as {
          data?: { shop?: { name?: string | null; myshopifyDomain?: string | null } };
        };
        shopName = body?.data?.shop?.name ?? null;
        shopLive = Boolean(body?.data?.shop);
      } catch (e) {
        console.error(`[onboarding.loader] live shop check failed for ${session.shop}`, e);
        shopLive = false;
      }
    }

    return data<LoaderPayload>({
      step: state.step,
      shopDomain: session.shop,
      shopName,
      shopLive,
      guardrails,
      paired: {
        google: providerPaired(integrations, "google"),
        meta: providerPaired(integrations, "meta"),
        tiktok: providerPaired(integrations, "tiktok"),
        quickbooks: providerPaired(integrations, "quickbooks"),
      },
      consent,
      error: null,
      devBypass: ONBOARDING_DEV_BYPASS,
    });
  } catch (err) {
    const e = err as CalderynError;
    return data<LoaderPayload>({
      step: 0,
      shopDomain: session.shop,
      shopName: null,
      shopLive: false,
      guardrails: null,
      paired: { google: false, meta: false, tiktok: false, quickbooks: false },
      consent: false,
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
      return data<ActionPayload>({ ok: true });
    }
    if (intent === "save_guardrails") {
      const budget = Number(formData.get("budget"));
      const cap = Number(formData.get("cap"));
      // Validate at the boundary (don't trust FormData): a $0 / blank / NaN budget or
      // cap would silently disable the guardrail it represents. Reject the no-op.
      // Cooldown is intentionally NOT touched here — the redesigned step dropped that
      // field, so an existing cooldown stays as the merchant last set it.
      if (!(budget > 0) || !(cap > 0)) {
        const message = "Enter a daily budget and per-action cap greater than $0.";
        return data<ActionPayload>(
          { ok: false, error: { code: "INVALID_GUARDRAILS", message }, toast: { message, isError: true } },
          { status: 400 },
        );
      }
      const patch: Partial<GuardrailConfig> = {
        daily_action_budget_cents: Math.round(budget) * 100,
        dollar_cap_cents: Math.round(cap) * 100,
      };
      await client.guardrails.update(patch, request.signal);
      const step = Number(formData.get("step") || 0);
      await client.onboarding.advance(step, request.signal);
      return data<ActionPayload>({ ok: true, toast: { message: "Limits saved" } });
    }
    if (intent === "connect_integration") {
      const provider = String(formData.get("provider") || "") as IntegrationProvider;
      const host = String(formData.get("host") || "") || null;
      // popup=true: the provider callback lands on the standalone /auth/connected page,
      // and the client opens this URL in a NEW TAB (window.open _blank).
      const { redirectUrl } = await client.integrations.startOAuth(provider, host, true);
      return data<ActionPayload>({ ok: true, redirectUrl });
    }
    if (intent === "save_consent") {
      const consent = formData.get("consent") === "true";
      await client.consent.set(consent, request.signal);
      const step = Number(formData.get("step") || 0);
      await client.onboarding.advance(step, request.signal);
      return data<ActionPayload>({
        ok: true,
        toast: { message: consent ? "Added to the comparison" : "Saved — not added to the comparison" },
      });
    }
    if (intent === "finish") {
      await client.onboarding.advance(STEPS.length, request.signal);
      return redirect("/app");
    }
    return data<ActionPayload>(
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
    return data<ActionPayload>(
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
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  const safeStep = Math.min(Math.max(data.step, 0), STEPS.length - 1);
  const key = STEPS[safeStep].key;

  const goStep = (step: number) =>
    submit({ intent: "advance", step: String(step) }, { method: "post" });
  const finish = () => submit({ intent: "finish" }, { method: "post" });

  return (
    <Page narrowWidth>
      <BlockStack gap="400">
        {data.error && (
          <Banner tone="critical" title="Couldn't load setup">
            <p>{data.error.message}</p>
          </Banner>
        )}
        {actionData?.error && actionData.error.code !== "INVALID_GUARDRAILS" && (
          <Banner tone="critical" title="Setup action failed">
            <p>{actionData.error.message}</p>
          </Banner>
        )}

        <ProgressDots step={safeStep} />

        <Card padding="600">
          {key === "shopify" && (
            <ShopStep
              shopDomain={data.shopDomain}
              shopName={data.shopName}
              shopLive={data.shopLive}
              submitting={submitting}
              onNext={() => goStep(safeStep + 1)}
            />
          )}
          {key === "guardrails" && (
            <GuardrailsStep
              guardrails={data.guardrails}
              submitting={submitting}
              onBack={() => goStep(safeStep - 1)}
              onSave={(budget, cap) =>
                submit(
                  { intent: "save_guardrails", step: String(safeStep + 1), budget, cap },
                  { method: "post" },
                )
              }
            />
          )}
          {key === "connect" && (
            <ConnectStep
              initialPaired={data.paired}
              submitting={submitting}
              onBack={() => goStep(safeStep - 1)}
              onContinue={() => goStep(safeStep + 1)}
            />
          )}
          {key === "consent" && (
            <ConsentStep
              consent={data.consent}
              submitting={submitting}
              onBack={() => goStep(safeStep - 1)}
              onSave={(consent) =>
                submit(
                  { intent: "save_consent", step: String(safeStep + 1), consent: consent ? "true" : "false" },
                  { method: "post" },
                )
              }
            />
          )}
          {key === "complete" && <CompleteStep submitting={submitting} onFinish={finish} />}
        </Card>

        {data.devBypass && key !== "complete" && (
          <InlineStack align="center">
            <Button variant="plain" tone="critical" onClick={finish} disabled={submitting}>
              Skip setup → dashboard (dev only)
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Page>
  );
}

/* ───────────────────────────── shared bits ───────────────────────────── */

function ProgressDots({ step }: { step: number }) {
  return (
    <InlineStack align="center" gap="200">
      {STEPS.map((s, i) => (
        <span
          key={s.key}
          aria-hidden="true"
          style={{
            width: i === step ? 22 : 8,
            height: 8,
            borderRadius: 999,
            background: i <= step ? ACCENT : "#d8d8d8",
            transition: "width .25s ease, background .25s ease",
          }}
        />
      ))}
    </InlineStack>
  );
}

function CircleIcon({ tone }: { tone: "success" | "pending" }) {
  const bg = tone === "success" ? "#e7f5ec" : "#fdf3da";
  const color = tone === "success" ? "#1a7f4f" : "#9a7400";
  return (
    <span
      style={{
        width: 56,
        height: 56,
        borderRadius: 14,
        background: bg,
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={tone === "success" ? "check" : "clock"} size={28} strokeWidth={2.4} />
    </span>
  );
}

function StepHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <BlockStack gap="100" inlineAlign="center">
      <Text as="h2" variant="headingLg" alignment="center">
        {title}
      </Text>
      <Text as="p" tone="subdued" alignment="center">
        {sub}
      </Text>
    </BlockStack>
  );
}

/* ───────────────────────────── step 1: shop ───────────────────────────── */

function ShopStep({
  shopDomain,
  shopName,
  shopLive,
  submitting,
  onNext,
}: {
  shopDomain: string;
  shopName: string | null;
  shopLive: boolean;
  submitting: boolean;
  onNext: () => void;
}) {
  return (
    <BlockStack gap="500">
      <BlockStack gap="300" inlineAlign="center">
        <CircleIcon tone={shopLive ? "success" : "pending"} />
        <StepHeading
          title={shopLive ? "Calderyn is connected to your store" : "Connecting to your store"}
          sub={
            shopLive
              ? "Now syncing your orders, inventory, and costs."
              : "We're confirming the live connection — this updates on its own."
          }
        />
      </BlockStack>

      <Box borderWidth="025" borderColor="border" borderRadius="300" background="bg-surface-secondary" padding="400">
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
          <InlineStack gap="300" blockAlign="center" wrap={false}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: "#f4f4f5",
                border: "1px solid #ececec",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "none",
              }}
            >
              <BrandGlyph name="shopify" size={18} />
            </span>
            <BlockStack gap="050">
              <Text as="p" fontWeight="semibold">
                {shopName ?? shopDomain}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {shopLive ? "Shopify · syncing now" : "Shopify · confirming connection"}
              </Text>
            </BlockStack>
          </InlineStack>
          <Badge tone={shopLive ? "success" : "attention"}>{shopLive ? "Connected" : "Checking…"}</Badge>
        </InlineStack>
      </Box>

      <Button variant="primary" fullWidth size="large" onClick={onNext} loading={submitting} disabled={submitting}>
        Get started
      </Button>
    </BlockStack>
  );
}

/* ───────────────────────────── step 2: guardrails ───────────────────────────── */

function GuardrailRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Box borderWidth="025" borderColor="border" borderRadius="300" padding="400">
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
        <div style={{ width: 132 }}>
          <TextField
            label={label}
            labelHidden
            type="text"
            inputMode="numeric"
            prefix="$"
            value={fmtGroup(value)}
            onChange={(v) => onChange(digitsOnly(v))}
            autoComplete="off"
          />
        </div>
      </InlineStack>
    </Box>
  );
}

function GuardrailsStep({
  guardrails,
  submitting,
  onBack,
  onSave,
}: {
  guardrails: GuardrailConfig | null;
  submitting: boolean;
  onBack: () => void;
  onSave: (budget: string, cap: string) => void;
}) {
  const [budget, setBudget] = useState(
    String(
      Math.round(
        (guardrails?.daily_action_budget_cents ?? DEFAULT_GUARDRAILS.daily_action_budget_cents) / 100,
      ),
    ),
  );
  const [cap, setCap] = useState(
    String(Math.round((guardrails?.dollar_cap_cents ?? DEFAULT_GUARDRAILS.dollar_cap_cents) / 100)),
  );
  const valid = Number(budget) > 0 && Number(cap) > 0;

  return (
    <BlockStack gap="500">
      <StepHeading title="Set your limits" sub="Calderyn never spends more than this. Change it anytime." />

      <BlockStack gap="300">
        <GuardrailRow label="Spend at most per day" value={budget} onChange={setBudget} />
        <GuardrailRow label="Ask me before any change over" value={cap} onChange={setCap} />
        {!valid && (
          <InlineStack gap="150" blockAlign="center">
            <span style={{ color: "#b3300f", display: "inline-flex" }}>
              <Icon name="x" size={14} strokeWidth={2.4} />
            </span>
            <Text as="span" variant="bodySm" tone="critical">
              Enter an amount greater than $0.
            </Text>
          </InlineStack>
        )}
      </BlockStack>

      <InlineStack gap="300" wrap={false}>
        <Button size="large" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <div style={{ flex: 1 }}>
          <Button
            variant="primary"
            fullWidth
            size="large"
            onClick={() => onSave(budget, cap)}
            loading={submitting}
            disabled={submitting || !valid}
          >
            Continue
          </Button>
        </div>
      </InlineStack>
    </BlockStack>
  );
}

/* ───────────────────────────── step 3: connect ───────────────────────────── */

type ConnState = "idle" | "connecting" | "connected";

function ConnectStep({
  initialPaired,
  submitting,
  onBack,
  onContinue,
}: {
  initialPaired: PairedMap;
  submitting: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [searchParams] = useSearchParams();
  const host = searchParams.get("host") ?? "";
  const statusUrl = `/app/onboarding/status?${searchParams.toString()}`;

  const connectFetcher = useFetcher<ActionPayload>();
  const statusFetcher = useFetcher<{
    ok: boolean;
    google: boolean;
    meta: boolean;
    tiktok: boolean;
    quickbooks: boolean;
  }>();
  useActionToast(connectFetcher.data ?? undefined);

  const [status, setStatus] = useState<Record<string, ConnState>>(() => {
    const seed: Record<string, ConnState> = {};
    for (const p of CONNECT_PROVIDERS) seed[p.id] = initialPaired[p.id] ? "connected" : "idle";
    return seed;
  });
  const [skipOpen, setSkipOpen] = useState(false);

  const pendingProviderRef = useRef<string | null>(null);
  // Handle to the tab we pre-open in the click gesture (see connect()); set its
  // location once the server returns the provider URL.
  const pendingTabRef = useRef<Window | null>(null);
  const lastOpenedRef = useRef<string | null>(null);
  // Set when a re-check is allowed to REVERT a still-connecting provider to idle
  // (the merchant returned to this tab without finishing) — only focus/visibility
  // re-checks set it, so the background poll never reverts a live attempt.
  const revertPendingRef = useRef(false);

  // Stable handle to the status poll so the interval/focus effects don't depend on
  // the (re-created-each-render) fetcher object.
  const loadStatus = () => statusFetcher.load(statusUrl);
  const loadStatusRef = useRef(loadStatus);
  loadStatusRef.current = loadStatus;

  const connect = (id: string) => {
    // Open the new tab SYNCHRONOUSLY inside the click gesture so the browser
    // doesn't block it as a popup, then point it at the provider URL once the
    // server mints it (third-party OAuth pages can't be framed in the admin iframe).
    pendingTabRef.current = window.open("about:blank", "_blank");
    pendingProviderRef.current = id;
    setStatus((prev) => ({ ...prev, [id]: "connecting" }));
    connectFetcher.submit(
      { intent: "connect_integration", provider: id, host },
      { method: "post", action: "/app/onboarding" },
    );
  };

  // Point the pre-opened tab at the provider URL once the action returns it. On a
  // setup failure (no redirectUrl — e.g. provider not configured) close the
  // placeholder tab and revert the row; the reason surfaces via the action toast.
  useEffect(() => {
    const d = connectFetcher.data;
    if (!d) return;
    if (d.redirectUrl && d.redirectUrl !== lastOpenedRef.current) {
      lastOpenedRef.current = d.redirectUrl;
      const win = pendingTabRef.current;
      if (win && !win.closed) win.location.href = d.redirectUrl;
      else window.open(d.redirectUrl, "_blank");
    } else if (d.ok === false) {
      if (pendingTabRef.current && !pendingTabRef.current.closed) pendingTabRef.current.close();
      const id = pendingProviderRef.current;
      if (id) setStatus((prev) => (prev[id] === "connecting" ? { ...prev, [id]: "idle" } : prev));
    }
  }, [connectFetcher.data]);

  // Apply fresh pairing status from the poll. A normal tick only ever UPGRADES to
  // connected, so a transient read (ok:false) can't downgrade the UI. A focus/
  // visibility re-check (revertPendingRef) additionally reverts a still-connecting
  // provider that never paired back to idle — the merchant came back without
  // finishing, so it shouldn't spin forever (and connectingCount→0 stops the poll).
  useEffect(() => {
    const d = statusFetcher.data;
    if (!d || !d.ok) return;
    const revert = revertPendingRef.current;
    revertPendingRef.current = false;
    setStatus((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const p of CONNECT_PROVIDERS) {
        if (d[p.id]) {
          if (next[p.id] !== "connected") {
            next[p.id] = "connected";
            changed = true;
          }
        } else if (revert && next[p.id] === "connecting") {
          next[p.id] = "idle";
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [statusFetcher.data]);

  const connectingCount = CONNECT_PROVIDERS.filter((p) => status[p.id] === "connecting").length;
  const connectedCount = CONNECT_PROVIDERS.filter((p) => status[p.id] === "connected").length;
  // Read inside the (mount-once) focus listener without re-subscribing each render.
  const connectingCountRef = useRef(0);
  connectingCountRef.current = connectingCount;

  // Poll while any provider is mid-connect (its new tab is open). Stops once all
  // resolve. The server's shop_integrations row is the source of truth.
  useEffect(() => {
    if (connectingCount === 0) return;
    loadStatusRef.current();
    const h = window.setInterval(() => loadStatusRef.current(), 3000);
    return () => window.clearInterval(h);
  }, [connectingCount]);

  // Returning focus to the setup tab (after the new tab) triggers an immediate
  // re-check, so a paired provider flips to Connected without waiting for the next
  // poll — and an unfinished one reverts to idle (revertPendingRef). Skip the fetch
  // entirely when nothing is connecting.
  useEffect(() => {
    const recheck = () => {
      if (connectingCountRef.current === 0) return;
      revertPendingRef.current = true;
      loadStatusRef.current();
    };
    const onVis = () => {
      if (document.visibilityState === "visible") recheck();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const continueLabel = connectedCount === 0 ? "Skip for now" : "Continue";
  const onPrimary = () => {
    if (connectedCount === 0) setSkipOpen(true);
    else onContinue();
  };

  return (
    <BlockStack gap="500">
      <StepHeading title="Connect your accounts" sub="Optional. Connect now, or later from Settings." />

      <BlockStack gap="200">
        {CONNECT_PROVIDERS.map((p) => {
          const st = status[p.id];
          return (
            <Box key={p.id} borderWidth="025" borderColor="border" borderRadius="300" padding="300">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <span
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 9,
                      background: "#f4f4f5",
                      border: "1px solid #ececec",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "none",
                    }}
                  >
                    <BrandGlyph name={p.brand} size={18} />
                  </span>
                  <BlockStack gap="025">
                    <Text as="p" fontWeight="semibold">
                      {p.name}
                    </Text>
                    {st === "connecting" && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Finish sign-in in the new tab
                      </Text>
                    )}
                  </BlockStack>
                </InlineStack>

                {st === "connected" ? (
                  <Badge tone="success">Connected</Badge>
                ) : st === "connecting" ? (
                  <Button disabled>Connecting…</Button>
                ) : (
                  <Button onClick={() => connect(p.id)} disabled={connectFetcher.state !== "idle"}>
                    Connect
                  </Button>
                )}
              </InlineStack>
            </Box>
          );
        })}
      </BlockStack>

      <InlineStack gap="300" wrap={false}>
        <Button size="large" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <div style={{ flex: 1 }}>
          <Button variant="primary" fullWidth size="large" onClick={onPrimary} loading={submitting} disabled={submitting}>
            {continueLabel}
          </Button>
        </div>
      </InlineStack>

      <Modal
        open={skipOpen}
        onClose={() => setSkipOpen(false)}
        title="Skip connecting accounts?"
        primaryAction={{ content: "Connect an account", onAction: () => setSkipOpen(false) }}
        secondaryActions={[
          {
            content: "Skip anyway",
            onAction: () => {
              setSkipOpen(false);
              onContinue();
            },
          },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            Calderyn will still track your orders and inventory, but it can&apos;t measure your true
            ROAS or ad waste until an account is connected. You can do this anytime from Settings.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

/* ───────────────────────────── step 4: consent ───────────────────────────── */

function ConsentStep({
  consent: initial,
  submitting,
  onBack,
  onSave,
}: {
  consent: boolean;
  submitting: boolean;
  onBack: () => void;
  onSave: (consent: boolean) => void;
}) {
  // Opt-in: seed from the stored value so Continue never silently enrolls a merchant.
  const [consent, setConsent] = useState(initial);
  return (
    <BlockStack gap="500">
      <StepHeading
        title="See how you compare"
        sub="Calderyn can show how your sales and ad spend stack up against similar stores."
      />

      <Box
        borderWidth="025"
        borderColor={consent ? "border-emphasis" : "border"}
        borderRadius="300"
        background={consent ? "bg-surface-secondary" : "bg-surface"}
        padding="400"
      >
        <Checkbox
          label="Add my store to the comparison"
          helpText="No one sees your store's numbers, only group averages. Turn off anytime."
          checked={consent}
          onChange={setConsent}
        />
      </Box>

      <InlineStack gap="300" wrap={false}>
        <Button size="large" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <div style={{ flex: 1 }}>
          <Button
            variant="primary"
            fullWidth
            size="large"
            onClick={() => onSave(consent)}
            loading={submitting}
            disabled={submitting}
          >
            Continue
          </Button>
        </div>
      </InlineStack>
    </BlockStack>
  );
}

/* ───────────────────────────── step 5: complete ───────────────────────────── */

function CompleteStep({ submitting, onFinish }: { submitting: boolean; onFinish: () => void }) {
  return (
    <BlockStack gap="500">
      <BlockStack gap="300" inlineAlign="center">
        <CircleIcon tone="success" />
        <StepHeading
          title="You're all set"
          sub="Calderyn is watching your store. Alerts will appear as they come in."
        />
      </BlockStack>
      <Button variant="primary" fullWidth size="large" onClick={onFinish} loading={submitting} disabled={submitting}>
        Open dashboard
      </Button>
    </BlockStack>
  );
}
