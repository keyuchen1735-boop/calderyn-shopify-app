import { Form, useLoaderData, useActionData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { fmtMoney } from "~/lib/format";
import { alertDetectorLabel, ACTION_LABELS, recommendedAction } from "~/lib/labels";
import type { LearnedRule, QueueProposal, RejectReason } from "~/lib/types";

// The 5 valid reject reasons (mirrors types.ts RejectReason union).
const REJECT_REASONS: RejectReason[] = [
  "too_aggressive",
  "wrong_timing",
  "not_enough_data",
  "i_handle_this",
  "other",
];

const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  too_aggressive: "Too aggressive",
  wrong_timing: "Wrong timing",
  not_enough_data: "Not enough data yet",
  i_handle_this: "I handle this myself",
  other: "Other",
};

type LoaderPayload = {
  proposals: QueueProposal[];
  learnedRules: LearnedRule[];
  error: { code: string; message: string } | null;
};

type ActionPayload =
  | { reflection: string }
  | { ok: true }
  | { error: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const [proposalsResult, rulesResult] = await Promise.allSettled([
      client.queue.list(request.signal),
      client.calibration.learnedRules(),
    ]);

    const proposals =
      proposalsResult.status === "fulfilled" ? proposalsResult.value : [];
    const learnedRules =
      rulesResult.status === "fulfilled" ? rulesResult.value : [];

    // Surface a loader-level error if the primary proposals query fails.
    if (proposalsResult.status === "rejected") {
      const e = proposalsResult.reason as CalderynError;
      return json<LoaderPayload>({
        proposals: [],
        learnedRules,
        error: { code: e.code ?? "ERROR", message: e.message },
      });
    }

    return json<LoaderPayload>({ proposals, learnedRules, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      proposals: [],
      learnedRules: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "reject") {
    const alertId = String(formData.get("alertId") ?? "").trim();
    const reason = String(formData.get("reason") ?? "").trim() as RejectReason;
    const note = String(formData.get("note") ?? "").trim() || undefined;

    // Validate required fields.
    if (!alertId) {
      return json<ActionPayload>({ error: "Missing alertId" }, { status: 400 });
    }
    if (!REJECT_REASONS.includes(reason)) {
      return json<ActionPayload>({ error: "Invalid reason" }, { status: 400 });
    }

    // Re-derive detector/action/impact from the TRUSTED alert — never trust the form.
    const alert = await client.alerts.get(alertId);
    const detectorId = alert.detector_id;
    const hasCampaign = Boolean(alert.campaign_id);
    const actionKind = recommendedAction(detectorId, { hasCampaign });

    if (!actionKind) {
      return json<ActionPayload>(
        { error: "No recommended action for this alert" },
        { status: 400 },
      );
    }

    // Record rejection — executes NOTHING; purely bookkeeping + learning signal.
    const { reflection } = await client.calibration.recordRejection({
      alertId,
      detectorId,
      actionKind,
      reason,
      note,
      dollarImpactCents: alert.dollar_impact,
    });

    return json<ActionPayload>({ reflection });
  }

  if (intent === "undo-rule") {
    const ruleId = String(formData.get("ruleId") ?? "").trim();
    if (!ruleId) {
      return json<ActionPayload>({ error: "Missing ruleId" }, { status: 400 });
    }
    await client.calibration.undoRule(ruleId);
    return json<ActionPayload>({ ok: true });
  }

  return json<ActionPayload>({ error: "Unknown intent" }, { status: 400 });
};

function confidenceTone(pct: number): "success" | "attention" | "warning" {
  if (pct >= 70) return "success";
  if (pct >= 50) return "attention";
  return "warning";
}

function RejectPanel({ alertId }: { alertId: string }) {
  const [reason, setReason] = useState<RejectReason>("too_aggressive");
  const [note, setNote] = useState("");
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const isSubmitting = navigation.state === "submitting";

  const reasonOptions = REJECT_REASONS.map((r) => ({
    label: REJECT_REASON_LABELS[r],
    value: r,
  }));

  return (
    <Box paddingBlockStart="200">
      <BlockStack gap="200">
        <Select
          label="Why are you rejecting this?"
          options={reasonOptions}
          value={reason}
          onChange={(v) => setReason(v as RejectReason)}
        />
        {reason === "other" && (
          <TextField
            label="Add a note (optional)"
            value={note}
            onChange={setNote}
            autoComplete="off"
            multiline={2}
          />
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="reject" />
          <input type="hidden" name="alertId" value={alertId} />
          <input type="hidden" name="reason" value={reason} />
          {reason === "other" && note && (
            <input type="hidden" name="note" value={note} />
          )}
          <Button
            variant="primary"
            tone="critical"
            submit
            loading={isSubmitting}
          >
            Confirm reject
          </Button>
        </Form>
        {actionData && "reflection" in actionData && (
          <Banner tone="info">
            <p>{actionData.reflection}</p>
          </Banner>
        )}
        {actionData && "error" in actionData && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}
      </BlockStack>
    </Box>
  );
}

function ProposalRow({ p }: { p: QueueProposal }) {
  const idempotencyKey = newIdempotencyKey();
  const [showReject, setShowReject] = useState(false);

  return (
    <Box paddingBlockStart="300">
      <Card>
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="start">
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm">
                {alertDetectorLabel(p.detector_id, {})}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {p.reasoning}
              </Text>
            </BlockStack>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={confidenceTone(p.confidence)}>{`${p.confidence}% confident`}</Badge>
              <Text as="span" variant="bodyMd" fontWeight="semibold">
                {fmtMoney(p.dollar_impact)}
              </Text>
            </InlineStack>
          </InlineStack>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              Suggested action: <strong>{ACTION_LABELS[p.action_kind] ?? p.action_kind}</strong>
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <Button
                variant="plain"
                tone="critical"
                onClick={() => setShowReject((v) => !v)}
              >
                {showReject ? "Cancel" : "Reject"}
              </Button>
              <Form method="post" action={`/app/alerts/${p.alertId}`}>
                <input type="hidden" name="kind" value={p.action_kind} />
                <input type="hidden" name="alertId" value={p.alertId} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                <Button variant="primary" submit>
                  Approve
                </Button>
              </Form>
            </InlineStack>
          </InlineStack>
          {showReject && <RejectPanel alertId={p.alertId} />}
        </BlockStack>
      </Card>
    </Box>
  );
}

function LearnedRulesCard({ rules }: { rules: LearnedRule[] }) {
  return (
    <Box paddingBlockStart="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            What Calderyn has learned
          </Text>
          {rules.length === 0 ? (
            <Text as="p" variant="bodySm" tone="subdued">
              Nothing learned yet. As you reject suggestions, the rules
              Calderyn picks up will show here.
            </Text>
          ) : (
            rules.map((rule) => (
              <InlineStack key={rule.id} align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  {rule.summary}
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="undo-rule" />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <Button variant="plain" submit>
                    Undo
                  </Button>
                </Form>
              </InlineStack>
            ))
          )}
        </BlockStack>
      </Card>
    </Box>
  );
}

export default function ActionQueue() {
  const { proposals, learnedRules, error } = useLoaderData<typeof loader>();

  return (
    <Page title="Action Queue">
      {error && (
        <Banner tone="critical" title="Couldn't load queue">
          <p>{error.message}</p>
        </Banner>
      )}
      {!error && proposals.length === 0 && (
        <Box paddingBlockStart="400">
          <Card>
            <Box padding="600">
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                  Nothing waiting -- Calderyn will queue suggestions here as it spots them.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Box>
      )}
      {proposals.map((p) => (
        <ProposalRow key={`${p.alertId}:${p.action_kind}`} p={p} />
      ))}
      <LearnedRulesCard rules={learnedRules} />
    </Page>
  );
}
