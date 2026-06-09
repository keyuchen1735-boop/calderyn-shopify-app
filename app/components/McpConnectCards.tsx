import { Banner, BlockStack, Button, Card, InlineGrid, Text, TextField } from "@shopify/polaris";
import { useCallback } from "react";

const MCP_URL = "https://calderyn-mcp.vercel.app/mcp";

export function McpConnectCards() {
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(MCP_URL);
  }, []);

  return (
    <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Connect via Claude.ai (recommended)
          </Text>
          <Text as="p" variant="bodyMd">
            In Claude.ai, open <b>Add connector</b>, paste the URL below, then approve the Calderyn
            consent screen that appears.
          </Text>
          <TextField label="MCP URL" value={MCP_URL} autoComplete="off" readOnly />
          <Button onClick={copy}>Copy URL</Button>
        </BlockStack>
      </Card>
      <Card>
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Connect via bearer token (advanced)
          </Text>
          <Text as="p" variant="bodyMd">
            For custom MCP clients that don't speak OAuth. Generate a token below and paste it as an{" "}
            <code>Authorization: Bearer …</code> header. Read-only.
          </Text>
          <Banner tone="info">
            <p>If your client speaks OAuth, use the recommended path on the left.</p>
          </Banner>
        </BlockStack>
      </Card>
    </InlineGrid>
  );
}
