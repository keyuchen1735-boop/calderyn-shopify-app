import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigate, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  ButtonGroup,
  Card,
  DataTable,
  Layout,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  listOauthGrants,
  revokeOauthGrant,
  type McpTokenRow,
  type OauthGrantRow,
} from "~/lib/mcp_tokens.server";
import { useActionToast } from "~/lib/toast";
import { McpConnectCards } from "~/components/McpConnectCards";

type LoaderPayload = {
  tokens: McpTokenRow[];
  oauthGrants: OauthGrantRow[];
  error: { code: string; message: string } | null;
};

type ActionPayload = {
  ok: boolean;
  intent: "create" | "revoke" | "oauth-revoke" | "unknown";
  rawToken?: string;
  rawTokenName?: string;
  toast?: { message: string; isError?: boolean };
  error?: { code: string; message: string };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const [tokens, oauthGrants] = await Promise.all([
      listMcpTokens(session.shop),
      listOauthGrants(session.shop),
    ]);
    return json<LoaderPayload>({ tokens, oauthGrants, error: null });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json<LoaderPayload>({
      tokens: [],
      oauthGrants: [],
      error: { code: e.code ?? "ERROR", message: e.message ?? String(err) },
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as ActionPayload["intent"];

  try {
    if (intent === "create") {
      const name = String(formData.get("name") || "").trim();
      if (!name) {
        return json<ActionPayload>(
          {
            ok: false,
            intent,
            error: { code: "NAME_REQUIRED", message: "Token name is required" },
            toast: { message: "Token name is required", isError: true },
          },
          { status: 400 },
        );
      }
      const created = await createMcpToken({
        shopDomain: session.shop,
        name,
        createdByUser: null,
      });
      return json<ActionPayload>({
        ok: true,
        intent,
        rawToken: created.raw,
        rawTokenName: created.row.name,
        toast: { message: `Token "${name}" created` },
      });
    }

    if (intent === "revoke") {
      const tokenId = String(formData.get("token_id") || "");
      if (!tokenId) {
        return json<ActionPayload>(
          {
            ok: false,
            intent,
            error: { code: "TOKEN_ID_REQUIRED", message: "token_id is required" },
            toast: { message: "Missing token_id", isError: true },
          },
          { status: 400 },
        );
      }
      await revokeMcpToken({ shopDomain: session.shop, tokenId });
      return json<ActionPayload>({
        ok: true,
        intent,
        toast: { message: "Token revoked" },
      });
    }

    if (intent === "oauth-revoke") {
      const tokenId = String(formData.get("token_id") || "");
      if (!tokenId) {
        return json<ActionPayload>(
          {
            ok: false,
            intent,
            error: { code: "TOKEN_ID_REQUIRED", message: "token_id is required" },
            toast: { message: "Missing token_id", isError: true },
          },
          { status: 400 },
        );
      }
      await revokeOauthGrant({ shopDomain: session.shop, tokenId });
      return json<ActionPayload>({
        ok: true,
        intent,
        toast: { message: "Claude.ai workspace disconnected" },
      });
    }

    return json<ActionPayload>(
      {
        ok: false,
        intent: "unknown",
        error: { code: "INVALID_INTENT", message: `Unknown intent: ${intent}` },
        toast: { message: "Unknown intent", isError: true },
      },
      { status: 400 },
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json<ActionPayload>(
      {
        ok: false,
        intent,
        error: { code: e.code ?? "ERROR", message: e.message ?? String(err) },
        toast: { message: e.message ?? "Failed", isError: true },
      },
      { status: 500 },
    );
  }
};

export default function McpTokens() {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";
  const { tokens, oauthGrants, error } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  useActionToast(actionData);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");

  // Reveal modal shows the raw token exactly once.
  const [revealOpen, setRevealOpen] = useState(false);
  useEffect(() => {
    if (actionData?.ok && actionData.intent === "create" && actionData.rawToken) {
      setRevealOpen(true);
      setCreateOpen(false);
      setName("");
    }
  }, [actionData]);

  const rows = tokens.map((t) => [
    t.name,
    `${t.token_prefix}…`,
    (t.scopes ?? []).join(", "),
    t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "—",
    new Date(t.created_at).toLocaleString(),
    t.revoked_at ? (
      <Badge tone="critical" key={`status-${t.id}`}>Revoked</Badge>
    ) : (
      <Form method="post" key={`revoke-${t.id}`}>
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="token_id" value={t.id} />
        <Button submit tone="critical" loading={submitting} disabled={submitting}>
          Revoke
        </Button>
      </Form>
    ),
  ]);

  return (
    <Page
      title="MCP tokens"
      subtitle="Bearer tokens for the calderyn MCP server"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "Generate token", onAction: () => setCreateOpen(true) }}
    >
      <BlockStack gap="500">
        {error && (
          <Banner tone="critical" title="Couldn't load tokens">
            <p>
              {error.code}: {error.message}
            </p>
          </Banner>
        )}

        <McpConnectCards />

        <Layout>
          <Layout.Section>
            <Card>
              {tokens.length === 0 ? (
                <BlockStack gap="200">
                  <Text as="p">No MCP tokens yet. Click "Generate token" to create one.</Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    A token authenticates an external MCP client (e.g. Claude.ai connector)
                    against this shop's read-only data surface.
                  </Text>
                </BlockStack>
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                  headings={["Name", "Prefix", "Scopes", "Last used", "Created", ""]}
                  rows={rows}
                />
              )}
            </Card>
          </Layout.Section>
          {oauthGrants.length > 0 && (
            <Layout.Section>
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Connected Claude.ai workspaces
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Name", "Connected", "Last used", ""]}
                    rows={oauthGrants.map((g) => [
                      g.name,
                      new Date(g.created_at).toLocaleString(),
                      g.last_used_at ? new Date(g.last_used_at).toLocaleString() : "—",
                      <Form method="post" key={`oauth-revoke-${g.id}`}>
                        <input type="hidden" name="intent" value="oauth-revoke" />
                        <input type="hidden" name="token_id" value={g.id} />
                        <Button submit tone="critical" loading={submitting} disabled={submitting}>
                          Disconnect
                        </Button>
                      </Form>,
                    ])}
                  />
                </BlockStack>
              </Card>
            </Layout.Section>
          )}
        </Layout>
      </BlockStack>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Generate MCP token"
        primaryAction={{
          content: "Generate",
          loading: submitting,
          disabled: submitting || !name.trim(),
          onAction: () => {
            (document.getElementById("mcp-token-create-form") as HTMLFormElement | null)?.requestSubmit();
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setCreateOpen(false) }]}
      >
        <Modal.Section>
          <Form id="mcp-token-create-form" method="post">
            <input type="hidden" name="intent" value="create" />
            <TextField
              label="Token name"
              name="name"
              value={name}
              onChange={setName}
              autoComplete="off"
              helpText="A label so you can recognize this token in the list."
            />
          </Form>
        </Modal.Section>
      </Modal>

      <Modal
        open={revealOpen}
        onClose={() => setRevealOpen(false)}
        title={`Token: ${actionData?.rawTokenName ?? ""}`}
        primaryAction={{ content: "Done", onAction: () => setRevealOpen(false) }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Banner tone="warning" title="Copy this token now — it will not be shown again.">
              <p>Calderyn stores only a hash. If you lose it, revoke and regenerate.</p>
            </Banner>
            <TextField
              label="Bearer token"
              value={actionData?.rawToken ?? ""}
              autoComplete="off"
              readOnly
              monospaced
            />
            <ButtonGroup>
              <Button
                onClick={() => {
                  if (actionData?.rawToken) navigator.clipboard.writeText(actionData.rawToken);
                }}
              >
                Copy to clipboard
              </Button>
            </ButtonGroup>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
