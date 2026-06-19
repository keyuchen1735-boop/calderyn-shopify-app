import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect, unstable_createMemoryUploadHandler, unstable_parseMultipartFormData } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  CalderynError,
  calderynClient,
  type IntegrationProvider,
} from "~/lib/calderyn.server";
import { validateGuardrailPatch } from "~/lib/dashboard/guardrails-validation";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import {
  manualSyncCooldown,
  syncShopAds,
  formatSyncToast,
} from "~/lib/ads/manual-sync.server";
import { useActionToast, useConnectionToast } from "~/lib/toast";
import { fmtMoney, fmtMoneyDec } from "~/lib/format";
import {
  APIKEY_PROVIDERS,
  OAUTH_PROVIDERS,
  connectionNotice,
  integrationBadge,
  isApiKeyConnect,
  isConnectable,
  isOauthPending,
  isPaired,
  kindToProvider,
} from "~/lib/integrations";
import { GuardrailMeter } from "~/components/calderyn";
import { McpConnectGuide } from "~/components/McpConnectGuide";
import type { GuardrailConfig, Integration } from "~/lib/types";
import { missingWeightPct } from "~/lib/ship-cost/missing-weight";
import { saveTypedPeriodTotal, ingestInvoiceCsv, setManualOverride } from "~/lib/ship-cost/inputs.server";
import { getShopCountry } from "~/lib/ship-cost/shop-country.server";
import {
  getUnmatchedCharges,
  mapChargeToOrder,
  type UnmatchedCharges,
} from "~/lib/ship-cost/unmatched.server";
import { runShipCostResolution } from "~/lib/ship-cost/runner.server";

// ---------------------------------------------------------------------------
// Pure FormData validation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type ParseOk<T> = { ok: true; value: T };
export type ParseErr = { ok: false; message: string };

export interface PeriodTotalValue {
  totalCents: number;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export function parsePeriodTotalForm(
  fd: FormData,
): ParseOk<PeriodTotalValue> | ParseErr {
  const amount = Number(String(fd.get("amount") ?? "").trim());
  const carrier = String(fd.get("carrier") ?? "").trim() || null;
  const periodStart = String(fd.get("period_start") ?? "").trim();
  const periodEnd = String(fd.get("period_end") ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter a shipping total greater than $0." };
  }
  if (!periodStart || !periodEnd) {
    return { ok: false, message: "Enter both a start and end date for the period." };
  }
  return {
    ok: true,
    value: { totalCents: Math.round(amount * 100), carrier, periodStart, periodEnd },
  };
}

export interface ManualOverrideValue {
  orderId: string;
  /** null clears the override. */
  cents: number | null;
}

export function parseManualOverrideForm(
  fd: FormData,
): ParseOk<ManualOverrideValue> | ParseErr {
  const orderId = String(fd.get("order_id") ?? "").trim();
  const raw = String(fd.get("amount") ?? "").trim();
  if (!orderId) return { ok: false, message: "Missing order." };
  if (raw === "") return { ok: true, value: { orderId, cents: null } };
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, message: "Override must be $0 or more." };
  }
  return { ok: true, value: { orderId, cents: Math.round(amount * 100) } };
}

export interface ApiKeyConnectValue {
  provider: IntegrationProvider;
  apiKey: string;
}

/**
 * Validate the API-key connect form (EasyPost, contract C8) at the action
 * boundary — never trust the FormData shape. Rejects an unknown provider and an
 * empty key BEFORE any live probe / credential write. The live key validation
 * (a real EasyPost probe) happens server-side in connectApiKey.
 */
export function parseApiKeyConnectForm(
  fd: FormData,
): ParseOk<ApiKeyConnectValue> | ParseErr {
  const provider = String(fd.get("provider") ?? "").trim();
  const apiKey = String(fd.get("api_key") ?? "").trim();
  if (!(APIKEY_PROVIDERS as readonly string[]).includes(provider)) {
    return { ok: false, message: `Unknown provider: ${provider || "(none)"}` };
  }
  if (!apiKey) {
    // ShipBob pastes a Personal Access Token; EasyPost an API key (contract C8).
    return { ok: false, message: provider === "shipbob" ? "Paste your ShipBob token." : "Paste your EasyPost API key." };
  }
  return { ok: true, value: { provider: provider as IntegrationProvider, apiKey } };
}

export interface MapShipChargeValue {
  lineId: string;
  orderNumber: string;
}

/**
 * Validate the "map an unmatched carrier charge to an order" form (Phase 3 Part C) at the
 * action boundary — never trust FormData shape. Both fields required; the order-existence
 * check (and the real attach) happen server-side in mapChargeToOrder.
 */
export function parseMapShipChargeForm(
  fd: FormData,
): ParseOk<MapShipChargeValue> | ParseErr {
  const lineId = String(fd.get("line_id") ?? "").trim();
  const orderNumber = String(fd.get("order_number") ?? "").trim();
  if (!lineId) return { ok: false, message: "Missing charge." };
  if (!orderNumber) return { ok: false, message: "Enter an order number to map this charge to." };
  return { ok: true, value: { lineId, orderNumber } };
}

export function parseGuardrailForm(fd: FormData): Partial<GuardrailConfig> {
  const patch: Partial<GuardrailConfig> = {};
  const num = (key: keyof GuardrailConfig, raw: FormDataEntryValue | null, xform = (n: number) => n) => {
    if (raw === null) return;
    const n = Number(String(raw));
    if (Number.isFinite(n)) (patch as Record<string, unknown>)[key] = xform(n);
  };
  num("daily_action_budget_cents", fd.get("daily_action_budget_cents"), (n) => Math.max(0, Math.round(n)));
  num("dollar_cap_cents", fd.get("dollar_cap_cents"), (n) => Math.max(0, Math.round(n)));
  num("cooldown_minutes", fd.get("cooldown_minutes"), (n) => Math.max(0, Math.round(n)));
  if (fd.get("autopilot_enabled") !== null) {
    patch.autopilot_enabled = String(fd.get("autopilot_enabled")) === "true";
  }
  if (fd.get("autopilot_bypass_guardrails") !== null) {
    patch.autopilot_bypass_guardrails = String(fd.get("autopilot_bypass_guardrails")) === "true";
  }
  // Daily action cap: blank = Unlimited (null = no cap); otherwise the entered
  // value, passed through faithfully so validateGuardrailPatch (not a silent
  // round/clamp here) is the single arbiter of the 1..100-integer bound — this
  // keeps the embedded surface in lockstep with the dashboard's GuardrailField.
  const capRaw = fd.get("autopilot_daily_action_cap");
  if (capRaw !== null) {
    const s = String(capRaw).trim();
    if (s === "") patch.autopilot_daily_action_cap = null;
    else {
      const n = Number(s);
      if (Number.isFinite(n)) patch.autopilot_daily_action_cap = n;
    }
  }
  // Dollars -> cents needs rounding (cents are whole); the percent fields are
  // passed through unrounded so the validator rejects (visibly) a fractional or
  // out-of-range entry instead of silently rewriting it (e.g. 2.5 -> 3).
  num("autopilot_min_spend_cents", fd.get("autopilot_min_spend_cents"), (n) => Math.round(n * 100));
  num("autopilot_max_budget_cut_pct", fd.get("autopilot_max_budget_cut_pct"));
  num("autopilot_max_budget_increase_pct", fd.get("autopilot_max_budget_increase_pct"));
  // Daily ceiling: empty string clears it (null = no cap); otherwise dollars -> cents.
  const ceilRaw = fd.get("autopilot_max_daily_budget_cents");
  if (ceilRaw !== null) {
    const s = String(ceilRaw).trim();
    if (s === "") patch.autopilot_max_daily_budget_cents = null;
    else {
      const n = Number(s);
      if (Number.isFinite(n)) patch.autopilot_max_daily_budget_cents = Math.max(0, Math.round(n * 100));
    }
  }
  if (fd.get("business_hours_only") !== null) {
    patch.business_hours_only = String(fd.get("business_hours_only")) === "true";
  }
  const bhStart = fd.get("bh_start");
  const bhEnd = fd.get("bh_end");
  const bhTz = fd.get("bh_tz");
  if (bhStart !== null && bhEnd !== null && bhTz !== null) {
    patch.business_hours = { start: String(bhStart), end: String(bhEnd), tz: String(bhTz) };
  }
  return patch;
}

// ---------------------------------------------------------------------------

type LoaderPayload = {
  guardrails: GuardrailConfig | null;
  integrations: Record<string, Integration>;
  consent: boolean;
  error: { code: string; message: string } | null;
  shipMode: string;
  missingWeightPct: number;
  unmatchedCharges: UnmatchedCharges;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
  // External OAuth URL to open at the top level (escaping the embedded iframe).
  redirectUrl?: string;
  uploadResult?: { matched: number; unmatchedRefs: string[]; parseErrors: string[] };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [guardrails, integrations, consent] = await Promise.all([
      client.guardrails.get(request.signal),
      client.integrations.list(request.signal),
      client.consent.get(request.signal),
    ]);
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    const [{ data: settingsRow }, { data: orderRows }, unmatchedCharges] = await Promise.all([
      sb.from("shop_settings").select("ship_cost_mode").eq("shop_id", shopId).maybeSingle(),
      sb.from("v_order_ship_features").select("grams_sum").eq("shop_id", shopId),
      getUnmatchedCharges(sb, shopId),
    ]);
    const shipMode = (settingsRow?.ship_cost_mode as string | null) ?? "auto";
    const missingWeight = missingWeightPct(
      (orderRows ?? []).map((o: { grams_sum: number | null }) => ({ gramsSum: o.grams_sum ?? null })),
    );
    return json<LoaderPayload>({
      guardrails,
      integrations,
      consent,
      error: null,
      shipMode,
      missingWeightPct: missingWeight,
      unmatchedCharges,
    });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      guardrails: null,
      integrations: {},
      consent: false,
      error: { code: e.code ?? "ERROR", message: e.message },
      shipMode: "auto",
      missingWeightPct: 0,
      unmatchedCharges: { count: 0, items: [] },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);

  // CSV upload is multipart — handle before formData() consumes the stream.
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({ maxPartSize: 5_000_000 });
    const mp = await unstable_parseMultipartFormData(request, uploadHandler);
    if (String(mp.get("intent") || "") === "upload_invoice_csv") {
      try {
        const file = mp.get("file");
        const carrier = String(mp.get("carrier") || "").trim() || null;
        const periodStart = String(mp.get("period_start") || "").trim();
        const periodEnd = String(mp.get("period_end") || "").trim();
        if (!(file instanceof File) || file.size === 0) {
          return json<ActionPayload>(
            {
              ok: false,
              error: { code: "NO_FILE", message: "Choose a CSV file to upload." },
              toast: { message: "Choose a CSV file to upload.", isError: true },
            },
            { status: 422 },
          );
        }
        if (!periodStart || !periodEnd) {
          return json<ActionPayload>(
            {
              ok: false,
              error: { code: "INVALID_INPUT", message: "Enter the period dates the invoice covers." },
              toast: { message: "Enter the period dates.", isError: true },
            },
            { status: 422 },
          );
        }
        const csvText = await file.text();
        const sb = getSupabase();
        const shopId = await resolveShopId(session.shop);
        const result = await ingestInvoiceCsv(sb, shopId, {
          csvText,
          carrier,
          periodStart,
          periodEnd,
          shopCountry: await getShopCountry(sb, shopId),
        });
        const unmatchedRefs = result.unmatched.map((u) => u.orderRef ?? u.trackingNo ?? "?");
        return json<ActionPayload>({
          ok: true,
          uploadResult: {
            matched: result.matchedCount,
            unmatchedRefs,
            parseErrors: result.parseErrors.map((e) => `line ${e.line}: ${e.reason}`),
          },
          toast: {
            message:
              result.unmatched.length === 0 && result.parseErrors.length === 0
                ? `Invoice uploaded — ${result.matchedCount} orders matched`
                : `Uploaded — ${result.matchedCount} matched, ${result.unmatched.length} unmatched`,
            isError: false,
          },
        });
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
    }
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  try {
    if (intent === "set_consent") {
      // Real peer-baseline consent toggle (the button used to be inert). The
      // engine's moat emitter reads shops.peer_data_consent, so this directly
      // controls whether the shop contributes.
      const consent = String(formData.get("consent") || "") === "true";
      await client.consent.set(consent, request.signal);
      return json<ActionPayload>({
        ok: true,
        toast: {
          message: consent
            ? "Peer baseline enabled"
            : "Consent withdrawn — your contribution is purged within 30 days",
        },
      });
    }
    if (intent === "update_guardrails") {
      const patch = parseGuardrailForm(formData);
      if (validateGuardrailPatch(patch) !== null) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_GUARDRAILS", message: "Those guardrail values are out of range." },
            toast: { message: "Those guardrail values are out of range.", isError: true },
          },
          { status: 422 },
        );
      }
      await client.guardrails.update(patch, request.signal);
      return json<ActionPayload>({ ok: true, toast: { message: "Guardrails updated" } });
    }

    if (intent === "connect_integration") {
      const provider = String(formData.get("provider") || "") as IntegrationProvider;
      if (!(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
        throw new CalderynError({
          code: "INVALID_PROVIDER",
          status: 400,
          message: `Unknown provider: ${provider}`,
        });
      }
      // Carry the embedded App Bridge `host` through the OAuth round-trip: the
      // provider callback lands at the top level (outside the admin iframe) and
      // needs host to redirect the merchant back INTO the embedded admin.
      const host = String(formData.get("host") || "") || null;
      const { redirectUrl } = await client.integrations.startOAuth(provider, host);
      // Don't 302 the iframe to the provider — third-party OAuth pages refuse to
      // be framed. Hand the URL back so the client opens it at the top level.
      return json<ActionPayload>({ ok: true, redirectUrl });
    }

    if (intent === "connect_apikey_integration") {
      // API-key connect (EasyPost, contract C8): validate the FormData shape at the
      // boundary, then hand the key to the integrations client which live-probes and
      // stores it encrypted. Redirect on success so a refresh can't re-POST the key
      // (no double-submit); the one-shot ?<provider>=connected param drives the same
      // success banner the OAuth callbacks use.
      const parsed = parseApiKeyConnectForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_INPUT", message: parsed.message },
            toast: { message: parsed.message, isError: true },
          },
          { status: 422 },
        );
      }
      await client.integrations.connectApiKey(parsed.value.provider, parsed.value.apiKey);
      return redirect(`/app/settings?${parsed.value.provider}=connected`);
    }

    if (intent === "disconnect_integration") {
      const provider = String(formData.get("provider") || "");
      await client.integrations.disconnect(provider, request.signal);
      return json<ActionPayload>({
        ok: true,
        toast: { message: `Disconnected ${provider}` },
      });
    }

    if (intent === "sync_now") {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      // Cooldown is keyed on the most recent integration activity. updated_at is
      // bumped on every sync that touches a platform — success OR error — so a
      // failing connection still cools down. (A shop with no usable credentials
      // makes zero platform calls and just gets "nothing to sync", so it needs
      // no rate limit.)
      const { data: rows } = await sb
        .from("shop_integrations")
        .select("updated_at")
        .eq("shop_id", shopId)
        .in("kind", ["meta_ads", "google_ads", "tiktok_ads"]);
      const lastActivity = (rows ?? [])
        .map((r) => String(r.updated_at ?? ""))
        .filter((s) => s && !Number.isNaN(Date.parse(s)))
        .reduce<string | null>(
          (max, s) => (max === null || Date.parse(s) > Date.parse(max) ? s : max),
          null,
        );
      const verdict = manualSyncCooldown(lastActivity, Date.now());
      if (!verdict.allowed) {
        return json<ActionPayload>({
          ok: false,
          toast: {
            message: `Just synced — try again in ${verdict.retryAfterSec}s.`,
            isError: false,
          },
        });
      }
      const result = await syncShopAds(sb, shopId);
      const toast = formatSyncToast(result);
      return json<ActionPayload>({ ok: !toast.isError, toast });
    }

    if (intent === "set_ship_mode") {
      const mode = String(formData.get("ship_cost_mode") || "");
      if (!["auto", "force_measured", "force_reconciled"].includes(mode)) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_MODE", message: "Unknown mode." },
            toast: { message: "Unknown mode", isError: true },
          },
          { status: 400 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await sb
        .from("shop_settings")
        .upsert({ shop_id: shopId, ship_cost_mode: mode, updated_at: new Date().toISOString() });
      return json<ActionPayload>({ ok: true, toast: { message: "Shipping cost mode saved" } });
    }

    if (intent === "add_period_total") {
      const parsed = parsePeriodTotalForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_INPUT", message: parsed.message },
            toast: { message: parsed.message, isError: true },
          },
          { status: 422 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await saveTypedPeriodTotal(sb, shopId, {
        ...parsed.value,
        shopCountry: await getShopCountry(sb, shopId),
      });
      return json<ActionPayload>({ ok: true, toast: { message: "Shipping total saved — margins updated" } });
    }

    if (intent === "set_manual_override") {
      const parsed = parseManualOverrideForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_INPUT", message: parsed.message },
            toast: { message: parsed.message, isError: true },
          },
          { status: 422 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      await setManualOverride(sb, shopId, {
        ...parsed.value,
        shopCountry: await getShopCountry(sb, shopId),
      });
      return json<ActionPayload>({
        ok: true,
        toast: { message: parsed.value.cents == null ? "Override cleared" : "Override saved" },
      });
    }

    if (intent === "map_ship_charge") {
      // Part C: attach an unmatched carrier charge to an order, then re-resolve so the
      // order flips to actual_invoice and the unmatched count decrements.
      const parsed = parseMapShipChargeForm(formData);
      if (!parsed.ok) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "INVALID_INPUT", message: parsed.message },
            toast: { message: parsed.message, isError: true },
          },
          { status: 422 },
        );
      }
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      try {
        await mapChargeToOrder(sb, shopId, parsed.value.lineId, parsed.value.orderNumber);
      } catch (mapErr) {
        // An unknown order number (or a stale line) is merchant-correctable input, not a
        // 500 — surface it visibly (rule 12) and change nothing.
        const message = mapErr instanceof Error ? mapErr.message : "Couldn't map that charge.";
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "MAP_FAILED", message },
            toast: { message, isError: true },
          },
          { status: 422 },
        );
      }
      // Re-resolve so the newly-matched line is read as actual_invoice for its order.
      await runShipCostResolution(sb, shopId, { shopCountry: await getShopCountry(sb, shopId) });
      // Redirect (not json) so a refresh can't re-POST the mapping (no double-submit).
      return redirect("/app/settings?ship_charge=mapped");
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

export default function Settings() {
  const navigate = useEmbeddedNavigate();
  const { guardrails, integrations, consent, error, shipMode, missingWeightPct: missingWeight, unmatchedCharges } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  useActionToast(actionData);
  // One-shot pairing confirmation from the OAuth callback redirect
  // (e.g. ?google=connected or ?meta=error&reason=...).
  const [searchParams] = useSearchParams();
  const notice = connectionNotice(searchParams);
  useConnectionToast(notice);

  return (
    <Page
      fullWidth
      title="Settings"
      subtitle="Guardrails, integrations, and account data"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load settings">
            <p>{error.message}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Settings update failed">
            <p>{actionData.error.message}</p>
          </Banner>
        )}
        {notice &&
          (notice.ok ? (
            <Banner tone="success" title={`${notice.provider} connected`}>
              <p>
                Your {notice.provider} account is paired. We&rsquo;re syncing your recent
                data now — this can take a few minutes.
              </p>
            </Banner>
          ) : (
            <Banner tone="critical" title={`Couldn't connect ${notice.provider}`}>
              <p>
                {notice.reason
                  ? `The connection didn't complete (${notice.reason}). Try Connect again.`
                  : "The connection was cancelled or didn't complete. Try Connect again."}
              </p>
            </Banner>
          ))}

        <Layout>
          <Layout.AnnotatedSection
            id="guardrails"
            title="Guardrails"
            description="Enforced inside the action gateway before any external API call."
          >
            {guardrails ? (
              <GuardrailsCard guardrails={guardrails} />
            ) : (
              <Card>
                <Text as="p" tone="subdued">
                  Guardrails are unavailable.
                </Text>
              </Card>
            )}
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            id="integrations"
            title="Integrations"
            description="Connect ad-spend and accounting data sources."
          >
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm" tone="subdued">
                  Pull the latest campaigns and spend from your connected accounts.
                </Text>
                <SyncNowButton />
              </InlineStack>
              {Object.entries(integrations).map(([k, v]) => (
                <IntegrationCard key={k} provider={k} integration={v} />
              ))}
              {Object.keys(integrations).length === 0 && (
                <Card>
                  <Text as="p" tone="subdued">
                    No integrations available.
                  </Text>
                </Card>
              )}
            </BlockStack>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            id="claude-connector"
            title="Claude connector"
            description="Connect Claude (or Claude Code) to read your store over MCP."
          >
            <Card>
              <McpConnectGuide onManage={() => navigate("/app/mcp")} />
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            id="shipping-cost"
            title="Shipping cost"
            description="Tell Calderyn what you pay to ship, so margin reflects true cost."
          >
            <ShippingCostSection
              shipMode={shipMode}
              missingWeightPct={missingWeight}
              unmatchedCharges={unmatchedCharges}
            />
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            id="account-data"
            title="Account & data"
            description="Notifications, privacy, and removing Calderyn."
          >
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Notifications
                  </Text>
                  <Banner tone="info" title="Email and Slack notifications are coming soon">
                    Until then, new alerts appear on the Home screen and in the Alerts queue,
                    and every action Calderyn takes is recorded in the Action history.
                  </Banner>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Privacy & data residency
                  </Text>
                  <Banner
                    tone={consent ? "success" : "info"}
                    title={`Peer-baseline consent: ${consent ? "Enabled" : "Not enabled"}`}
                  >
                    Your shop_id is hashed with HMAC-SHA256 before any peer aggregate is read.
                    {consent
                      ? " Withdraw at any time; your contribution is purged within 30 days."
                      : " You are not contributing to peer baselines. Enable to benchmark against anonymized peer shops in your category."}
                  </Banner>
                  <ButtonGroup>
                    <Form method="post">
                      <input type="hidden" name="intent" value="set_consent" />
                      <input type="hidden" name="consent" value={consent ? "false" : "true"} />
                      <Button submit>{consent ? "Withdraw consent" : "Enable peer baseline"}</Button>
                    </Form>
                    <Button disabled>Download my data (GDPR)</Button>
                  </ButtonGroup>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Uninstall
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    When you uninstall Calderyn from your Shopify admin, we trigger a 28-table
                    cascade purge of all merchant data within 30 days.
                  </Text>
                  <Button tone="critical">Uninstall Calderyn</Button>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
  );
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  label: `${String(h).padStart(2, "0")}:00`,
  value: `${String(h).padStart(2, "0")}:00`,
}));

function GuardrailsCard({ guardrails }: { guardrails: GuardrailConfig }) {
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";
  const [budget, setBudget] = useState(String(Math.round(guardrails.daily_action_budget_cents / 100)));
  const [cap, setCap] = useState(String(Math.round(guardrails.dollar_cap_cents / 100)));
  const [cooldown, setCooldown] = useState(String(guardrails.cooldown_minutes));
  const [businessHoursOnly, setBusinessHoursOnly] = useState(guardrails.business_hours_only);
  const [bhStart, setBhStart] = useState(guardrails.business_hours.start);
  const [bhEnd, setBhEnd] = useState(guardrails.business_hours.end);
  const [bhTz] = useState(guardrails.business_hours.tz);
  const [autopilotEnabled, setAutopilotEnabled] = useState(guardrails.autopilot_enabled);
  const [autopilotBypass, setAutopilotBypass] = useState(guardrails.autopilot_bypass_guardrails);
  // Blank string represents null (Unlimited / no daily cap).
  const [autopilotDailyActionCap, setAutopilotDailyActionCap] = useState(
    guardrails.autopilot_daily_action_cap == null
      ? ""
      : String(guardrails.autopilot_daily_action_cap),
  );
  const [autopilotMinSpend, setAutopilotMinSpend] = useState(
    String(Math.round(guardrails.autopilot_min_spend_cents / 100)),
  );
  const [autopilotMaxBudgetCutPct, setAutopilotMaxBudgetCutPct] = useState(
    String(guardrails.autopilot_max_budget_cut_pct),
  );
  const [autopilotMaxBudgetIncreasePct, setAutopilotMaxBudgetIncreasePct] = useState(
    String(guardrails.autopilot_max_budget_increase_pct),
  );
  const [autopilotMaxDailyBudget, setAutopilotMaxDailyBudget] = useState(
    guardrails.autopilot_max_daily_budget_cents == null
      ? ""
      : String(Math.round(guardrails.autopilot_max_daily_budget_cents / 100)),
  );

  useEffect(() => {
    setBudget(String(Math.round(guardrails.daily_action_budget_cents / 100)));
    setCap(String(Math.round(guardrails.dollar_cap_cents / 100)));
    setCooldown(String(guardrails.cooldown_minutes));
    setBusinessHoursOnly(guardrails.business_hours_only);
    setBhStart(guardrails.business_hours.start);
    setBhEnd(guardrails.business_hours.end);
    setAutopilotEnabled(guardrails.autopilot_enabled);
    setAutopilotBypass(guardrails.autopilot_bypass_guardrails);
    setAutopilotDailyActionCap(
      guardrails.autopilot_daily_action_cap == null
        ? ""
        : String(guardrails.autopilot_daily_action_cap),
    );
    setAutopilotMinSpend(String(Math.round(guardrails.autopilot_min_spend_cents / 100)));
    setAutopilotMaxBudgetCutPct(String(guardrails.autopilot_max_budget_cut_pct));
    setAutopilotMaxBudgetIncreasePct(String(guardrails.autopilot_max_budget_increase_pct));
    setAutopilotMaxDailyBudget(
      guardrails.autopilot_max_daily_budget_cents == null
        ? ""
        : String(Math.round(guardrails.autopilot_max_daily_budget_cents / 100)),
    );
  }, [guardrails]);

  return (
    <Card>
      <BlockStack gap="400">
        <Box padding="300" background="bg-surface-secondary" borderRadius="200">
          <GuardrailMeter
            usedCents={guardrails.daily_action_budget_used_cents}
            totalCents={guardrails.daily_action_budget_cents}
            checks={[
              {
                label: `Within daily budget · ${fmtMoney(
                  guardrails.daily_action_budget_cents - guardrails.daily_action_budget_used_cents,
                )} left`,
                ok:
                  guardrails.daily_action_budget_cents -
                    guardrails.daily_action_budget_used_cents >
                  0,
              },
              {
                label: `Business hours · ${guardrails.business_hours.start}–${guardrails.business_hours.end}`,
                ok: guardrails.in_business_hours,
              },
            ]}
          />
        </Box>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="update_guardrails" />
        <input
          type="hidden"
          name="daily_action_budget_cents"
          value={String(Math.max(0, Number(budget) * 100))}
        />
        <input
          type="hidden"
          name="dollar_cap_cents"
          value={String(Math.max(0, Number(cap) * 100))}
        />
        <input
          type="hidden"
          name="cooldown_minutes"
          value={String(Math.max(0, Number(cooldown)))}
        />
        <input
          type="hidden"
          name="autopilot_enabled"
          value={autopilotEnabled ? "true" : "false"}
        />
        <input
          type="hidden"
          name="autopilot_bypass_guardrails"
          value={autopilotBypass ? "true" : "false"}
        />
        {/* Empty string => Unlimited (no daily cap). Non-empty => positive int. */}
        <input
          type="hidden"
          name="autopilot_daily_action_cap"
          value={autopilotDailyActionCap.trim()}
        />
        {/* Pass the raw entry through; parseGuardrailForm + validateGuardrailPatch
            are the single arbiters (no client-side clamp that hides invalid input). */}
        <input
          type="hidden"
          name="autopilot_min_spend_cents"
          value={autopilotMinSpend.trim()}
        />
        <input
          type="hidden"
          name="autopilot_max_budget_cut_pct"
          value={autopilotMaxBudgetCutPct.trim()}
        />
        <input
          type="hidden"
          name="autopilot_max_budget_increase_pct"
          value={autopilotMaxBudgetIncreasePct.trim()}
        />
        {/* Empty string => clear the ceiling (no limit). Non-empty => dollars. */}
        <input
          type="hidden"
          name="autopilot_max_daily_budget_cents"
          value={autopilotMaxDailyBudget.trim()}
        />
        <input
          type="hidden"
          name="business_hours_only"
          value={businessHoursOnly ? "true" : "false"}
        />
        <input type="hidden" name="bh_start" value={bhStart} />
        <input type="hidden" name="bh_end" value={bhEnd} />
        <input type="hidden" name="bh_tz" value={bhTz} />
        <BlockStack gap="400">
          <FormLayout>
            <FormLayout.Group>
              <TextField
                label="Total dollar value of changes Calderyn can make per day (USD)"
                type="number"
                value={budget}
                autoComplete="off"
                onChange={setBudget}
                helpText={`Used today: ${fmtMoney(guardrails.daily_action_budget_used_cents)}`}
              />
              <TextField
                label="Require my approval for any change bigger than (USD)"
                type="number"
                value={cap}
                autoComplete="off"
                onChange={setCap}
                helpText="Single-action impact above this prompts re-authentication."
              />
            </FormLayout.Group>
            <FormLayout.Group>
              <TextField
                label="Minimum wait between changes to the same campaign (minutes)"
                type="number"
                value={cooldown}
                autoComplete="off"
                onChange={setCooldown}
                helpText="Prevents thrash on the same campaign / SKU."
              />
            </FormLayout.Group>
            <Checkbox
              label="Only act during business hours"
              checked={businessHoursOnly}
              onChange={setBusinessHoursOnly}
              helpText={`When on, Calderyn will only take actions between the hours below (${bhTz}).`}
            />
            {businessHoursOnly && (
              <FormLayout.Group>
                <Select
                  label="Business hours start"
                  options={HOUR_OPTIONS}
                  value={bhStart}
                  onChange={setBhStart}
                />
                <Select
                  label="Business hours end"
                  options={HOUR_OPTIONS}
                  value={bhEnd}
                  onChange={setBhEnd}
                />
              </FormLayout.Group>
            )}
          </FormLayout>

          {/* Autopilot lives in its own tinted sub-card so its limits never read
              as more of the hard guardrails above; the limit fields only appear
              once it's switched on — reinforcing that autopilot is off by default. */}
          <Box
            padding="400"
            background="bg-surface-secondary"
            borderColor="border"
            borderWidth="025"
            borderRadius="200"
          >
            <BlockStack gap="300">
              <Checkbox
                label="Let Calderyn pause money-losing campaigns on its own"
                checked={autopilotEnabled}
                onChange={setAutopilotEnabled}
                helpText="Off by default. When on, Calderyn can pause or trim losing campaigns within the limits below. Every automatic action is logged and can be undone."
              />
              {autopilotEnabled && (
                <Box paddingBlockStart="300" borderColor="border" borderBlockStartWidth="025">
                  <BlockStack gap="300">
                    <Checkbox
                      label="Bypass all guardrails (act on everything immediately)"
                      checked={autopilotBypass}
                      onChange={setAutopilotBypass}
                      helpText="DANGER: ignores every limit below — daily action cap, minimum spend, the approval dollar cap, cooldown, and business hours. Autopilot will act on every eligible campaign as soon as it's detected. Change sizes still follow the cut/raise % below, and actions are still logged and reversible."
                    />
                    <Text as="h3" variant="headingSm">
                      Autopilot limits
                    </Text>
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="Most automatic changes per day"
                          type="number"
                          value={autopilotDailyActionCap}
                          autoComplete="off"
                          onChange={setAutopilotDailyActionCap}
                          helpText="Calderyn will not take more than this many automatic actions in a single day. Leave blank for no daily cap (unlimited)."
                        />
                        <TextField
                          label="Ignore campaigns that have spent less than (USD)"
                          type="number"
                          value={autopilotMinSpend}
                          autoComplete="off"
                          onChange={setAutopilotMinSpend}
                          helpText="Campaigns with less than this trailing spend are skipped — not enough data."
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="Most Calderyn can cut a campaign's budget at once (%)"
                          type="number"
                          value={autopilotMaxBudgetCutPct}
                          autoComplete="off"
                          onChange={setAutopilotMaxBudgetCutPct}
                          helpText="Budget-reduction actions will not cut more than this percentage in a single step."
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="Most Calderyn can raise a winning campaign's budget at once (%)"
                          type="number"
                          value={autopilotMaxBudgetIncreasePct}
                          autoComplete="off"
                          onChange={setAutopilotMaxBudgetIncreasePct}
                          helpText="Budget scale-ups will not add more than this percentage in a single step."
                        />
                        <TextField
                          label="Never let a campaign's daily budget exceed (USD, optional)"
                          type="number"
                          value={autopilotMaxDailyBudget}
                          autoComplete="off"
                          onChange={setAutopilotMaxDailyBudget}
                          helpText="Leave blank for no ceiling. Autopilot will not scale a budget above this."
                        />
                      </FormLayout.Group>
                    </FormLayout>
                  </BlockStack>
                </Box>
              )}
            </BlockStack>
          </Box>

          <InlineStack align="end">
            <Button submit variant="primary" loading={submitting} disabled={submitting}>
              Save guardrails
            </Button>
          </InlineStack>
        </BlockStack>
        </fetcher.Form>
      </BlockStack>
    </Card>
  );
}

function SyncNowButton() {
  // Own fetcher so the refresh runs in place without navigating; toast surfaces
  // the per-platform result (and the cooldown notice when rate-limited).
  const fetcher = useFetcher<ActionPayload>();
  const syncing = fetcher.state !== "idle";
  useActionToast(fetcher.data ?? undefined);
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="sync_now" />
      <Button submit loading={syncing} disabled={syncing}>
        {syncing ? "Syncing…" : "Sync now"}
      </Button>
    </fetcher.Form>
  );
}

function IntegrationCard({
  provider,
  integration,
}: {
  provider: string;
  integration: Integration;
}) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
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
  // `provider` is the persisted integration kind (e.g. "meta_ads"); connect and
  // disconnect speak the provider short name (e.g. "meta", "easypost").
  const oauthProvider = kindToProvider(provider);
  // An OAUTH_PENDING provider is in OAUTH_PROVIDERS so isConnectable is true, but its OAuth
  // handshake isn't live — an active Connect would always 501, so show a disabled "Coming
  // soon" badge instead. (The set is currently empty — ShipHero, the former member, is now an
  // API-key/refresh-token paste, not OAuth.) Check pending BEFORE rendering Connect.
  const oauthPending = isOauthPending(provider);
  const canConnect = isConnectable(provider) && !oauthPending;
  // EasyPost / ShipBob / ShipHero connect by a credential PASTE, not OAuth — render an inline
  // key/token field + Save instead of the Connect button (C8).
  const apiKeyConnect = isApiKeyConnect(provider);
  // A "pending" integration is paired (OAuth done) but still backfilling — show
  // it as Connected with a Disconnect button, not as a fresh Connect prompt.
  const paired = isPaired(integration.status);
  const badge = integrationBadge(integration.status);
  const [apiKey, setApiKey] = useState("");

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {integration.name}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {integration.detail}
            </Text>
          </BlockStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {paired ? (
              <Form method="post">
                <input type="hidden" name="intent" value="disconnect_integration" />
                <input type="hidden" name="provider" value={oauthProvider} />
                <Button submit tone="critical" loading={submitting} disabled={submitting}>
                  Disconnect
                </Button>
              </Form>
            ) : canConnect ? (
              <connectFetcher.Form method="post">
                <input type="hidden" name="intent" value="connect_integration" />
                <input type="hidden" name="provider" value={oauthProvider} />
                <input type="hidden" name="host" value={searchParams.get("host") ?? ""} />
                <Button submit variant="primary" loading={connecting} disabled={connecting}>
                  Connect
                </Button>
              </connectFetcher.Form>
            ) : oauthPending ? (
              // OAuth handshake not live yet — disabled affordance, not a Connect that 501s.
              <Button disabled>Coming soon</Button>
            ) : apiKeyConnect ? null : (
              <Badge>Managed by Shopify</Badge>
            )}
          </InlineStack>
        </InlineStack>

        {/* API-key connect form (EasyPost): inline so the merchant pastes the key
            in place. The action live-probes + stores it encrypted, then redirects
            back here (no double-submit). Only shown when not already paired. */}
        {apiKeyConnect && !paired && (
          <connectFetcher.Form method="post">
            <input type="hidden" name="intent" value="connect_apikey_integration" />
            <input type="hidden" name="provider" value={oauthProvider} />
            <FormLayout>
              <TextField
                label={
                  oauthProvider === "shipbob"
                    ? `${integration.name} access token`
                    : oauthProvider === "shiphero"
                      ? `${integration.name} refresh token`
                      : `${integration.name} API key`
                }
                name="api_key"
                value={apiKey}
                onChange={setApiKey}
                autoComplete="off"
                type="password"
                helpText={
                  oauthProvider === "shipbob"
                    ? "Paste a ShipBob Personal Access Token with the billing_read scope. We verify it, then store it encrypted."
                    : oauthProvider === "shiphero"
                      ? "In ShipHero, go to My Account → Developer Users, create a 3rd Party Developer user, and paste its Refresh Token here. We verify it, then store it encrypted."
                      : "Paste your EasyPost production API key. We verify it, then store it encrypted."
                }
              />
              <InlineStack align="end">
                <Button
                  submit
                  variant="primary"
                  loading={connecting}
                  disabled={connecting || apiKey.trim() === ""}
                >
                  Save key
                </Button>
              </InlineStack>
            </FormLayout>
          </connectFetcher.Form>
        )}
      </BlockStack>
    </Card>
  );
}

function ShippingCostSection({
  shipMode,
  missingWeightPct,
  unmatchedCharges,
}: {
  shipMode: string;
  missingWeightPct: number;
  unmatchedCharges: UnmatchedCharges;
}) {
  const actionData = useActionData<typeof action>();
  const [mode, setMode] = useState(shipMode);
  const upload = actionData?.uploadResult;
  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Mode
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="set_ship_mode" />
            <FormLayout>
              <Select
                label="How Calderyn estimates each order's shipping cost"
                name="ship_cost_mode"
                value={mode}
                onChange={setMode}
                options={[
                  { label: "Automatic (recommended)", value: "auto" },
                  { label: "Always use measured (invoice) costs", value: "force_measured" },
                  { label: "Always allocate from my period total", value: "force_reconciled" },
                ]}
                helpText="Automatic picks the most trustworthy source per order: an invoice line, else an allocation of your period total."
              />
              <InlineStack align="end">
                <Button submit variant="primary">
                  Save mode
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>

      {missingWeightPct > 0 && (
        <Banner tone="warning" title={`${missingWeightPct}% of your orders are missing weight`}>
          <p>
            Shipping estimates are degraded for those orders. Add product weights in Shopify to
            improve per-order accuracy.
          </p>
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Period total
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Enter what you actually paid your carrier for a period. Calderyn allocates it across
            that period&rsquo;s orders by weight and destination.
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="add_period_total" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Total paid (USD)" name="amount" type="number" autoComplete="off" />
                <TextField label="Carrier (optional)" name="carrier" autoComplete="off" />
              </FormLayout.Group>
              <FormLayout.Group>
                <TextField label="Period start" name="period_start" type="date" autoComplete="off" />
                <TextField label="Period end" name="period_end" type="date" autoComplete="off" />
              </FormLayout.Group>
              <InlineStack align="end">
                <Button submit variant="primary">
                  Save total
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingSm">
            Upload a carrier invoice (CSV)
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            We match each line to an order by order number, then by tracking number. Unmatched
            lines are listed below so nothing is silently dropped.
          </Text>
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="upload_invoice_csv" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Period start" name="period_start" type="date" autoComplete="off" />
                <TextField label="Period end" name="period_end" type="date" autoComplete="off" />
              </FormLayout.Group>
              <TextField label="Carrier (optional)" name="carrier" autoComplete="off" />
              <input type="file" name="file" accept=".csv,text/csv" />
              <InlineStack align="end">
                <Button submit variant="primary">
                  Upload invoice
                </Button>
              </InlineStack>
            </FormLayout>
          </Form>
          {upload && (
            <BlockStack gap="200">
              <Banner
                tone={upload.unmatchedRefs.length || upload.parseErrors.length ? "warning" : "success"}
              >
                <p>{upload.matched} lines matched to orders.</p>
                {upload.unmatchedRefs.length > 0 && (
                  <p>
                    {upload.unmatchedRefs.length} unmatched (review):{" "}
                    {upload.unmatchedRefs.join(", ")}
                  </p>
                )}
                {upload.parseErrors.length > 0 && (
                  <p>Skipped rows: {upload.parseErrors.join("; ")}</p>
                )}
              </Banner>
            </BlockStack>
          )}
        </BlockStack>
      </Card>

      <UnmatchedChargesCard unmatchedCharges={unmatchedCharges} />

      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Per-order correction
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Override a single order&rsquo;s shipping cost. Enter the order ID and an amount, or
            leave the amount blank to clear an override.
          </Text>
          <Form method="post">
            <input type="hidden" name="intent" value="set_manual_override" />
            <FormLayout>
              <FormLayout.Group>
                <TextField label="Order ID" name="order_id" autoComplete="off" />
                <TextField
                  label="Shipping cost (USD)"
                  name="amount"
                  type="number"
                  autoComplete="off"
                  helpText="Blank clears the override."
                />
              </FormLayout.Group>
              <InlineStack align="end">
                <Button submit>Save override</Button>
              </InlineStack>
            </FormLayout>
          </Form>
        </BlockStack>
      </Card>
    </BlockStack>
  );
}

// Human-readable reason for why a carrier charge couldn't be matched (rule 12 visibility).
const UNMATCHED_REASON_LABEL: Record<string, string> = {
  no_ref: "No order reference or tracking on the charge",
  no_tracking_match: "Order ref / tracking didn't match an order",
  carrier_adjustment_no_link: "Carrier adjustment with no link back",
};

/**
 * Part C (embedded, interactive): surface connector charges that matched NO order so they
 * are visible and merchant-resolvable, never silently dropped (rule 12). When the count is
 * 0 the whole block renders nothing (no empty-state noise). Each row offers a "Map to order"
 * field that submits intent="map_ship_charge" → attaches the line + re-resolves.
 */
function UnmatchedChargesCard({ unmatchedCharges }: { unmatchedCharges: UnmatchedCharges }) {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  if (unmatchedCharges.count === 0) return null;
  const { count, items } = unmatchedCharges;
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Unmatched carrier charges
        </Text>
        <Banner tone="warning">
          <p>
            {count} carrier {count === 1 ? "charge" : "charges"} couldn&rsquo;t be matched to an
            order, so {count === 1 ? "it isn't" : "they aren't"} counted in margin yet. Map each to
            an order below.
          </p>
        </Banner>
        <BlockStack gap="300">
          {items.map((it) => (
            <Box
              key={it.id}
              padding="300"
              borderColor="border"
              borderWidth="025"
              borderRadius="200"
            >
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <BlockStack gap="050">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {fmtMoneyDec(it.costCents)}
                      {it.provider ? ` · ${it.provider}` : ""}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {it.orderRef ? `Ref ${it.orderRef}` : "No ref"}
                      {it.trackingNo ? ` · Tracking ${it.trackingNo}` : ""}
                    </Text>
                  </BlockStack>
                  <Badge tone="attention">
                    {UNMATCHED_REASON_LABEL[it.reason] ?? it.reason}
                  </Badge>
                </InlineStack>
                <Form method="post">
                  <input type="hidden" name="intent" value="map_ship_charge" />
                  <input type="hidden" name="line_id" value={it.id} />
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Map to order number"
                        labelHidden
                        name="order_number"
                        placeholder="Order number (e.g. 1001)"
                        autoComplete="off"
                      />
                      <InlineStack align="start" blockAlign="end">
                        <Button submit loading={submitting} disabled={submitting}>
                          Map to order
                        </Button>
                      </InlineStack>
                    </FormLayout.Group>
                  </FormLayout>
                </Form>
              </BlockStack>
            </Box>
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
