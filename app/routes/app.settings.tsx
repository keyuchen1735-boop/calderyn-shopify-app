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
import { json } from "@remix-run/node";
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
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  CalderynError,
  calderynClient,
  type IntegrationProvider,
} from "~/lib/calderyn.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import {
  manualSyncCooldown,
  syncShopAds,
  formatSyncToast,
} from "~/lib/ads/manual-sync.server";
import { useActionToast, useConnectionToast } from "~/lib/toast";
import { fmtMoney } from "~/lib/format";
import {
  OAUTH_PROVIDERS,
  connectionNotice,
  integrationBadge,
  isConnectable,
  isPaired,
  kindToProvider,
} from "~/lib/integrations";
import { GuardrailMeter } from "~/components/calderyn";
import type { GuardrailConfig, Integration } from "~/lib/types";

type LoaderPayload = {
  guardrails: GuardrailConfig | null;
  integrations: Record<string, Integration>;
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
  // External OAuth URL to open at the top level (escaping the embedded iframe).
  redirectUrl?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [guardrails, integrations] = await Promise.all([
      client.guardrails.get(request.signal),
      client.integrations.list(request.signal),
    ]);
    return json<LoaderPayload>({ guardrails, integrations, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
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
    if (intent === "update_guardrails") {
      const patch: Partial<GuardrailConfig> = {};
      const setIfPresent = <K extends keyof GuardrailConfig>(
        key: K,
        parser: (raw: string) => GuardrailConfig[K] | undefined,
      ) => {
        const raw = formData.get(key as string);
        if (raw === null) return;
        const value = parser(String(raw));
        if (value !== undefined) patch[key] = value;
      };
      setIfPresent("daily_action_budget_cents", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });
      setIfPresent("dollar_cap_cents", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });
      setIfPresent("cooldown_minutes", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });
      // Autopilot fields
      const rawAutopilot = formData.get("autopilot_enabled");
      if (rawAutopilot !== null) {
        patch.autopilot_enabled = String(rawAutopilot) === "true";
      }
      setIfPresent("autopilot_daily_action_cap", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });
      setIfPresent("autopilot_min_spend_cents", (v) => {
        // form submits dollars; store as cents
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n * 100)) : undefined;
      });
      setIfPresent("autopilot_max_budget_cut_pct", (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.round(n)) : undefined;
      });

      await client.guardrails.update(patch, request.signal);
      return json<ActionPayload>({
        ok: true,
        toast: { message: "Guardrails updated" },
      });
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
  const { guardrails, integrations, error } = useLoaderData<typeof loader>();
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
                    and every action Calderyn takes is recorded in the Audit log.
                  </Banner>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Privacy & data residency
                  </Text>
                  <Banner tone="info" title="Peer-baseline consent: Enabled">
                    Your shop_id is hashed with HMAC-SHA256 before any peer aggregate is read.
                    Withdraw consent at any time; your contribution is purged within 30 days.
                  </Banner>
                  <ButtonGroup>
                    <Button>Withdraw consent</Button>
                    <Button>Download my data (GDPR)</Button>
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

function GuardrailsCard({ guardrails }: { guardrails: GuardrailConfig }) {
  const fetcher = useFetcher<typeof action>();
  const submitting = fetcher.state !== "idle";
  const [budget, setBudget] = useState(String(Math.round(guardrails.daily_action_budget_cents / 100)));
  const [cap, setCap] = useState(String(Math.round(guardrails.dollar_cap_cents / 100)));
  const [cooldown, setCooldown] = useState(String(guardrails.cooldown_minutes));
  const [autopilotEnabled, setAutopilotEnabled] = useState(guardrails.autopilot_enabled);
  const [autopilotDailyActionCap, setAutopilotDailyActionCap] = useState(
    String(guardrails.autopilot_daily_action_cap),
  );
  const [autopilotMinSpend, setAutopilotMinSpend] = useState(
    String(Math.round(guardrails.autopilot_min_spend_cents / 100)),
  );
  const [autopilotMaxBudgetCutPct, setAutopilotMaxBudgetCutPct] = useState(
    String(guardrails.autopilot_max_budget_cut_pct),
  );

  useEffect(() => {
    setBudget(String(Math.round(guardrails.daily_action_budget_cents / 100)));
    setCap(String(Math.round(guardrails.dollar_cap_cents / 100)));
    setCooldown(String(guardrails.cooldown_minutes));
    setAutopilotEnabled(guardrails.autopilot_enabled);
    setAutopilotDailyActionCap(String(guardrails.autopilot_daily_action_cap));
    setAutopilotMinSpend(String(Math.round(guardrails.autopilot_min_spend_cents / 100)));
    setAutopilotMaxBudgetCutPct(String(guardrails.autopilot_max_budget_cut_pct));
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
          name="autopilot_daily_action_cap"
          value={String(Math.max(0, Number(autopilotDailyActionCap)))}
        />
        <input
          type="hidden"
          name="autopilot_min_spend_cents"
          value={String(Math.max(0, Number(autopilotMinSpend)))}
        />
        <input
          type="hidden"
          name="autopilot_max_budget_cut_pct"
          value={String(Math.max(0, Number(autopilotMaxBudgetCutPct)))}
        />
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
              <TextField
                label="Business hours"
                value={`${guardrails.business_hours.start}–${guardrails.business_hours.end}`}
                autoComplete="off"
                disabled
                helpText={`Timezone: ${guardrails.business_hours.tz}`}
              />
            </FormLayout.Group>
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
                          helpText="Calderyn will not take more than this many automatic actions in a single day."
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
  // disconnect speak the OAuth provider short name (e.g. "meta").
  const oauthProvider = kindToProvider(provider);
  const canConnect = isConnectable(provider);
  // A "pending" integration is paired (OAuth done) but still backfilling — show
  // it as Connected with a Disconnect button, not as a fresh Connect prompt.
  const paired = isPaired(integration.status);
  const badge = integrationBadge(integration.status);

  return (
    <Card>
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
          ) : (
            <Badge>Managed by Shopify</Badge>
          )}
        </InlineStack>
      </InlineStack>
    </Card>
  );
}
