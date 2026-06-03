import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
} from "@remix-run/react";
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
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
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
    const meta = await metaClientForShop(session.shop);
    let campaigns: Campaign[];
    if (meta) {
      const live = await listCampaigns(meta.client, meta.adAccountId);
      const ingested = await client.campaigns.list(request.signal);
      const byId = new Map(ingested.map((c) => [c.id, c]));
      campaigns = live.map((c) => {
        const hit = byId.get(c.id);
        return {
          id: c.id,
          name: c.name,
          platform: "Meta" as const,
          status: c.status === "PAUSED" ? ("paused" as const) : ("active" as const),
          daily_budget_cents: c.dailyBudgetCents ?? 0,
          roas_7d: hit?.roas_7d ?? 0,
          contribution_margin: hit?.contribution_margin ?? 0,
          spend_7d: hit?.spend_7d ?? 0,
        };
      });
    } else {
      campaigns = await client.campaigns.list(request.signal);
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
      // Read the campaign's true current status so the audit pre_state (and Undo)
      // reflect reality rather than an assumption from the click intent.
      const prior = await getCampaignStatus(meta.client, campaignId);
      await setCampaignStatus(meta.client, campaignId, desired);
      await client.actions.execute(
        {
          alertId: null,
          kind,
          params,
          idempotencyKey,
          preState: { status: prior, campaign_id: campaignId },
          postState: { status: desired, campaign_id: campaignId },
        },
        request.signal,
      );
      return json<ActionPayload>({
        ok: true,
        toast: { message: intent === "pause" ? `Paused ${campaignName}` : `Resumed ${campaignName}` },
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
  const navigate = useNavigate();
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

  const sorted = [...campaigns].sort((a, b) => b.spend_7d - a.spend_7d);

  const rows = sorted.map((c) => {
    const linked = alerts.filter((a) => a.campaign && a.campaign.includes(c.name));
    return [
      <Text key={`n-${c.id}`} as="span" fontWeight="semibold">
        {c.name}
      </Text>,
      <Badge key={`p-${c.id}`}>{c.platform}</Badge>,
      <Badge key={`s-${c.id}`} tone={c.status === "active" ? "success" : "attention"}>
        {c.status}
      </Badge>,
      c.status === "paused" ? "—" : fmtMoney(c.daily_budget_cents),
      fmtMoney(c.spend_7d),
      c.roas_7d.toFixed(2),
      <Text
        key={`m-${c.id}`}
        as="span"
        tone={c.contribution_margin < 1 ? "critical" : "success"}
      >
        {c.contribution_margin.toFixed(2)}
      </Text>,
      linked.length ? <Badge tone="warning">{String(linked.length)}</Badge> : "—",
      <ButtonGroup key={`act-${c.id}`}>
        {c.status === "active" ? (
          <Button onClick={() => setPending({ kind: "pause", campaign: c })}>Pause</Button>
        ) : (
          <Button onClick={() => setPending({ kind: "resume", campaign: c })}>Resume</Button>
        )}
        <Button
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
      subtitle="All ad campaigns synced from Meta and Google · pause, resume, or adjust budgets directly"
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
              "Reported ROAS",
              "Margin-adj",
              "Alerts",
              "Actions",
            ]}
            rows={rows}
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
