import { Box, Button, InlineStack, Text } from "@shopify/polaris";
import type { DraftedAction } from "~/lib/assistant/types";
import { useEmbeddedNavigate } from "~/lib/embedded-nav";

function dollars(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function DraftActionCard({ action }: { action: DraftedAction }) {
  const navigate = useEmbeddedNavigate();
  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderRadius="200"
      borderColor="border"
      borderWidth="025"
    >
      <InlineStack align="space-between" blockAlign="center" gap="200">
        <Text as="span" variant="bodySm" fontWeight="semibold">
          Proposed: {action.label} · {dollars(action.dollarImpact)}/30d
        </Text>
        <Button
          variant="primary"
          size="slim"
          onClick={() => navigate(`/app/alerts/${action.alertId}?action=${action.actionKind}`)}
        >
          Review &amp; confirm
        </Button>
      </InlineStack>
    </Box>
  );
}
