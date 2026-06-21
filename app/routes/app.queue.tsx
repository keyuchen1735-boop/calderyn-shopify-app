import { Form, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { newIdempotencyKey } from "~/lib/ids";
import { fmtMoney } from "~/lib/format";
import { alertDetectorLabel, ACTION_LABELS } from "~/lib/labels";
import type { QueueProposal } from "~/lib/types";

type LoaderPayload = {
  proposals: QueueProposal[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const client = calderynClient(session.shop);
  try {
    const proposals = await client.queue.list(request.signal);
    return json<LoaderPayload>({ proposals, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({
      proposals: [],
      error: { code: e.code ?? "ERROR", message: e.message },
    });
  }
};

function confidenceTone(pct: number): "success" | "attention" | "warning" {
  if (pct >= 70) return "success";
  if (pct >= 50) return "attention";
  return "warning";
}

function ProposalRow({ p }: { p: QueueProposal }) {
  const idempotencyKey = newIdempotencyKey();
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
            <Form method="post" action={`/app/alerts/${p.alertId}`}>
              <input type="hidden" name="kind" value={p.action_kind} />
              <input type="hidden" name="alertId" value={p.alertId} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              <Button variant="primary" submit>
                Approve
              </Button>
            </Form>
          </InlineStack>
        </BlockStack>
      </Card>
    </Box>
  );
}

export default function ActionQueue() {
  const { proposals, error } = useLoaderData<typeof loader>();

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
                  Nothing waiting — Calderyn will queue suggestions here as it spots them.
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Box>
      )}
      {proposals.map((p) => (
        <ProposalRow key={`${p.alertId}:${p.action_kind}`} p={p} />
      ))}
    </Page>
  );
}
