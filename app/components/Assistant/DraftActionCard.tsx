import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Badge, BlockStack, Button, ButtonGroup, InlineStack, Text } from "@shopify/polaris";
import type { DraftedAction } from "~/lib/assistant/types";
import { useEmbeddedNavigate } from "~/lib/embedded-nav";
import { fmtMoney } from "~/lib/format";
import { newIdempotencyKey } from "~/lib/ids";
import { CHAT_INLINE_ACTIONS } from "~/lib/labels";
import { useActionToast } from "~/lib/toast";

type ActionPayload = {
  ok: boolean;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

export function DraftActionCard({ action }: { action: DraftedAction }) {
  const navigate = useEmbeddedNavigate();
  const fetcher = useFetcher<ActionPayload>();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const running = fetcher.state !== "idle";
  const inline = CHAT_INLINE_ACTIONS.has(action.actionKind);
  useActionToast(fetcher.data);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.ok) setDone(true);
      setConfirming(false);
    }
  }, [fetcher.state, fetcher.data]);

  function execute() {
    // POSTs to the alert route's action, which re-derives everything from the
    // trusted alert record (detector allowlist, guardrails, audit) — the chat
    // surface adds no new execution path.
    const fd = new FormData();
    fd.set("kind", action.actionKind);
    fd.set("alertId", action.alertId);
    fd.set("idempotencyKey", newIdempotencyKey());
    fetcher.submit(fd, { method: "post", action: `/app/alerts/${action.alertId}` });
  }

  const review = () => navigate(`/app/alerts/${action.alertId}?action=${action.actionKind}`);

  return (
    <div className="calderyn-assistant-action">
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center" gap="200">
          <Text as="span" variant="bodySm" fontWeight="semibold">
            Proposed: {action.label} · {fmtMoney(action.dollarImpact)}/30d
          </Text>
          {done && <Badge tone="success">Done</Badge>}
        </InlineStack>

        {!done && !inline && (
          <InlineStack gap="200">
            <Button variant="primary" size="slim" onClick={review}>
              Review &amp; confirm
            </Button>
          </InlineStack>
        )}

        {!done && inline && !confirming && (
          <ButtonGroup>
            <Button variant="primary" size="slim" onClick={() => setConfirming(true)}>
              Run now
            </Button>
            <Button size="slim" onClick={review}>
              Review
            </Button>
          </ButtonGroup>
        )}

        {!done && inline && confirming && (
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">
              Run &ldquo;{action.label}&rdquo; now? This executes immediately and is logged to your
              action history.
            </Text>
            <ButtonGroup>
              <Button variant="primary" size="slim" loading={running} onClick={execute}>
                Confirm
              </Button>
              <Button size="slim" disabled={running} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </ButtonGroup>
          </BlockStack>
        )}

        {!done && fetcher.data?.error && (
          <Text as="p" variant="bodySm" tone="critical">
            {fetcher.data.error.message}
          </Text>
        )}
      </BlockStack>
    </div>
  );
}
