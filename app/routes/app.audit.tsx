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
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  EmptyState,
  InlineGrid,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime, fmtAbsTime } from "~/lib/format";
import { ACTION_LABELS, DETECTOR_LABELS, DETECTOR_TERMS } from "~/lib/labels";
import { useActionToast } from "~/lib/toast";
import { StatTile } from "~/components/calderyn";
import type { AuditEntry } from "~/lib/types";

type LoaderPayload = {
  audit: AuditEntry[];
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
    const audit = await client.audit.list(request.signal);
    return json<LoaderPayload>({ audit, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      audit: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const auditId = String(formData.get("auditId") || "");

  if (intent !== "undo" || !auditId) {
    return json<ActionPayload>(
      {
        ok: false,
        error: { code: "INVALID_INTENT", message: "Unknown intent" },
        toast: { message: "Unknown intent", isError: true },
      },
      { status: 400 },
    );
  }

  try {
    await client.audit.undo(auditId, request.signal);
    return json<ActionPayload>({
      ok: true,
      toast: { message: "Action undone" },
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

export default function Audit() {
  const navigate = useNavigate();
  const { audit, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  useActionToast(actionData);

  if (audit.length === 0) {
    return (
      <Page title="Action audit log" backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}>
        {error && (
          <Box paddingBlockEnd="400">
            <Banner tone="critical" title="Couldn't load audit log">
              <p>
                {error.code}: {error.message}
              </p>
            </Banner>
          </Box>
        )}
        <Card>
          <EmptyState
            heading="No actions yet"
            action={{ content: "Open alerts", onAction: () => navigate("/app/alerts") }}
            secondaryAction={{ content: "Manage campaigns", onAction: () => navigate("/app/campaigns") }}
            image=""
          >
            <p>Execute an alert recommendation or pause a campaign to log your first action.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const successRate = Math.round(
    (audit.filter((a) => a.outcome === "succeeded").length / audit.length) * 100,
  );
  const recovered = audit
    .filter((a) => a.outcome === "succeeded")
    .reduce((s, a) => s + (a.dollar_impact_at_exec || 0), 0);

  const rows = audit.map((a) => [
    <Box key={`t-${a.id}`}>
      <Text as="p" variant="bodySm" fontWeight="semibold">
        {fmtRelTime(a.created_at)}
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {fmtAbsTime(a.created_at)}
      </Text>
    </Box>,
    <Box key={`a-${a.id}`}>
      <Text as="p" variant="bodySm" fontWeight="semibold">
        {ACTION_LABELS[a.action_kind]}
      </Text>
      {a.undo_of && (
        <Text as="p" variant="bodySm" tone="subdued">
          undo of {a.undo_of}
        </Text>
      )}
    </Box>,
    a.target,
    DETECTOR_LABELS[a.detector_id] ? (
      <Tooltip key={`d-${a.id}`} content={DETECTOR_TERMS[a.detector_id]}>
        <Badge>{DETECTOR_LABELS[a.detector_id]}</Badge>
      </Tooltip>
    ) : (
      <Badge key={`d-${a.id}`}>—</Badge>
    ),
    <Text key={`act-${a.id}`} as="span" variant="bodySm" tone="subdued">
      {a.actor}
    </Text>,
    <Text key={`i-${a.id}`} as="span" alignment="end" variant="bodySm" fontWeight="semibold">
      {a.dollar_impact_at_exec < 0 ? "-" : ""}
      {fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
    </Text>,
    <Badge key={`s-${a.id}`} tone={a.outcome === "succeeded" ? "success" : "critical"}>
      {a.outcome}
    </Badge>,
    a.undo_eligible && !a.undo_of ? (
      <Form key={`u-${a.id}`} method="post">
        <input type="hidden" name="intent" value="undo" />
        <input type="hidden" name="auditId" value={a.id} />
        <Button submit variant="plain" loading={submitting} disabled={submitting}>
          Undo
        </Button>
      </Form>
    ) : (
      <Text key={`u-${a.id}`} as="span" tone="subdued">
        —
      </Text>
    ),
  ]);

  return (
    <Page
      title="Action audit log"
      subtitle={`Every action executed by the gateway · ${audit.length} entries · 90-day retention`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load audit log">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Undo failed">
            <p>
              {actionData.error.code}: {actionData.error.message}
            </p>
          </Banner>
        )}
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <StatTile label="Total actions" value={String(audit.length)} caption="last 90 days" />
          <StatTile
            label="Success rate"
            value={`${successRate}%`}
            tone={successRate >= 90 ? "success" : undefined}
            caption={`${audit.filter((a) => a.outcome === "succeeded").length} of ${audit.length} succeeded`}
          />
          <StatTile
            label="Recovered impact"
            value={fmtMoney(recovered)}
            tone="success"
            caption="from successful actions"
          />
        </InlineGrid>

        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "text", "text", "text", "numeric", "text", "text"]}
            headings={["Time", "Action", "Target", "Detector", "Actor", "Impact", "Status", ""]}
            rows={rows}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}
