// app/routes/app.screener.tsx
// NOTE: do NOT add `export const config = { maxDuration: ... }` here. With
// v3_singleFetch, a per-route config makes @vercel/remix split this route into its
// own serverless function that does NOT serve the single-fetch `/app/screener.data`
// path — so client-side nav 404s while the full page load works. If the live (Claude)
// path later needs a longer timeout, set it for the whole server function in
// vercel.json, not per-route.
import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  FormLayout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { Scorecard } from "~/components/Scorecard";
import { executeScreen } from "~/lib/screener/orchestrate.server";
import { getLatestRun, listRuns } from "~/lib/screener/runs.server";
import {
  DEFAULT_SPEND_CENTS,
  MAX_SPEND_CENTS,
  MIN_SPEND_CENTS,
  type CreativeInput,
  type CreativeScreenRun,
} from "~/lib/screener/types";

// clampSpend: if raw is absent/empty/NaN → return DEFAULT.
// Any parseable number (including 0) is clamped to [MIN, MAX].
// This means clampSpend("0") === MIN (1000), clampSpend(null) === DEFAULT (50000).
export function clampSpend(raw: FormDataEntryValue | null): number {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return DEFAULT_SPEND_CENTS;
  }
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_SPEND_CENTS;
  return Math.min(Math.max(n, MIN_SPEND_CENTS), MAX_SPEND_CENTS);
}

export function parseCreativeForm(form: FormData): CreativeInput {
  const str = (k: string) => String(form.get(k) ?? "").trim();
  const imageUrl = str("imageUrl");
  return {
    imageUrl: imageUrl || null,
    headline: str("headline"),
    primaryText: str("primaryText"),
    cta: str("cta") || "SHOP_NOW",
    destinationUrl: str("destinationUrl"),
    audience: str("audience"),
  };
}

type LoaderPayload = { latest: CreativeScreenRun | null; history: CreativeScreenRun[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
  ]);
  return json<LoaderPayload>({ latest, history });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const input = parseCreativeForm(form);
  const assumedSpendCents = clampSpend(form.get("assumedSpendCents"));
  const run = await executeScreen({ shop: session.shop, input, assumedSpendCents });
  return json(run);
};

export default function Screener() {
  const { latest, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const run: CreativeScreenRun | null =
    (fetcher.data as CreativeScreenRun | undefined) ?? latest;
  const running = fetcher.state !== "idle";
  const card = run?.scorecard ?? null;

  const [spend, setSpend] = useState<string>(
    String((latest?.assumedSpendCents ?? DEFAULT_SPEND_CENTS) / 100),
  );
  useEffect(() => {
    if (fetcher.data?.assumedSpendCents)
      setSpend(String(fetcher.data.assumedSpendCents / 100));
  }, [fetcher.data]);

  return (
    <Page
      title="Ad Pre-Screen"
      subtitle="Score an ad's potential before it goes live — a test screening before you hit publish"
    >
      <BlockStack gap="500">
        <Card>
          <fetcher.Form method="post">
            <FormLayout>
              <TextField label="Headline" name="headline" autoComplete="off" />
              <TextField
                label="Primary text"
                name="primaryText"
                multiline={3}
                autoComplete="off"
              />
              <FormLayout.Group>
                <TextField
                  label="Call to action"
                  name="cta"
                  autoComplete="off"
                  placeholder="SHOP_NOW"
                />
                <TextField
                  label="Destination URL"
                  name="destinationUrl"
                  autoComplete="off"
                  placeholder="https://…?utm_content=SKU"
                />
              </FormLayout.Group>
              <TextField
                label="Target audience"
                name="audience"
                autoComplete="off"
                placeholder="Women 25-44 interested in skincare"
              />
              <TextField
                label="Image URL (optional)"
                name="imageUrl"
                autoComplete="off"
                placeholder="https://…/creative.jpg"
              />
              <TextField
                label="Assumed spend (USD)"
                type="number"
                autoComplete="off"
                value={spend}
                onChange={setSpend}
                helpText="Drives the ROAS estimate. Edit and re-screen to see the impact."
              />
              <input
                type="hidden"
                name="assumedSpendCents"
                value={Math.round(Number(spend || 0) * 100)}
              />
              <Button submit variant="primary" loading={running} disabled={running}>
                Screen this ad
              </Button>
            </FormLayout>
          </fetcher.Form>
        </Card>

        {running && !card && (
          <Card>
            <Text as="p" tone="subdued">
              Scoring this creative… ~20–30 seconds.
            </Text>
          </Card>
        )}

        {run?.status === "error" && (
          <Banner tone="critical" title="Screening failed">
            <p>{run.error}</p>
          </Banner>
        )}

        {card && <Scorecard card={card} />}

        {!run && !running && (
          <Card>
            <Text as="p" tone="subdued">
              No screens yet. Enter an ad above and screen it before you spend.
            </Text>
          </Card>
        )}

        {history.length > 0 && (
          <Text as="p" tone="subdued" variant="bodySm">
            {history.length} previous screen(s) on record.
          </Text>
        )}
      </BlockStack>
    </Page>
  );
}
