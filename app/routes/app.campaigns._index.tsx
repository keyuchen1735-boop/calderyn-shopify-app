import { Fragment, useEffect, useState } from "react";
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
  Divider,
  InlineStack,
  Link,
  Modal,
  Page,
  Popover,
  Select,
  Text,
  TextField,
  Tooltip,
  useBreakpoints,
} from "@shopify/polaris";
import type { SelectGroup } from "@shopify/polaris";
import { MenuHorizontalIcon } from "@shopify/polaris-icons";
import { PlatformIcon } from "../components/PlatformIcon";
import { authenticate } from "../shopify.server";
import { type CalderynError, calderynClient } from "~/lib/calderyn.server";
import { newIdempotencyKey, isUuid } from "~/lib/ids";
import { sortActiveFirst } from "~/lib/campaign-sort";
import { campaignBudgetLabel, campaignRoasLabel } from "~/lib/campaign-display";
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
import { scaleReason } from "~/lib/scale-reason";
import type { ActionKind, Campaign } from "~/lib/types";
import { resolveCampaignScore } from "~/lib/campaign-score/resolve.server";
import type { CampaignCalderynScore } from "~/lib/campaign-score/types";

const SCORE_BADGE_TONE: Record<CampaignCalderynScore["band"], "success" | "warning" | "critical" | undefined> = {
  strong: "success",
  fair: "warning",
  weak: "critical",
  nodata: undefined,
};

type ScalePrefill = {
  campaignId: string; // id as used by the campaigns list (Meta = external id)
  alertId: string;
  projectedUpside: number; // CENTS (alert.dollar_impact — rowToAlert already converts dollars→cents)
  newBudgetCents: number;
  pct: number;
  reason: string; // plain-language "why scale" shown on hover of the Suggested: scale badge
};

type PendingAction =
  | { kind: "pause"; campaign: Campaign }
  | { kind: "resume"; campaign: Campaign }
  | { kind: "edit_budget"; campaign: Campaign }
  | { kind: "reallocate"; sourceId?: string }
  | { kind: "scale"; campaign: Campaign; suggestion: ScalePrefill };

type ReallocationPrefill = {
  sourceId: string | null; // id as used by the campaigns list (Meta = external id)
  destId: string | null;
  sourceGrade: string | null;
  destGrade: string | null;
};

type LoaderPayload = {
  campaigns: Campaign[];
  reallocation: ReallocationPrefill | null;
  scaleSuggestions: ScalePrefill[];
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
    // Campaigns come from the ingested/graded view (v_campaigns_flat) for EVERY
    // platform — the SAME source Analytics and the scale detector use — so the two
    // surfaces agree and scale suggestions show for Meta too. (Previously Meta rows
    // were replaced wholesale by the live Meta API list; that made Campaigns and
    // Analytics disagree and hid Meta scale badges whenever the live account didn't
    // match the graded data, e.g. seeded/demo campaigns. Status now comes from
    // ingestion plus the optimistic mirror executeAction writes after each action;
    // every campaign row is keyed by its ad_campaign_dim uuid, so actions resolve
    // uniformly through the orchestrator — no per-platform external-id bridging.)
    const campaigns: Campaign[] = await client.campaigns.list(request.signal);

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
    // Best-effort scale suggestions from open campaign_scaling_opportunity alerts.
    // Matches alerts to campaign rows by ID (v_alerts_view exposes the dim id and
    // platform external id) — robust against two campaigns sharing a name. Failure
    // degrades visibly to [] — badge + row action simply won't show.
    let scaleSuggestions: ScalePrefill[] = [];
    try {
      const [openScaleAlerts, gr] = await Promise.all([
        client.alerts.list({ status: "open", detector: "campaign_scaling_opportunity" }, request.signal),
        client.guardrails.get(request.signal),
      ]);
      const pct = gr.autopilot_max_budget_increase_pct || 20;
      scaleSuggestions = openScaleAlerts
        .map((a) => {
          // Ingested rows (Google/TikTok) key on the dim id; live-Meta rows key on
          // the platform external id — match either, never by name.
          const row = campaigns.find(
            (c) =>
              (a.campaign_id != null && c.id === a.campaign_id) ||
              (a.campaign_external_id != null && c.id === a.campaign_external_id),
          );
          if (!row || row.status !== "active" || row.daily_budget_cents <= 0) return null;
          // ROAS from the alert's raw evidence (the campaign row's roas_7d is 0
          // for live-Meta rows); null when absent so the reason omits the clause.
          const roasRaw = Number(a.evidence?.roas);
          const roas = Number.isFinite(roasRaw) ? roasRaw : null;
          return {
            campaignId: row.id,
            alertId: a.id,
            projectedUpside: a.dollar_impact,
            newBudgetCents: Math.round(row.daily_budget_cents * (1 + pct / 100)),
            pct,
            reason: scaleReason(roas, pct, a.dollar_impact),
          } satisfies ScalePrefill;
        })
        .filter((s): s is ScalePrefill => s !== null);
    } catch {
      scaleSuggestions = [];
    }

    // Performance-led list score (cost guard rule 6): ads:[] ⇒ resolve does zero
    // creative I/O on list render; the full P+C score is computed on the detail
    // page (which already loads creatives). Best-effort: a grade-fetch failure
    // degrades to no badge (band "nodata") — the rows still render (rule 12).
    let campaignsWithScore: Campaign[] = campaigns;
    try {
      const grades = await client.analytics.campaignGrades(request.signal);
      const gradeById = new Map(grades.map((g) => [g.campaign_id, g]));
      campaignsWithScore = await Promise.all(
        campaigns.map(async (c) => ({
          ...c,
          calderynScore: await resolveCampaignScore(
            session.shop,
            { id: c.id, ads: [] },
            gradeById.get(c.id),
          ),
        })),
      );
    } catch {
      campaignsWithScore = campaigns;
    }

    return json<LoaderPayload>({ campaigns: campaignsWithScore, reallocation, scaleSuggestions, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      campaigns: [],
      reallocation: null,
      scaleSuggestions: [],
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
    // Rows are keyed by the ad_campaign_dim uuid (ingested source). Use it
    // directly; the external-id resolve remains only as a fallback for any
    // non-uuid id (legacy/stale form posts).
    const sourceDim = isUuid(campaignId)
      ? campaignId
      : platform === "Meta"
        ? await resolveCampaignDimId(sb, shopId, "meta", campaignId)
        : campaignId;
    const destDim = isUuid(destCampaignId)
      ? destCampaignId
      : destPlatform === "Meta"
        ? await resolveCampaignDimId(sb, shopId, "meta", destCampaignId)
        : destCampaignId;
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

  if (intent === "scale") {
    const newCents = Math.round(Number(formData.get("dailyBudgetCents") || 0));
    const alertId = String(formData.get("alertId") || "") || null;
    if (!campaignId || !Number.isFinite(newCents) || newCents <= 0) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "campaign and a positive new budget are required" },
          toast: { message: "Invalid scale request", isError: true },
        },
        { status: 400 },
      );
    }
    const sb = getSupabase();
    const shopId = await resolveShopId(session.shop);
    const dimId = isUuid(campaignId)
      ? campaignId
      : platform === "Meta"
        ? await resolveCampaignDimId(sb, shopId, "meta", campaignId)
        : campaignId;
    if (!dimId) {
      return json<ActionPayload>(
        {
          ok: false,
          error: { code: "NOT_INGESTED", message: "This campaign is still syncing — try again shortly" },
          toast: { message: "Campaign still syncing", isError: true },
        },
        { status: 409 },
      );
    }
    try {
      const { outcome } = await executeAction(
        shopId,
        { alertId, kind: "increase_campaign_budget", campaignId: dimId, idempotencyKey, dailyBudgetCents: newCents },
        sb,
      );
      if (outcome === "failed") {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_FAILED", message: `Could not scale ${campaignName}` },
            toast: { message: `Could not scale ${campaignName}`, isError: true },
          },
          { status: 502 },
        );
      }
      if (outcome === "retrying") {
        return json<ActionPayload>(
          {
            ok: false,
            error: { code: "ACTION_RETRYING", message: `Couldn't reach the ad platform — scaling ${campaignName} is queued and will retry` },
            toast: { message: `${campaignName}: queued, will retry automatically` },
          },
          { status: 202 },
        );
      }
      return json<ActionPayload>({
        ok: true,
        toast: { message: `Scaled ${campaignName} to ${fmtMoneyDec(newCents)}/day` },
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
    const dimId = isUuid(campaignId)
      ? campaignId
      : platform === "Meta"
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
  scaleSuggestion,
  setPending,
  setBudgetInput,
}: {
  campaign: Campaign;
  reallocEligible: boolean;
  scaleSuggestion: ScalePrefill | null;
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
          {
            content: "Scale budget",
            disabled: !scaleSuggestion || c.status !== "active" || c.daily_budget_cents <= 0,
            onAction: () => {
              close();
              if (scaleSuggestion) setPending({ kind: "scale", campaign: c, suggestion: scaleSuggestion });
            },
          },
        ]}
      />
    </Popover>
  );
}

/** One label/value pair in a mobile campaign card's metric row. */
function CampaignMetric({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodyXs" tone="subdued">
        {label}
      </Text>
      <Text as="span" variant="bodySm" fontWeight="semibold" numeric>
        {value}
      </Text>
    </BlockStack>
  );
}

/** Phone-width render of one campaign row: name link, platform + status (+ scale
 *  suggestion) badges, the same kebab actions as the table, and a 3-up metric
 *  row. Mirrors the desktop DataTable row using shared display helpers. */
function CampaignCard({
  c,
  scaleSuggestion,
  navigate,
  reallocEligible,
  setPending,
  setBudgetInput,
}: {
  c: Campaign;
  scaleSuggestion: ScalePrefill | null;
  navigate: (path: string) => void;
  reallocEligible: boolean;
  setPending: (p: PendingAction) => void;
  setBudgetInput: (v: string) => void;
}) {
  return (
    <Box padding="400">
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="start" gap="200" wrap={false}>
          <BlockStack gap="150">
            <Link
              removeUnderline
              onClick={() =>
                navigate(`/app/campaigns/${encodeURIComponent(c.id)}?platform=${c.platform}`)
              }
            >
              <Text as="span" fontWeight="semibold">
                {c.name}
              </Text>
            </Link>
            <InlineStack gap="150" blockAlign="center">
              <PlatformTag platform={c.platform} />
              <Badge tone={c.status === "active" ? "success" : "attention"}>
                {c.status === "active" ? "Active" : "Paused"}
              </Badge>
              {c.calderynScore?.value != null && (
                <Badge tone={SCORE_BADGE_TONE[c.calderynScore.band]}>
                  {`Score ${c.calderynScore.value}`}
                </Badge>
              )}
              {scaleSuggestion ? (
                <Tooltip content={scaleSuggestion.reason}>
                  <Link
                    removeUnderline
                    onClick={() =>
                      navigate(
                        `/app/campaigns/${encodeURIComponent(c.id)}?platform=${c.platform}&scale=1`,
                      )
                    }
                  >
                    <Badge tone="success">Suggested: scale</Badge>
                  </Link>
                </Tooltip>
              ) : null}
            </InlineStack>
          </BlockStack>
          <RowActions
            campaign={c}
            reallocEligible={reallocEligible}
            scaleSuggestion={scaleSuggestion}
            setPending={setPending}
            setBudgetInput={setBudgetInput}
          />
        </InlineStack>
        <InlineStack gap="500">
          <CampaignMetric
            label="Daily budget"
            value={campaignBudgetLabel(c.status, c.daily_budget_cents)}
          />
          <CampaignMetric label="7d spend" value={fmtMoney(c.spend_7d)} />
          <CampaignMetric label="ROAS" value={campaignRoasLabel(c.roas_7d)} />
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

export default function Campaigns() {
  const navigate = useEmbeddedNavigate();
  const { campaigns, reallocation, scaleSuggestions, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);
  // Phones get a stacked card list instead of the 7-column DataTable (which
  // would scroll horizontally and hide the row actions).
  const { smDown } = useBreakpoints();

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
  const [platformFilter, setPlatformFilter] = useState<"All" | "Meta" | "Google" | "TikTok">("All");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 8;

  // Active campaigns always sort to the top; the chosen column orders rows
  // within each status group (paused never interleave with active).
  const sorted = sortActiveFirst(campaigns, (a, b) => {
    const key = SORT_KEYS[sortIndex] ?? ((c: Campaign) => c.spend_7d);
    return sortDir === "ascending" ? key(a) - key(b) : key(b) - key(a);
  });

  // Desktop list: platform filter chips + pagination over the sorted list.
  const filtered =
    platformFilter === "All" ? sorted : sorted.filter((c) => c.platform === platformFilter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageIdx = Math.min(Math.max(page, 0), totalPages - 1);
  const start = pageIdx * PAGE_SIZE;
  const paged = filtered.slice(start, start + PAGE_SIZE);
  const rangeText =
    filtered.length === 0
      ? "No campaigns match"
      : `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} of ${filtered.length}`;
  const scaleCount = scaleSuggestions.length;
  // No break-even on the embedded Campaign type; "losing money" = a real ROAS
  // below 1× (revenue under spend). roas_7d is 0 for un-joined live rows, so
  // the > 0 guard keeps "no data" from being counted as losing.
  const losingCount = campaigns.filter(
    (c) => c.status === "active" && c.roas_7d > 0 && c.roas_7d < 1,
  ).length;
  const sortBy = (idx: number) => {
    if (sortIndex === idx) setSortDir((d) => (d === "descending" ? "ascending" : "descending"));
    else {
      setSortIndex(idx);
      setSortDir("descending");
    }
    setPage(0);
  };
  const sortInd = (idx: number) => (sortIndex === idx ? (sortDir === "ascending" ? " ↑" : " ↓") : "");
  const sortCol = (idx: number) => (sortIndex === idx ? "#173a4d" : "#9a9a9a");
  const PLATS: { key: "All" | "Meta" | "Google" | "TikTok"; dot?: string }[] = [
    { key: "All" },
    { key: "Meta", dot: "#1877F2" },
    { key: "Google", dot: "#EA4335" },
    { key: "TikTok", dot: "#111111" },
  ];

  return (
    <Page
      fullWidth
      title="Campaigns"
      subtitle="All ad campaigns from your connected platforms — Meta, Google, and TikTok · pause, resume, or adjust budgets directly"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{
        content: "Reallocate budget",
        onAction: () => setPending({ kind: "reallocate" }),
        disabled: reallocEligibleCount < 2,
      }}
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
        ) : smDown ? (
          <Card padding="0">
            {sorted.map((c, i) => (
              <Fragment key={c.id}>
                {i > 0 && <Divider />}
                <CampaignCard
                  c={c}
                  scaleSuggestion={scaleSuggestions.find((s) => s.campaignId === c.id) ?? null}
                  navigate={navigate}
                  reallocEligible={reallocEligibleCount >= 2}
                  setPending={setPending}
                  setBudgetInput={setBudgetInput}
                />
              </Fragment>
            ))}
          </Card>
        ) : (
          <BlockStack gap="300">
            <div className="cmpx-toolbar">
              <div className="cmpx-chips">
                {PLATS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="cmpx-chip"
                    data-on={platformFilter === p.key}
                    onClick={() => {
                      setPlatformFilter(p.key);
                      setPage(0);
                    }}
                  >
                    {p.dot && <span className="cmpx-chip-dot" style={{ background: p.dot }} />}
                    {p.key}
                  </button>
                ))}
              </div>
              <span className="cmpx-summary">
                {campaigns.length} campaigns · {scaleCount} to scale · {losingCount} losing money
              </span>
            </div>

            <Card padding="0">
              <div className="cmpx-scroll">
                <div className="cmpx-table">
                  <div className="cmpx-head">
                    <span>Campaign</span>
                    <span>Platform</span>
                    <span>Status</span>
                    <button type="button" className="cmpx-sort cmpx-r" style={{ color: sortCol(3) }} onClick={() => sortBy(3)}>
                      Daily budget{sortInd(3)}
                    </button>
                    <button type="button" className="cmpx-sort cmpx-r" style={{ color: sortCol(4) }} onClick={() => sortBy(4)}>
                      7d spend{sortInd(4)}
                    </button>
                    <button type="button" className="cmpx-sort cmpx-r" style={{ color: sortCol(5) }} onClick={() => sortBy(5)}>
                      ROAS{sortInd(5)}
                    </button>
                    <span className="cmpx-r">Action</span>
                  </div>

                  {paged.map((c) => {
                    const scaleSuggestion =
                      scaleSuggestions.find((s) => s.campaignId === c.id) ?? null;
                    const paused = c.status !== "active";
                    const losing = !paused && c.roas_7d > 0 && c.roas_7d < 1;
                    const sug = paused ? null : scaleSuggestion ? "scale" : losing ? "pause" : null;
                    return (
                      <div key={c.id} className="cmpx-row" data-dim={paused}>
                        <button
                          type="button"
                          className="cmpx-name"
                          title={c.name}
                          onClick={() =>
                            navigate(`/app/campaigns/${encodeURIComponent(c.id)}?platform=${c.platform}`)
                          }
                        >
                          {c.name}
                        </button>
                        <span className="cmpx-plat">
                          <PlatformIcon platform={c.platform} size={16} />
                          {c.platform}
                        </span>
                        <div className="cmpx-status">
                          {paused ? (
                            <span className="cmpx-tag cmpx-tag-paused">Paused</span>
                          ) : (
                            <span className="cmpx-tag cmpx-tag-active">
                              <span className="cmpx-tag-dot" />
                              Active
                            </span>
                          )}
                          {c.calderynScore?.value != null && (
                            <Badge tone={SCORE_BADGE_TONE[c.calderynScore.band]}>
                              {`Score ${c.calderynScore.value}`}
                            </Badge>
                          )}
                          {sug === "scale" && <span className="cmpx-tag cmpx-tag-scale">Scale suggested</span>}
                          {sug === "pause" && <span className="cmpx-tag cmpx-tag-pause">Pause suggested</span>}
                        </div>
                        <span className="cmpx-num cmpx-r">
                          {campaignBudgetLabel(c.status, c.daily_budget_cents)}
                        </span>
                        <span className="cmpx-num cmpx-r">{fmtMoney(c.spend_7d)}</span>
                        <span className="cmpx-roas cmpx-r" style={{ color: losing ? "#b3300f" : "#1a1a1a" }}>
                          {campaignRoasLabel(c.roas_7d)}
                        </span>
                        <div className="cmpx-actions">
                          {sug === "scale" && scaleSuggestion && (
                            <button
                              type="button"
                              className="cmpx-act cmpx-act-scale"
                              onClick={() => setPending({ kind: "scale", campaign: c, suggestion: scaleSuggestion })}
                            >
                              Scale
                            </button>
                          )}
                          {sug === "pause" && (
                            <button
                              type="button"
                              className="cmpx-act cmpx-act-pause"
                              onClick={() => setPending({ kind: "pause", campaign: c })}
                            >
                              Pause
                            </button>
                          )}
                          <RowActions
                            campaign={c}
                            reallocEligible={reallocEligibleCount >= 2}
                            scaleSuggestion={scaleSuggestion}
                            setPending={setPending}
                            setBudgetInput={setBudgetInput}
                          />
                        </div>
                      </div>
                    );
                  })}

                  <div className="cmpx-foot">
                    <span className="cmpx-foot-range">{rangeText}</span>
                    <div className="cmpx-pager">
                      <button
                        type="button"
                        className="cmpx-page"
                        disabled={pageIdx <= 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        ‹ Prev
                      </button>
                      <span className="cmpx-page-label">
                        Page {pageIdx + 1} of {totalPages}
                      </span>
                      <button
                        type="button"
                        className="cmpx-page"
                        disabled={pageIdx >= totalPages - 1}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next ›
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </BlockStack>
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

      {pending?.kind === "scale" && (
        <ScaleBudgetModal
          campaign={pending.campaign}
          suggestion={pending.suggestion}
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

function ScaleBudgetModal({
  campaign,
  suggestion,
  submitting,
  onClose,
}: {
  campaign: Campaign;
  suggestion: ScalePrefill;
  submitting: boolean;
  onClose: () => void;
}) {
  const [idempotencyKey] = useState(() => `scale:${newIdempotencyKey()}`);
  return (
    <Modal open title="Scale this winning campaign" onClose={onClose}>
      <Modal.Section>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="scale" />
          <input type="hidden" name="campaignId" value={campaign.id} />
          <input type="hidden" name="campaignName" value={campaign.name} />
          <input type="hidden" name="platform" value={campaign.platform} />
          <input type="hidden" name="dailyBudgetCents" value={String(suggestion.newBudgetCents)} />
          <input type="hidden" name="alertId" value={suggestion.alertId} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <BlockStack gap="300">
            <Text as="p">
              {campaign.platform} · {campaign.name} is winning. Raise its daily budget {suggestion.pct}% (
              {fmtMoney(campaign.daily_budget_cents)} → {fmtMoney(suggestion.newBudgetCents)}/day) for about{" "}
              <Text as="span" fontWeight="bold">
                {fmtMoney(suggestion.projectedUpside)}/mo
              </Text>{" "}
              more projected margin.
            </Text>
            <Box>
              <ButtonGroup>
                <Button onClick={onClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button submit variant="primary" loading={submitting} disabled={submitting}>
                  Scale budget
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
