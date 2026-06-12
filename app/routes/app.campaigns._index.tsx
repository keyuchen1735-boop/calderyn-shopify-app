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
  ActionList,
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
  Popover,
  Select,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import type { SelectGroup } from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { PlatformIcon } from "../components/PlatformIcon";
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
import { executeReallocation } from "~/lib/actions/reallocate.server";
import { resolveCampaignDimId } from "~/lib/ads/campaign-dim.server";
import { getSupabase, resolveShopId } from "~/lib/supabase.server";
import { suggestReallocation } from "~/lib/actions/reallocation-suggest.server";
import { metaClientForShop } from "~/lib/meta/client.server";
import { listCampaigns, setCampaignStatus, getCampaignStatus } from "~/lib/meta/campaigns.server";
import { useActionToast } from "~/lib/toast";
import { fmtMoney, fmtMoneyDec } from "~/lib/format";
import type { ActionKind, Campaign } from "~/lib/types";

type PendingAction =
  | { kind: "pause"; campaign: Campaign }
  | { kind: "resume"; campaign: Campaign }
  | { kind: "edit_budget"; campaign: Campaign }
  | { kind: "reallocate"; sourceId?: string };

type ReallocationPrefill = {
  sourceId: string | null; // id as used by the campaigns list (Meta = external id)
  destId: string | null;
  sourceGrade: string | null;
  destGrade: string | null;
};

type LoaderPayload = {
  campaigns: Campaign[];
  reallocation: ReallocationPrefill | null;
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
    //
    // TODO(merchant-review item 3): this live-Meta REPLACEMENT makes Campaigns
    // and Analytics disagree. Analytics reads the ingested/graded Meta campaigns
    // (campaign_grade_fact → ad_campaign_dim), but here those ingested rows are
    // dropped and swapped for whatever the live ad account returns — a different
    // set whenever the connected account doesn't match the ingested data (e.g.
    // seeded/demo campaigns vs a real live account). The two surfaces then show
    // different Meta campaigns. Reconciling them (back both from the same source,
    // or overlay live status onto ingested rows instead of replacing) is a
    // deferred maintainer decision — flagged, not yet fixed.
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

    // Best-effort grade-driven prefill for the reallocate modal. Failure
    // degrades VISIBLY to "no suggestion" (no Suggested badges, defaults
    // unset) — the modal itself still works; this is advisory data, not a
    // swallowed mutation (rule 12).
    let reallocation: ReallocationPrefill | null = null;
    try {
      const sb = getSupabase();
      const shopId = await resolveShopId(session.shop);
      const s = await suggestReallocation(shopId, sb);
      if (s.source && s.dest) {
        const matchId = (cand: { campaignId: string; externalId: string }) =>
          campaigns.find((c) => c.id === cand.campaignId || c.id === cand.externalId)?.id ?? null;
        reallocation = {
          sourceId: matchId(s.source),
          destId: matchId(s.dest),
          sourceGrade: s.source.grade,
          destGrade: s.dest.grade,
        };
      }
    } catch {
      reallocation = null;
    }
    return json<LoaderPayload>({ campaigns, reallocation, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      campaigns: [],
      reallocation: null,
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

  if (intent === "reallocate") {
    const destCampaignId = String(formData.get("destCampaignId") || "");
    const destPlatform = String(formData.get("destPlatform") || "");
    const destName = String(formData.get("destName") || "");
    const amountCents = Math.round(Number(formData.get("amountCents") || 0));
    // Validate at the boundary — never trust FormData shapes.
    if (!campaignId || !destCampaignId || !Number.isFinite(amountCents) || amountCents <= 0) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "source, destination and a positive amount are required" },
          toast: { message: "Invalid reallocation", isError: true },
        },
        { status: 400 },
      );
    }
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    // Meta rows post the live external id; resolve to the dim uuid. The
    // composite action has NO legacy direct-Meta fallback: both campaigns
    // must be ingested before budget can be moved between them.
    const sourceDim =
      platform === "Meta" ? await resolveCampaignDimId(sb, shopId, "meta", campaignId) : campaignId;
    const destDim =
      destPlatform === "Meta" ? await resolveCampaignDimId(sb, shopId, "meta", destCampaignId) : destCampaignId;
    if (!sourceDim || !destDim) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "NOT_INGESTED", message: "Both campaigns must finish syncing before budget can be reallocated" },
          toast: { message: "Campaigns still syncing — try again shortly", isError: true },
        },
        { status: 409 },
      );
    }
    try {
      const { outcome } = await executeReallocation(
        shopId,
        { alertId: null, sourceCampaignId: sourceDim, destCampaignId: destDim, amountCents, idempotencyKey },
        sb,
      );
      if (outcome === "failed") {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_FAILED", message: `Could not reallocate budget from ${campaignName}` },
            toast: { message: `Could not reallocate budget from ${campaignName}`, isError: true },
          },
          { status: 502 },
        );
      }
      if (outcome === "retrying") {
        // Source budget IS reduced; the dest increase is parked for the retry
        // cron. Not a success yet (rule 12).
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_RETRYING", message: `Source budget reduced; the increase on ${destName} is queued and will retry automatically` },
            toast: { message: `${destName}: increase queued, will retry automatically` },
          },
          { status: 202 },
        );
      }
      return json<ActionPayload>({
        ok: true,
        toast: { message: `Moved ${fmtMoneyDec(amountCents)}/day from ${campaignName} to ${destName}` },
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
      const newCents = Math.round(Number(formData.get("dailyBudgetCents") || 0));
      // A $0 daily budget effectively pauses the campaign with no warning —
      // refuse it here; pausing has its own explicit, undoable action.
      if (!Number.isFinite(newCents) || newCents <= 0) {
        return json<ActionPayload>(
          {
            ok: false,
            error: {
              code: "INVALID_BUDGET",
              message: "Daily budget must be greater than $0. To stop spend entirely, pause the campaign instead.",
            },
            toast: { message: "Daily budget must be greater than $0", isError: true },
          },
          { status: 400 },
        );
      }
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

/** Per-row overflow menu: collapses pause/resume, edit budget, and reallocate
 * into a single kebab so the action cell stays one column wide (the old inline
 * button row pushed the table past its card on normal admin widths). */
function RowActions({
  campaign: c,
  reallocEligible,
  setPending,
  setBudgetInput,
}: {
  campaign: Campaign;
  reallocEligible: boolean;
  setPending: (p: PendingAction) => void;
  setBudgetInput: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover
      active={open}
      onClose={close}
      preferredAlignment="right"
      activator={
        <Button
          variant="tertiary"
          icon={MenuHorizontalIcon}
          accessibilityLabel={`Actions for ${c.name}`}
          onClick={() => setOpen((v) => !v)}
        />
      }
    >
      <ActionList
        actionRole="menuitem"
        items={[
          c.status === "active"
            ? {
                content: "Pause",
                destructive: true,
                onAction: () => {
                  close();
                  setPending({ kind: "pause", campaign: c });
                },
              }
            : {
                content: "Resume",
                onAction: () => {
                  close();
                  setPending({ kind: "resume", campaign: c });
                },
              },
          {
            content: "Edit budget",
            onAction: () => {
              close();
              setBudgetInput(Math.round(c.daily_budget_cents / 100).toString());
              setPending({ kind: "edit_budget", campaign: c });
            },
          },
          {
            content: "Reallocate budget",
            disabled: c.status !== "active" || c.daily_budget_cents <= 0 || !reallocEligible,
            onAction: () => {
              close();
              setPending({ kind: "reallocate", sourceId: c.id });
            },
          },
        ]}
      />
    </Popover>
  );
}

export default function Campaigns() {
  const navigate = useEmbeddedNavigate();
  const { campaigns, reallocation, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  // Reallocation needs both a source AND a destination with a daily budget —
  // gate every entry point on the same predicate so the modal can never open
  // in a dead (no-possible-destination) state.
  const reallocEligibleCount = campaigns.filter(
    (c) => c.status === "active" && c.daily_budget_cents > 0,
  ).length;

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
  };
  const [sortIndex, setSortIndex] = useState(4);
  const [sortDir, setSortDir] = useState<"ascending" | "descending">("descending");

  const sorted = [...campaigns].sort((a, b) => {
    const key = SORT_KEYS[sortIndex] ?? ((c: Campaign) => c.spend_7d);
    return sortDir === "ascending" ? key(a) - key(b) : key(b) - key(a);
  });

  const rows = sorted.map((c) => {
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
      <RowActions
        key={`act-${c.id}`}
        campaign={c}
        reallocEligible={reallocEligibleCount >= 2}
        setPending={setPending}
        setBudgetInput={setBudgetInput}
      />,
    ];
  });

  return (
    <Page
      fullWidth
      title="Campaigns"
      subtitle="All ad campaigns from your connected platforms — Meta, Google, and TikTok · pause, resume, or adjust budgets directly"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      secondaryActions={[
        {
          content: "Reallocate budget",
          onAction: () => setPending({ kind: "reallocate" }),
          disabled: reallocEligibleCount < 2,
        },
      ]}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load campaigns">
            <p>{error.message}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Action failed">
            <p>{actionData.error.message}</p>
          </Banner>
        )}

        {campaigns.length === 0 && !error ? (
          <Card>
            <Box padding="600">
              <BlockStack gap="300" inlineAlign="center">
                <Text as="p" variant="headingMd">
                  No campaigns yet
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Connect an ad platform and your campaigns appear here within a few minutes
                  of the first sync.
                </Text>
                <Button variant="primary" onClick={() => navigate("/app/settings")}>
                  Connect an ad platform
                </Button>
              </BlockStack>
            </Box>
          </Card>
        ) : (
        <Card padding="0">
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "text",
              "numeric",
              "numeric",
              "numeric",
              "text",
            ]}
            headings={[
              "Campaign",
              "Platform",
              "Status",
              "Daily budget",
              "7d spend",
              <Tooltip key="roas" content="ROAS — revenue ÷ ad spend, before product costs">
                <span>ROAS</span>
              </Tooltip>,
              "Actions",
            ]}
            rows={rows}
            sortable={[false, false, false, true, true, true, false]}
            defaultSortDirection="descending"
            initialSortColumnIndex={4}
            onSort={(index, direction) => {
              setSortIndex(index);
              setSortDir(direction === "ascending" ? "ascending" : "descending");
            }}
          />
        </Card>
        )}
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

      {pending?.kind === "edit_budget" &&
        (() => {
          const currentCents = pending.campaign.daily_budget_cents;
          const parsed = Number(budgetInput);
          const validNumber =
            budgetInput.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
          const newCents = validNumber ? Math.round(parsed * 100) : 0;
          const changed = validNumber && newCents !== currentCents;
          return (
            <CampaignActionModal
              title={`Edit budget · ${pending.campaign.name}`}
              intent="edit_budget"
              campaign={pending.campaign}
              submitting={submitting}
              onClose={() => setPending(null)}
              primaryLabel={changed ? `Save · ${fmtMoney(newCents)}/day` : "Save"}
              primaryDisabled={!changed}
              extraHidden={
                <input type="hidden" name="dailyBudgetCents" value={String(newCents)} />
              }
            >
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  Current daily budget:{" "}
                  <Text as="span" fontWeight="semibold">
                    {fmtMoney(currentCents)}
                  </Text>
                </Text>
                <TextField
                  label="New daily budget (USD)"
                  type="number"
                  value={budgetInput}
                  onChange={setBudgetInput}
                  autoComplete="off"
                  autoFocus
                  helpText={
                    validNumber && !changed
                      ? "Same as the current budget — enter a different amount to save."
                      : undefined
                  }
                />
              </BlockStack>
            </CampaignActionModal>
          );
        })()}

      {pending?.kind === "reallocate" && (
        <ReallocateBudgetModal
          campaigns={campaigns}
          prefill={reallocation}
          initialSourceId={pending.sourceId}
          submitting={submitting}
          onClose={() => setPending(null)}
        />
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
  primaryDisabled,
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
  primaryDisabled?: boolean;
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
                  disabled={submitting || primaryDisabled}
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

function ReallocateBudgetModal({
  campaigns,
  prefill,
  initialSourceId,
  submitting,
  onClose,
}: {
  campaigns: Campaign[];
  prefill: ReallocationPrefill | null;
  initialSourceId?: string;
  submitting: boolean;
  onClose: () => void;
}) {
  const eligible = campaigns.filter((c) => c.status === "active" && c.daily_budget_cents > 0);
  const startSource = initialSourceId ?? prefill?.sourceId ?? eligible[0]?.id ?? "";
  const [sourceId, setSourceId] = useState(startSource);
  const [destId, setDestId] = useState(() => {
    if (prefill?.destId && prefill.destId !== startSource) return prefill.destId;
    return eligible.find((c) => c.id !== startSource)?.id ?? "";
  });
  const [amount, setAmount] = useState("5");
  const [idempotencyKey] = useState(() => `realloc:${newIdempotencyKey()}`);

  const source = eligible.find((c) => c.id === sourceId);
  const dest = eligible.find((c) => c.id === destId);
  const amountCents = Math.round(Number(amount) * 100);
  const sameCampaign = Boolean(source && dest && source.id === dest.id);
  const amountInvalid = !Number.isFinite(amountCents) || amountCents <= 0;
  const exceedsSource = Boolean(source && !amountInvalid && amountCents >= source.daily_budget_cents);
  const valid = Boolean(source && dest && !sameCampaign && !amountInvalid && !exceedsSource);

  // Grade text is known only for the suggested pair (loader keeps the grade
  // join scoped to the suggestion).
  const gradeFor = (id: string): string | null =>
    prefill?.sourceId === id
      ? prefill?.sourceGrade ?? null
      : prefill?.destId === id
        ? prefill?.destGrade ?? null
        : null;
  const optionGroups: SelectGroup[] = (["Meta", "Google", "TikTok"] as const)
    .map((p) => ({
      title: p,
      options: eligible
        .filter((c) => c.platform === p)
        .map((c) => {
          const grade = gradeFor(c.id);
          return {
            value: c.id,
            label: `${c.name} · ${fmtMoney(c.daily_budget_cents)}/day${grade ? ` · ${grade}` : ""}`,
          };
        }),
    }))
    .filter((g) => g.options.length > 0);

  return (
    <Modal open title="Reallocate daily budget" onClose={onClose}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="reallocate" />
          <input type="hidden" name="campaignId" value={source?.id ?? ""} />
          <input type="hidden" name="campaignName" value={source?.name ?? ""} />
          <input type="hidden" name="platform" value={source?.platform ?? ""} />
          <input type="hidden" name="destCampaignId" value={dest?.id ?? ""} />
          <input type="hidden" name="destName" value={dest?.name ?? ""} />
          <input type="hidden" name="destPlatform" value={dest?.platform ?? ""} />
          <input type="hidden" name="amountCents" value={String(amountInvalid ? 0 : amountCents)} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <BlockStack gap="300">
            <Select
              label="Move budget from"
              options={optionGroups}
              value={sourceId}
              onChange={setSourceId}
              helpText={
                prefill?.sourceId === sourceId ? "Suggested: lowest-graded campaign" : undefined
              }
            />
            <Select
              label="To"
              options={optionGroups}
              value={destId}
              onChange={setDestId}
              error={sameCampaign ? "Choose two different campaigns" : undefined}
              helpText={
                prefill?.destId === destId
                  ? "Suggested: best winning campaign on another platform"
                  : undefined
              }
            />
            <TextField
              label="Amount per day (USD)"
              type="number"
              prefix="$"
              value={amount}
              onChange={setAmount}
              autoComplete="off"
              error={
                amountInvalid
                  ? "Enter an amount above $0"
                  : exceedsSource
                    ? "Amount must leave the source budget above zero"
                    : undefined
              }
            />
            {source && dest && valid && (
              <Banner tone="info">
                {source.platform} · {source.name}: {fmtMoney(source.daily_budget_cents)} →{" "}
                {fmtMoney(source.daily_budget_cents - amountCents)}/day {" — "} {dest.platform} ·{" "}
                {dest.name}: {fmtMoney(dest.daily_budget_cents)} →{" "}
                {fmtMoney(dest.daily_budget_cents + amountCents)}/day
              </Banner>
            )}
            <Box>
              <ButtonGroup>
                <Button onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting || !valid}>
                  Move {fmtMoneyDec(amountInvalid ? 0 : amountCents)}/day
                </Button>
              </ButtonGroup>
            </Box>
          </BlockStack>
        </Form>
      </Modal.Section>
    </Modal>
  );
}

function PlatformTag({ platform }: { platform: Campaign["platform"] }) {
  return (
    <InlineStack gap="150" blockAlign="center" wrap={false}>
      <PlatformIcon platform={platform} size={16} />
      <Text as="span" variant="bodySm">
        {platform}
      </Text>
    </InlineStack>
  );
}
