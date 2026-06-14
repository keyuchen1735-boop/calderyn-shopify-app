import { Banner } from "@shopify/polaris";

// The full install guide now lives under Settings → "Claude connector". This
// slim banner points there so the "Claude connections" page stays focused on
// key/connection management.
export function McpConnectCards({ onSetup }: { onSetup?: () => void }) {
  return (
    <Banner
      tone="info"
      title="Set up the Claude connector"
      action={onSetup ? { content: "Open setup guide", onAction: onSetup } : undefined}
    >
      <p>New here? The step-by-step connector setup lives under Settings → Claude connector.</p>
    </Banner>
  );
}
