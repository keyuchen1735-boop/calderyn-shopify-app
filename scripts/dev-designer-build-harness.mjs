#!/usr/bin/env node
// Scratch harness: run designerFirstBuild offline against the calderyn-test
// demo shop (real catalog/settings), render every page, print a conversion
// checklist. Backs up and restores the shop's designer state around the run.
// Usage: node scripts/dev-designer-build-harness.mjs <template|scratch> "<brief>" <run-tag>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "vite";

for (const file of [
  "C:/Users/famou/Desktop/calderyn-shopify-app/.env.devserver.local",
  "C:/Users/famou/Desktop/calderyn-shopify-app/.env.local",
]) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && process.env[match[1]] === undefined && !/^(VERCEL|AWS_|TURBO|NX_)/.test(match[1])) {
        process.env[match[1]] = match[2].replace(/^"|"$/g, "");
      }
    }
  } catch {}
}

const SHOP_ID = "cb7457b0-2919-4846-9399-8da1840f87ba"; // calderyn-test (demo)
const [mode, brief, tag] = [process.argv[2] ?? "template", process.argv[3] ?? "", process.argv[4] ?? "run"];

const vite = await createServer({ appType: "custom", logLevel: "error", server: { middlewareMode: true } });
try {
  const engine = await vite.ssrLoadModule("/app/lib/designer/engine.server.ts");
  const render = await vite.ssrLoadModule("/app/lib/designer/render.server.ts");
  const { getSupabase } = await vite.ssrLoadModule("/app/lib/supabase.server.ts");
  const sb = getSupabase();

  const { data: backupDocs } = await sb.from("designer_documents").select("*").eq("shop_id", SHOP_ID);
  const { data: backupChat } = await sb.from("designer_chat").select("*").eq("shop_id", SHOP_ID);
  // On-disk backup first: an in-memory-only backup is lost if the process is
  // killed between the delete and the finally restore, orphaning the demo shop.
  const backupPath = `./.harness-backup-${SHOP_ID}.json`;
  writeFileSync(backupPath, JSON.stringify({ docs: backupDocs ?? [], chat: backupChat ?? [] }));
  console.log(`[backup] wrote ${backupPath} (docs=${backupDocs?.length ?? 0} chat=${backupChat?.length ?? 0}); restore manually if this run is killed`);
  await sb.from("designer_documents").delete().eq("shop_id", SHOP_ID);
  await sb.from("designer_chat").delete().eq("shop_id", SHOP_ID);

  try {
    const started = Date.now();
    const result = await engine.designerFirstBuild({
      shopId: SHOP_ID,
      message: brief,
      mode,
      onEvent: (e) =>
        console.log(`[page ${e.index}/${e.total}] ${e.page} @${Math.round((Date.now() - started) / 1000)}s — ${e.reply.slice(0, 110)}`),
    });
    console.log(`[done in ${Math.round((Date.now() - started) / 1000)}s] rejected=${result.rejectedEdits}`);

    const storeData = await engine.loadDesignerStoreData(SHOP_ID);
    const { data: rows } = await sb.from("designer_documents").select("route, html, css").eq("shop_id", SHOP_ID);
    const base = rows.find((r) => r.route === "base");
    const outDir = `./.harness-${tag}`;
    mkdirSync(outDir, { recursive: true });
    const CHECKS = [
      ["cta wording", (h) => /shop|browse|explore|add to cart|checkout|view/i.test(h)],
      ["price visible", (h) => /\$\d/.test(h)],
      ["no classless buttons", (h) => !/<button(?![^>]*class=)/i.test(h)],
      ["headline present", (h) => /<h1[\s>]/i.test(h)],
    ];
    for (const row of rows.filter((r) => r.route !== "base")) {
      const html = render.renderDesignerDocument({ html: row.html, css: `${base?.css ?? ""}\n${row.css}`, data: storeData });
      writeFileSync(`${outDir}/${row.route}.html`, html);
      console.log(`[check ${row.route}]`, CHECKS.map(([name, fn]) => `${fn(html) ? "OK" : "MISS"}:${name}`).join(" "));
    }
    console.log(`[out] ${outDir}/`);
  } finally {
    // Restore the demo shop's designer state no matter how the run went.
    await sb.from("designer_documents").delete().eq("shop_id", SHOP_ID);
    await sb.from("designer_chat").delete().eq("shop_id", SHOP_ID);
    if (backupDocs?.length) await sb.from("designer_documents").insert(backupDocs);
    if (backupChat?.length) await sb.from("designer_chat").insert(backupChat);
    console.log(`[restored] docs=${backupDocs?.length ?? 0} chat=${backupChat?.length ?? 0}`);
  }
} catch (error) {
  console.error("[harness] threw:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await vite.close();
}
