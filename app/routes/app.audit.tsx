import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEmbeddedNavigate } from "../lib/embedded-nav";
import { useAppBridge } from "@shopify/app-bridge-react";
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
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime, fmtAbsTime, shortId } from "~/lib/format";
import { recovered as recoveredOf } from "~/lib/recovered";
import { ACTION_LABELS, DETECTOR_LABELS, DETECTOR_TERMS, actorLabel } from "~/lib/labels";
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
  const navigate = useEmbeddedNavigate();
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
              <p>{error.message}</p>
            </Banner>
          </Box>
        )}
        <Card>
          <Box padding="600">
            <BlockStack gap="300" inlineAlign="center">
              <Text as="p" variant="headingMd">
                No actions yet
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Every action Calderyn takes — and your one-click Undo for each — is recorded
                here. Approve an alert recommendation or pause a campaign to log your first.
              </Text>
              <InlineStack gap="200">
                <Button variant="primary" onClick={() => navigate("/app/alerts")}>
                  Open alerts
                </Button>
                <Button onClick={() => navigate("/app/campaigns")}>Manage campaigns</Button>
              </InlineStack>
            </BlockStack>
          </Box>
        </Card>
      </Page>
    );
  }

  const successRate = Math.round(
    (audit.filter((a) => a.outcome === "succeeded").length / audit.length) * 100,
  );
  // Shared with the home tile and the web dashboard (app/lib/recovered.ts):
  // succeeded actions, undo rows excluded.
  const recovered = recoveredOf(audit).cents;

  const rows = audit.map((a) => {
    const canUndo = a.undo_eligible && !a.undo_of;
    // The PDF route 404s for entries recorded before the PO snapshot existed,
    // so only offer the download when the audit row actually carries one.
    const hasPoPdf =
      a.action_kind === "create_po_draft" &&
      a.outcome === "succeeded" &&
      Boolean(a.post_state?.po);
    // Realized impact is attributed later (often $0 at exec time); fall back to
    // the estimate snapshotted at execution so the column isn't a wall of $0.
    // Not for snooze: a deferral recovers nothing, and showing the alert's
    // full at-stake impact there would inflate the column.
    const estimateCents = Number(a.post_state?.estimate_cents ?? 0);
    const showEstimate =
      !a.dollar_impact_at_exec && estimateCents > 0 && a.action_kind !== "snooze_alert";
    return [
    <Box key={`t-${a.id}`} minWidth="150px">
      <Text as="p" variant="bodySm" fontWeight="semibold">
        {fmtRelTime(a.created_at)}
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {fmtAbsTime(a.created_at)}
      </Text>
    </Box>,
    <Box key={`a-${a.id}`} minWidth="170px">
      <Text as="p" variant="bodySm" fontWeight="semibold">
        {ACTION_LABELS[a.action_kind] ?? a.action_kind}
      </Text>
      {a.undo_of && (
        <Text as="p" variant="bodySm" tone="subdued">
          undo of {shortId(a.undo_of)}
        </Text>
      )}
    </Box>,
    <Tooltip key={`tg-${a.id}`} content={a.target}>
      <Text as="span" variant="bodySm">
        {shortId(a.target)}
      </Text>
    </Tooltip>,
    DETECTOR_LABELS[a.detector_id] ? (
      <Tooltip key={`d-${a.id}`} content={DETECTOR_TERMS[a.detector_id]}>
        <Badge>{DETECTOR_LABELS[a.detector_id]}</Badge>
      </Tooltip>
    ) : (
      <Text key={`d-${a.id}`} as="span" tone="subdued">
        —
      </Text>
    ),
    <Text key={`act-${a.id}`} as="span" variant="bodySm" tone="subdued">
      {actorLabel(a.actor)}
    </Text>,
    <Box key={`i-${a.id}`}>
      <Text as="p" alignment="end" variant="bodySm" fontWeight="semibold">
        {a.dollar_impact_at_exec < 0 ? "-" : ""}
        {fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
      </Text>
      {showEstimate && (
        <Text as="p" alignment="end" variant="bodySm" tone="subdued">
          est. {fmtMoney(estimateCents)}
        </Text>
      )}
    </Box>,
    // `retrying` is parked for the retry cron — pending, not a failure
    // (the alert page's own toast says "queued, will retry automatically").
    <Badge
      key={`s-${a.id}`}
      tone={
        a.outcome === "succeeded" ? "success" : a.outcome === "retrying" ? "attention" : "critical"
      }
    >
      {a.outcome}
    </Badge>,
    canUndo || hasPoPdf ? (
      <InlineStack key={`u-${a.id}`} gap="200" wrap={false}>
        {canUndo && (
          <Form method="post">
            <input type="hidden" name="intent" value="undo" />
            <input type="hidden" name="auditId" value={a.id} />
            <Button submit variant="plain" loading={submitting} disabled={submitting}>
              Undo
            </Button>
          </Form>
        )}
        {hasPoPdf && <DownloadPoButton auditId={a.id} />}
      </InlineStack>
    ) : (
      <Text key={`u-${a.id}`} as="span" tone="subdued">
        —
      </Text>
    ),
  ];
  });

  return (
    <Page
      title="Action audit log"
      subtitle={`Every action executed by the gateway · ${audit.length} entries · 90-day retention`}
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load audit log">
            <p>{error.message}</p>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Undo failed">
            <p>{actionData.error.message}</p>
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

function DownloadPoButton({ auditId }: { auditId: string }) {
  const shopify = useAppBridge();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      // Embedded iframe: a plain <a href> document navigation won't carry the
      // session token. App Bridge patches global fetch with it, so fetch the
      // bytes and hand them to the browser as a blob download.
      const res = await fetch(`/app/audit/${auditId}/po.pdf`);
      if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
      const filename =
        res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ??
        "purchase-order.pdf";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      // Defer revoke: Safari can abort the download if the URL is revoked
      // before the browser's download task has grabbed the blob.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      shopify.toast.show((err as Error).message || "PDF download failed", {
        isError: true,
        duration: 5000,
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button variant="plain" loading={downloading} onClick={download}>
      Download PDF
    </Button>
  );
}
