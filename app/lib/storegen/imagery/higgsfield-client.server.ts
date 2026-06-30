// app/lib/storegen/imagery/higgsfield-client.server.ts
// ponytail: the ONLY place in the codebase that talks directly to the Higgsfield
// product-photoshoot API. All other code goes through the ImageProvider seam (provider.server.ts →
// higgsfield.server.ts → here). Mocked in tests so no network calls or credits are spent in CI.
//
// Auth + base URL + the submit→poll flow are aligned with the shipped, working screener client
// (app/lib/screener/higgsfield.server.ts): `Authorization: Key <key>:<secret>` from
// HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET, POST to submit, GET /requests/{id}/status to poll.
// The product-photoshoot ENDPOINT path + request/response shape below are based on the
// higgsfield-product-photoshoot skill contract (modes: product_shot / lifestyle_scene, GPT Image 2
// backend) — a DIFFERENT flow from the screener's Soul model, so it needs its own endpoint. This
// path/shape is UNVERIFIED against live Higgsfield API docs and MUST be confirmed before
// production; CI cannot catch a wrong shape because the network is mocked.
const HF_BASE = "https://platform.higgsfield.ai";
const PHOTOSHOOT_PATH = "/v1/product-photoshoot";
const TERMINAL = new Set(["completed", "nsfw", "cancelled", "failed"]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HiggsfieldPhotoshootOpts {
  mode: "product_shot" | "lifestyle_scene";
  title: string;
  description: string;
  referenceImageUrl: string | null;
}

export async function runHiggsfieldProductPhotoshoot(opts: HiggsfieldPhotoshootOpts): Promise<string> {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) {
    throw new Error(
      "Higgsfield image generation is not configured (set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in .env.local)",
    );
  }
  const auth = `Key ${key}:${secret}`;

  const body: Record<string, unknown> = {
    mode: opts.mode,
    product_title: opts.title,
    product_description: opts.description,
  };
  if (opts.referenceImageUrl) body.image_url = opts.referenceImageUrl;

  const submitRes = await fetch(`${HF_BASE}${PHOTOSHOOT_PATH}`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => submitRes.statusText);
    throw new Error(`Higgsfield photoshoot request failed (${submitRes.status}): ${text}`);
  }
  const submitted = (await submitRes.json()) as { request_id?: string; id?: string };
  const requestId = submitted.request_id ?? submitted.id;
  if (!requestId) throw new Error("Higgsfield photoshoot did not return a request id");

  // Poll the platform-wide async status path until terminal or timeout (90 s, 3 s interval).
  const deadline = Date.now() + 90_000;
  for (;;) {
    const statusRes = await fetch(`${HF_BASE}/requests/${requestId}/status`, {
      method: "GET",
      headers: { Authorization: auth },
    });
    if (statusRes.ok) {
      const status = (await statusRes.json()) as { status?: string; images?: Array<{ url?: string }> };
      const state = String(status.status ?? "").toLowerCase();
      if (state === "completed") {
        const url = status.images?.find((i) => typeof i.url === "string")?.url;
        if (url) return url;
        throw new Error("Higgsfield photoshoot completed without an image url");
      }
      if (TERMINAL.has(state)) throw new Error(`Higgsfield photoshoot ${state}`);
    }
    if (Date.now() >= deadline) throw new Error(`Higgsfield photoshoot ${requestId} timed out after 90 s`);
    await sleep(3_000);
  }
}
