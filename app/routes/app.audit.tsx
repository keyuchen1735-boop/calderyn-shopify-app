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
  Collapsible,
  IndexTable,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney, fmtRelTime, fmtAbsTime, shortId } from "~/lib/format";
import { recovered as recoveredOf } from "~/lib/recovered";
import { ACTION_LABELS, COST_SOURCE_LABELS } from "~/lib/labels";
import { auditLegibility } from "~/lib/audit-legibility";
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

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack gap="150">
      <Text as="span" variant="bodySm" fontWeight="semibold">{label}:</Text>
      <Text as="span" variant="bodySm" tone="subdued">{value}</Text>
    </InlineStack>
  );
}

function AuditRowEx({
  a, index, submitting,
}: { a: AuditEntry; index: number; submitting: boolean }) {
  const [open, setOpen] = useState(false);
  const leg = auditLegibility(a);
  const actionLabel = ACTION_LABELS[a.action_kind] ?? a.action_kind;
  const canUndo = a.undo_eligible && !a.undo_of;
  const hasPoPdf =
    a.action_kind === "create_po_draft" && a.outcome === "succeeded" && Boolean(a.post_state?.po);
  const estimateCents = Number(a.post_state?.estimate_cents ?? 0);
  const showEstimate =
    !a.dollar_impact_at_exec && estimateCents > 0 && a.action_kind !== "snooze_alert";
  const showImpact = Boolean(a.dollar_impact_at_exec);

  return (
    <>
      <IndexTable.Row id={a.id} position={index * 2}>
        <IndexTable.Cell>
          <Button
            variant="tertiary"
            icon={open ? ChevronDownIcon : ChevronRightIcon}
            onClick={() => setOpen((v) => !v)}
            accessibilityLabel={open ? "Hide details" : "Show details"}
          />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Tooltip content={fmtAbsTime(a.created_at)}>
            <Text as="span" variant="bodySm" fontWeight="semibold">{fmtRelTime(a.created_at)}</Text>
          </Tooltip>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="p" variant="bodySm" fontWeight="semibold">
              {a.undo_of ? `Reversed — ${actionLabel}` : actionLabel}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">{leg.why}</Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={leg.mode === "auto" ? "info" : undefined}>
            {leg.mode === "auto" ? "Auto" : "Manual"}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Tooltip content={a.target}><Text as="span" variant="bodySm">{shortId(a.target)}</Text></Tooltip>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050" inlineAlign="end">
            <Text as="p" alignment="end" variant="bodySm" fontWeight="semibold">
              {a.dollar_impact_at_exec < 0 ? "-" : ""}{fmtMoney(Math.abs(a.dollar_impact_at_exec || 0))}
            </Text>
            {showImpact && <Text as="p" alignment="end" variant="bodySm" tone="subdued">{leg.marginBasisLabel}</Text>}
            {showEstimate && <Text as="p" alignment="end" variant="bodySm" tone="subdued">est. {fmtMoney(estimateCents)}</Text>}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={a.outcome === "succeeded" ? "success" : a.outcome === "retrying" ? "attention" : "critical"}>
            {a.outcome}
          </Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {canUndo || hasPoPdf ? (
            <InlineStack gap="200" wrap={false}>
              {canUndo && (
                <Form method="post">
                  <input type="hidden" name="intent" value="undo" />
                  <input type="hidden" name="auditId" value={a.id} />
                  <Button submit variant="plain" loading={submitting} disabled={submitting}>Undo</Button>
                </Form>
              )}
              {hasPoPdf && <DownloadPoButton auditId={a.id} />}
            </InlineStack>
          ) : (<Text as="span" tone="subdued">—</Text>)}
        </IndexTable.Cell>
      </IndexTable.Row>
      <IndexTable.Row id={`${a.id}-d`} position={index * 2 + 1} disabled>
        <IndexTable.Cell colSpan={8}>
          <Collapsible id={`detail-${a.id}`} open={open} transition={{ duration: "150ms" }}>
            <Box padding="300" background="bg-surface-secondary">
              <BlockStack gap="150">
                <DetailLine label="Why this fired" value={leg.whyDetail ?? leg.why} />
                {a.failure_reason && <DetailLine label="Failure reason" value={a.failure_reason} />}
                {showImpact && (
                  <DetailLine label="Booked margin"
                    value={`${a.dollar_impact_at_exec < 0 ? "-" : ""}${fmtMoney(Math.abs(a.dollar_impact_at_exec))} · ${leg.marginBasisLabel}`} />
                )}
                {leg.costLineage.length > 0 && (
                  <InlineStack gap="150" blockAlign="center">
                    <Text as="span" variant="bodySm" fontWeight="semibold">Cost lineage:</Text>
                    {leg.costLineage.map((s, i) => (
                      <Badge key={i} tone={s.source === "unavailable" ? "warning" : undefined}>
                        {`${s.kind === "ad_spend" ? "Ad spend" : s.kind === "cogs" ? "COGS" : "Price"}: ${COST_SOURCE_LABELS[s.source] ?? s.source}`}
                      </Badge>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>
            </Box>
          </Collapsible>
        </IndexTable.Cell>
      </IndexTable.Row>
    </>
  );
}

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

  return (
    <Page
      fullWidth
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
          <IndexTable
            selectable={false}
            itemCount={audit.length}
            headings={[
              { title: "" }, { title: "Time" }, { title: "Action" }, { title: "Mode" },
              { title: "Target" }, { title: "Impact", alignment: "end" }, { title: "Status" }, { title: "" },
            ]}
          >
            {(audit as AuditEntry[]).map((a, i) => (
              <AuditRowEx key={a.id} a={a} index={i} submitting={submitting} />
            ))}
          </IndexTable>
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
