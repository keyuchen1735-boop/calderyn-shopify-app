import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  BlockStack,
  Banner,
  Box,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  InlineStack,
  Link,
  Modal,
  Page,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
// Campaigns load from the live Meta API, where c.id is the Meta external id (e.g.
// "1234567890"), but executeAction keys off the ad_campaign_dim UUID. The route
// reverse-looks-up that UUID (resolveCampaignDimId) and, when found, runs the
// action through the orchestrator (idempotency + ownership + audit in one place).
// When the campaign has not been ingested into ad_campaign_dim yet, it falls back
// to the legacy direct-Meta path (ownership verified via listCampaigns) so the
// page still works pre-ingest.
import { executeAction, type ExecutableKind } from "~/lib/actions/execute.server";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { metaClientForShop } from "~/lib/meta/client.server";
import { listCampaigns, setCampaignStatus, getCampaignStatus } from "~/lib/meta/campaigns.server";
import { useActionToast } from "~/lib/toast";
import { fmtMoney } from "~/lib/format";
import type { ActionKind, Alert, Campaign } from "~/lib/types";

type PendingAction =
  | { kind: "pause"; campaign: Campaign }
  | { kind: "resume"; campaign: Campaign }
  | { kind: "edit_budget"; campaign: Campaign };

type LoaderPayload = {
  campaigns: Campaign[];
  alerts: Alert[];
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
    // Ingested campaigns from v_campaigns_flat cover EVERY connected platform
    // (Meta, Google, TikTok). When Meta is live-connected, its rows are replaced
    // by the live API list (works pre-ingest, fresher status); other platforms
    // always come from the ingested view.
    const ingested = await client.campaigns.list(request.signal);
    const meta = await metaClientForShop(session.shop);
    let campaigns: Campaign[];
    if (meta) {
      const live = await listCampaigns(meta.client, meta.adAccountId);
      const liveMeta = live.map((c) => ({
        id: c.id,
        name: c.name,
        platform: "Meta" as const,
        status: c.status === "PAUSED" ? ("paused" as const) : ("active" as const),
        daily_budget_cents: c.dailyBudgetCents ?? 0,
        roas_7d: 0,
        contribution_margin: 0,
        spend_7d: 0,
      }));
      campaigns = [...liveMeta, ...ingested.filter((c) => c.platform !== "Meta")];
    } else {
      campaigns = ingested;
    }
    const alerts = await client.alerts.list({}, request.signal);
    return json<LoaderPayload>({ campaigns, alerts, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      campaigns: [],
      alerts: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const campaignId = String(formData.get("campaignId") || "");
  const campaignName = String(formData.get("campaignName") || "");
  const platform = String(formData.get("platform") || "");
  const idempotencyKey =
    String(formData.get("idempotencyKey") || "") || newIdempotencyKey();

  if (!campaignId) {
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: "INVALID_REQUEST", message: "campaignId is required" },
        toast: { message: "Missing campaign", isError: true },
      },
      { status: 400 },
    );
  }

  let kind: ActionKind;
  const params: Record<string, unknown> = {
    campaign_id: campaignId,
    target: `${platform} · ${campaignName}`,
  };

  switch (intent) {
    case "pause":
      kind = "pause_campaign";
      params.desired_status = "paused";
      break;
    case "resume":
      kind = "pause_campaign";
      params.desired_status = "active";
      break;
    case "edit_budget": {
      kind = "reduce_campaign_budget";
      const newCents = Math.max(0, Math.round(Number(formData.get("dailyBudgetCents") || 0)));
      params.daily_budget_cents = newCents;
      break;
    }
    default:
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "INVALID_INTENT", message: `Unknown intent: ${intent}` },
          toast: { message: "Unknown intent", isError: true },
        },
        { status: 400 },
      );
  }

  // Preferred path: run the action through the orchestrator (idempotency +
  // cross-tenant ownership guard + single audit row live there). Meta rows post
  // the platform external id (live API list) — resolveCampaignDimId maps it to
  // the dim UUID; null means "not ingested yet" → fall through to the legacy
  // direct-Meta path below. Non-Meta rows (Google, TikTok) come from
  // v_campaigns_flat, so the posted id already IS the dim UUID.
  {
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    const dimId =
      platform === "Meta"
        ? await resolveCampaignDimId(sb, shopId, "meta", campaignId)
        : campaignId;
    if (dimId) {
      const orchestratedKind: ExecutableKind =
        intent === "pause"
          ? "pause_campaign"
          : intent === "resume"
            ? "resume_campaign"
            : "reduce_campaign_budget";
      try {
        const { outcome } = await executeAction(
          shopId,
          {
            alertId: null,
            kind: orchestratedKind,
            campaignId: dimId,
            idempotencyKey,
            dailyBudgetCents:
              intent === "edit_budget"
                ? (params.daily_budget_cents as number)
                : undefined,
          },
          sb,
        );
        if (outcome === "failed") {
          return json<ActionPayload>(
            {
              ok: false,
              error: { code: "ACTION_FAILED", message: `Could not ${intent} ${campaignName}` },
              toast: { message: `Could not ${intent} ${campaignName}`, isError: true },
            },
            { status: 502 },
          );
        }
        if (outcome === "retrying") {
          // Transient platform failure parked for the retry cron — the action
          // has NOT taken effect yet, so do not report success (rule 12).
          return json<ActionPayload>(
            {
              ok: false,
              error: { code: "ACTION_RETRYING", message: `Couldn't reach the ad platform — ${intent} for ${campaignName} is queued and will retry automatically` },
              toast: { message: `${campaignName}: queued, will retry automatically` },
            },
            { status: 202 },
          );
        }
        const messageByIntent: Record<string, string> = {
          pause: `Paused ${campaignName}`,
          resume: `Resumed ${campaignName}`,
          edit_budget: `Updated budget for ${campaignName}`,
        };
        return json<ActionPayload>({
          ok: true,
          toast: { message: messageByIntent[intent] ?? "Action executed" },
        });
      } catch (err) {
        const e = err as CalderynError;
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: e.code ?? "ACTION_FAILED", message: e.message },
            toast: { message: e.message, isError: true },
          },
          { status: e.status >= 400 && e.status < 600 ? e.status : 500 },
        );
      }
    }
  }

  // For pause/resume, call Meta first, then record the real pre/post status.
  if (intent === "pause" || intent === "resume") {
    const desired = intent === "pause" ? "PAUSED" : "ACTIVE";
    const meta = await metaClientForShop(session.shop);
    if (!meta) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "META_NOT_CONNECTED", message: "Connect Meta in Settings first." },
          toast: { message: "Meta not connected", isError: true },
        },
        { status: 400 },
      );
    }
    try {
      // SECURITY: verify the campaign actually belongs to this shop's connected
      // ad account before mutating it — never trust the campaignId/name posted in
      // the form. Use the account's own campaign name for the audit/toast too.
      const owned = (await listCampaigns(meta.client, meta.adAccountId)).find(
        (c) => c.id === campaignId,
      );
      if (!owned) {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "CAMPAIGN_NOT_FOUND", message: "Campaign not found for this ad account." },
            toast: { message: "Unknown campaign", isError: true },
          },
          { status: 404 },
        );
      }
      // Read the campaign's true current status so the audit pre_state (and Undo)
      // reflect reality rather than an assumption from the click intent.
      const prior = await getCampaignStatus(meta.client, campaignId);
      await setCampaignStatus(meta.client, campaignId, desired);
      await client.actions.execute(
        {
          alertId: null,
          kind,
          params: { ...params, target: `Meta · ${owned.name}` },
          idempotencyKey,
          preState: { status: prior, campaign_id: campaignId },
          postState: { status: desired, campaign_id: campaignId },
        },
        request.signal,
      );
      return json<ActionPayload>({
        ok: true,
        toast: { message: intent === "pause" ? `Paused ${owned.name}` : `Resumed ${owned.name}` },
      });
    } catch (err) {
      const e = err as CalderynError;
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: e.code ?? "META_ACTION_FAILED", message: e.message },
          toast: { message: e.message, isError: true },
        },
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    }
  }

  try {
    await client.actions.execute(
      { alertId: null, kind, params, idempotencyKey },
      request.signal,
    );
    const messageByIntent: Record<string, string> = {
      pause: `Paused ${campaignName}`,
      resume: `Resumed ${campaignName}`,
      edit_budget: `Updated budget for ${campaignName}`,
    };
    return json<ActionPayload>({
      ok: true,
      toast: { message: messageByIntent[intent] ?? "Action executed" },
    });
  } catch (err) {
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

export default function Campaigns() {
  const navigate = useEmbeddedNavigate();
  const { campaigns, alerts, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [budgetInput, setBudgetInput] = useState("");

  useEffect(() => {
    if (actionData?.ok) setPending(null);
  }, [actionData]);

  // Sortable numeric columns (index → value). Default: 7d spend, descending.
  const SORT_KEYS: Record<number, (c: Campaign) => number> = {
    3: (c) => c.daily_budget_cents,
    4: (c) => c.spend_7d,
    5: (c) => c.roas_7d,
    6: (c) => c.roas_7d * c.contribution_margin,
  };
  const [sortIndex, setSortIndex] = useState(4);
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const sorted = [...campaigns].sort((a, b) => {
    const key = SORT_KEYS[sortIndex] ?? ((c: Campaign) => c.spend_7d);
    return sortDir === "ascending" ? key(a) - key(b) : key(b) - key(a);
  });

  const rows = sorted.map((c) => {
    const linked = alerts.filter((a) => a.campaign && a.campaign.includes(c.name));
    const hasPerf = c.roas_7d > 0 && c.contribution_margin > 0;
    const marginAdj = c.roas_7d * c.contribution_margin;
    return [
      <Link
        key={`n-${c.id}`}
        removeUnderline
        onClick={() =>
          navigate(`/app/campaigns/${encodeURIComponent(c.id)}?platform=${c.platform}`)
        }
      >
        <Text as="span" fontWeight="semibold">
          {c.name}
        </Text>
      </Link>,
      <PlatformTag key={`p-${c.id}`} platform={c.platform} />,
      <Badge key={`s-${c.id}`} tone={c.status === "active" ? "success" : "attention"}>
        {c.status === "active" ? "Active" : "Paused"}
      </Badge>,
      c.status === "paused" ? "—" : fmtMoney(c.daily_budget_cents),
      fmtMoney(c.spend_7d),
      c.roas_7d > 0 ? `${c.roas_7d.toFixed(1)}×` : "—",
      hasPerf ? (
        <Text
          key={`m-${c.id}`}
          as="span"
          tone={marginAdj < 1 ? "critical" : undefined}
          fontWeight="semibold"
        >
          {marginAdj.toFixed(1)}×
        </Text>
      ) : (
        "—"
      ),
      linked.length ? <Badge tone="warning">{String(linked.length)}</Badge> : "—",
      <ButtonGroup key={`act-${c.id}`}>
        {c.status === "active" ? (
          <Button onClick={() => setPending({ kind: "pause", campaign: c })}>Pause</Button>
        ) : (
          <Button onClick={() => setPending({ kind: "resume", campaign: c })}>Resume</Button>
        )}
        <Button
          variant="plain"
          onClick={() => {
            setBudgetInput(Math.round(c.daily_budget_cents / 100).toString());
            setPending({ kind: "edit_budget", campaign: c });
          }}
        >
          Edit budget
        </Button>
      </ButtonGroup>,
    ];
  });

  return (
    <Page
      title="Campaigns"
      subtitle="All ad campaigns from your connected platforms — Meta, Google, and TikTok · pause, resume, or adjust budgets directly"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load campaigns">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Action failed">
            <p>
              {actionData.error.code}: {actionData.error.message}
            </p>
          </Banner>
        )}

        <Card padding="0">
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "text",
              "numeric",
              "numeric",
              "numeric",
              "numeric",
              "text",
              "text",
            ]}
            headings={[
              "Campaign",
              "Platform",
              "Status",
              "Daily budget",
              "7d spend",
              <Tooltip key="roas" content="Reported ROAS — revenue ÷ ad spend, before product costs">
                <span>Ad return</span>
              </Tooltip>,
              <Tooltip key="madj" content="Margin-adjusted ROAS — return after product costs are taken out">
                <span>Real return</span>
              </Tooltip>,
              "Alerts",
              "Actions",
            ]}
            rows={rows}
            sortable={[false, false, false, true, true, true, true, false, false]}
            defaultSortDirection="descending"
            initialSortColumnIndex={4}
            onSort={(index, direction) => {
              setSortIndex(index);
              setSortDir(direction === "ascending" ? "ascending" : "descending");
            }}
          />
        </Card>
      </BlockStack>

      {pending?.kind === "pause" && (
        <CampaignActionModal
          title={`Pause ${pending.campaign.name}?`}
          intent="pause"
          campaign={pending.campaign}
          submitting={submitting}
          onClose={() => setPending(null)}
          primaryLabel="Pause campaign"
          primaryDestructive
        >
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Sends a pause call to the {pending.campaign.platform} API via the action gateway.
              Existing impressions in flight will continue to deliver for a few minutes; no new
              auctions will be entered.
            </Text>
            <Banner tone="info">
              7-day spend on this campaign:{" "}
              <Text as="span" fontWeight="semibold">
                {fmtMoney(pending.campaign.spend_7d)}
              </Text>
              . Reversible via Undo from the audit log.
            </Banner>
          </BlockStack>
        </CampaignActionModal>
      )}

      {pending?.kind === "resume" && (
        <CampaignActionModal
          title={`Resume ${pending.campaign.name}?`}
          intent="resume"
          campaign={pending.campaign}
          submitting={submitting}
          onClose={() => setPending(null)}
          primaryLabel="Resume campaign"
        >
          <Text as="p" tone="subdued">
            Resumes the campaign at its prior daily budget via the action gateway.
          </Text>
        </CampaignActionModal>
      )}

      {pending?.kind === "edit_budget" && (
        <CampaignActionModal
          title={`Edit budget · ${pending.campaign.name}`}
          intent="edit_budget"
          campaign={pending.campaign}
          submitting={submitting}
          onClose={() => setPending(null)}
          primaryLabel={`Save · ${fmtMoney(Number(budgetInput) * 100)}/day`}
          extraHidden={
            <input
              type="hidden"
              name="dailyBudgetCents"
              value={String(Math.max(0, Number(budgetInput) * 100))}
            />
          }
        >
          <BlockStack gap="300">
            <Text as="p" tone="subdued">
              Current daily budget:{" "}
              <Text as="span" fontWeight="semibold">
                {fmtMoney(pending.campaign.daily_budget_cents)}
              </Text>
            </Text>
            <TextField
              label="New daily budget (USD)"
              type="number"
              value={budgetInput}
              onChange={setBudgetInput}
              autoComplete="off"
              autoFocus
            />
          </BlockStack>
        </CampaignActionModal>
      )}
    </Page>
  );
}

function CampaignActionModal({
  title,
  intent,
  campaign,
  submitting,
  onClose,
  primaryLabel,
  primaryDestructive,
  children,
  extraHidden,
}: {
  title: string;
  intent: "pause" | "resume" | "edit_budget";
  campaign: Campaign;
  submitting: boolean;
  onClose: () => void;
  primaryLabel: string;
  primaryDestructive?: boolean;
  children: React.ReactNode;
  extraHidden?: React.ReactNode;
}) {
  const [idempotencyKey] = useState(
    () => `${campaign.id}:${intent}:${newIdempotencyKey()}`,
  );
  return (
    <Modal open title={title} onClose={onClose}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value={intent} />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input type="hidden" name="campaignName" value={campaign.name} />
          <input type="hidden" name="platform" value={campaign.platform} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          {extraHidden}
          <BlockStack gap="300">
            {children}
            <Box>
              <ButtonGroup>
                <Button onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  submit
                  variant="primary"
                  tone={primaryDestructive ? "critical" : undefined}
                  loading={submitting}
                  disabled={submitting}
                >
                  {primaryLabel}
                </Button>
              </ButtonGroup>
            </Box>
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

const PLATFORM_DOT: Record<Campaign["platform"], string> = {
  Meta: "var(--cdn-info)",
  Google: "var(--cdn-warning)",
  TikTok: "var(--cdn-attention)",
};

function PlatformTag({ platform }: { platform: Campaign["platform"] }) {
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 9999,
          display: "inline-block",
          background: PLATFORM_DOT[platform] ?? "var(--cdn-subdued)",
        }}
      />
      <Text as="span" variant="bodySm">
        {platform}
      </Text>
    </InlineStack>
  );
}
