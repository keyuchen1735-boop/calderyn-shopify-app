// app/lib/storegen/imagery/higgsfield-client.server.ts
// ponytail: the ONLY place in the codebase that talks directly to the Higgsfield
// product-photoshoot API. All other code goes through the ImageProvider seam (provider.ts →
// higgsfield.server.ts → here). Mocked in tests so no network calls or credits are spent in CI.
export interface HiggsfieldPhotoshootOpts {
  mode: "product_shot" | "lifestyle_scene";
  title: string;
  description: string;
  referenceImageUrl: string | null;
}

export async function runHiggsfieldProductPhotoshoot(opts: HiggsfieldPhotoshootOpts): Promise<string> {
  const apiKey = process.env.HIGGSFIELD_API_KEY;
  const workspaceId = process.env.HIGGSFIELD_WORKSPACE_ID;
  if (!apiKey || !workspaceId) {
    throw new Error(
      "Higgsfield image generation is not configured (set HIGGSFIELD_API_KEY and HIGGSFIELD_WORKSPACE_ID in .env.local)",
    );
  }

  // POST to the Higgsfield product-photoshoot endpoint and poll until the generation is done.
  // The request body matches the higgsfield-product-photoshoot skill/CLI contract.
  const body: Record<string, unknown> = {
    workspace_id: workspaceId,
    mode: opts.mode,
    product_title: opts.title,
    product_description: opts.description,
  };
  if (opts.referenceImageUrl) body.reference_image_url = opts.referenceImageUrl;

  const initRes = await fetch("https://api.higgsfield.ai/v1/product-photoshoot", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!initRes.ok) {
    const text = await initRes.text().catch(() => initRes.statusText);
    throw new Error(`Higgsfield photoshoot request failed (${initRes.status}): ${text}`);
  }
  const { id: jobId } = (await initRes.json()) as { id: string };
  if (!jobId) throw new Error("Higgsfield photoshoot: no job id returned");

  // Poll until done or timeout (60 s, 3 s interval).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    const pollRes = await fetch(`https://api.higgsfield.ai/v1/product-photoshoot/${jobId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!pollRes.ok) continue;
    const job = (await pollRes.json()) as { status: string; output_url?: string };
    if (job.status === "completed" && job.output_url) return job.output_url;
    if (job.status === "failed") throw new Error(`Higgsfield photoshoot job ${jobId} failed`);
  }
  throw new Error(`Higgsfield photoshoot job ${jobId} timed out after 60 s`);
}
