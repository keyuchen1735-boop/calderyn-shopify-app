// Section-refresh applies: APPLY-TIME generation through the shop's real
// storefront pipeline. Runtime 1 = runStoreCommand prompt -> publish (its own
// intent/validate/prove chain, version-checked). Legacy = targeted hero/heading
// copy rewrite -> validateDocument -> saveDraft -> publishDoc. Both refuse to
// clobber an unpublished merchant draft, and both record enough prior state
// for a guarded one-click revert.
import { checkAiQuota } from "~/lib/ai-quota.server";
import { getAnthropic, radarDraftModel } from "~/lib/assistant/anthropic.server";
import { readStorefrontReleaseState } from "~/lib/storefront-bundle/build.server";
import { rollbackStorefrontRelease } from "~/lib/storefront-bundle/release.server";
import { runStoreCommand, StoreCommandError } from "~/lib/storefront-command/command.server";
import { loadDraftDoc, loadPublishedDoc, publishDoc, saveDraft } from "~/lib/storebuilder/page-document.server";
import { validateDocument } from "~/lib/storebuilder/validate";
import type { BlockDocument, PageKey } from "~/lib/storebuilder/types";
import { getCatalog } from "~/lib/storefront/catalog.server";
import { RadarApplyError, sha256, type ApplyOutcome } from "./apply-seo.server";
import type { RadarMoveRow } from "./types";

const SECTION_SYSTEM =
  "You rewrite one storefront section's copy for an online store. Given a brief and the current headline " +
  "and subhead, produce a fresh, concrete, persuasive replacement in the same voice. No emoji, no " +
  'exclamation marks, no invented claims (prices, awards, guarantees). Respond with JSON only: ' +
  '{"headline":"...","subhead":"..."}';

const HEADLINE_MIN = 4;
const HEADLINE_MAX = 80;
const SUBHEAD_MAX = 160;

async function generateSectionCopy(
  shopId: string,
  brief: string,
  current: { headline: string; subhead: string },
): Promise<{ headline: string; subhead: string }> {
  const verdict = await checkAiQuota({ shopId, feature: "radar_apply", trusted: true });
  if (!verdict.allowed) throw new RadarApplyError(verdict.code, verdict.message, 429);
  let text = "";
  try {
    const res = await getAnthropic().messages.create({
      model: radarDraftModel(),
      max_tokens: 300,
      system: SECTION_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ brief, current }) }],
    });
    text = res.content.find((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")?.text ?? "";
  } catch (err) {
    // No silent template into a live store: surface, keep the move draft.
    console.error(`[radar] section copy generation failed for shop ${shopId}`, err);
    throw new RadarApplyError(
      "section_copy_failed",
      "The new section text could not be generated. Your store was not changed - try again in a moment.",
      502,
    );
  }
  try {
    const start = text.indexOf("{");
    const parsed = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1)) as { headline?: unknown; subhead?: unknown };
    const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const subhead = typeof parsed.subhead === "string" ? parsed.subhead.trim() : "";
    if (headline.length < HEADLINE_MIN || headline.length > HEADLINE_MAX || subhead.length > SUBHEAD_MAX
      || /ploy/i.test(`${headline} ${subhead}`)) {
      throw new Error("out-of-bounds section copy");
    }
    return { headline, subhead };
  } catch {
    throw new RadarApplyError(
      "section_copy_failed",
      "The new section text came back malformed. Your store was not changed - try again in a moment.",
      502,
    );
  }
}

// ── Runtime 1 ────────────────────────────────────────────────────────────────

interface Runtime1Release {
  draftVersionId: string | null;
  publishedVersionId: string | null;
}

async function applyRuntime1(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
  release: Runtime1Release,
): Promise<ApplyOutcome> {
  if (release.draftVersionId && release.draftVersionId !== release.publishedVersionId) {
    throw new RadarApplyError(
      "draft_in_progress",
      "You have unpublished store changes. Publish or undo them first, then apply this move.",
      409,
    );
  }
  const brief = String(move.payload.brief ?? "").trim();
  if (!brief) throw new RadarApplyError("bad_payload", "This move is missing its refresh brief.", 422);
  // Tracks the prompt-stage receipt so a later publish-stage failure can best-effort undo the
  // orphaned draft it left behind, rather than leaving it sitting on the shop blaming the merchant
  // (draft_in_progress guard, above) for a draft Radar itself created.
  let edit: Awaited<ReturnType<typeof runStoreCommand>> | null = null;
  try {
    edit = await runStoreCommand({
      shopId,
      actorId,
      command: { kind: "prompt", prompt: brief, expectedDraftVersionId: release.draftVersionId ?? null },
    });
    if (edit.status === "unchanged") {
      throw new RadarApplyError("section_apply_failed", edit.message, 422);
    }
    if (edit.status !== "installed") {
      throw new RadarApplyError("section_apply_failed", "The store change did not produce a draft.", 500);
    }
    const published = await runStoreCommand({
      shopId,
      actorId,
      command: { kind: "publish", expectedDraftVersionId: edit.versionId },
    });
    if (published.status !== "published") {
      throw new RadarApplyError("section_apply_failed", "The store change did not publish.", 500);
    }
    return {
      priorState: {
        kind: "section",
        runtime: 1,
        priorPublishedVersionId: release.publishedVersionId,
        appliedVersionId: published.versionId,
      },
      // For runtime 1 the published version id IS the state fingerprint.
      appliedStateHash: published.versionId,
    };
  } catch (err) {
    if (edit?.status === "installed" && edit.undo) {
      try {
        await runStoreCommand({
          shopId,
          actorId,
          command: { kind: "undo", targetVersionId: edit.undo.targetVersionId, expectedDraftVersionId: edit.undo.expectedDraftVersionId },
        });
      } catch (undoErr) {
        console.error(`[radar] failed to undo orphaned draft for shop ${shopId}`, undoErr);
      }
    }
    if (err instanceof StoreCommandError) {
      throw new RadarApplyError(err.code, err.message, err.status);
    }
    throw err;
  }
}

// ── Legacy (block documents) ────────────────────────────────────────────────

/** The block whose copy a refresh may touch: the hero, else the first rawHtml
 *  section with a heading. Anything else is not a refreshable section. */
function pickSectionBlock(doc: BlockDocument): { index: number; type: "hero" | "rawHtml" } | null {
  const hero = doc.blocks.findIndex((b) => b.type === "hero");
  if (hero >= 0) return { index: hero, type: "hero" };
  const raw = doc.blocks.findIndex(
    (b) => b.type === "rawHtml" && typeof b.props.html === "string" && /<h[1-4][^>]*>/i.test(b.props.html),
  );
  if (raw >= 0) return { index: raw, type: "rawHtml" };
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function applyLegacy(shopId: string, move: RadarMoveRow, actorId: string | null): Promise<ApplyOutcome> {
  const target = String(move.payload.target ?? "home");
  // Defensive backstop: on the legacy runtime every product shares ONE PDP
  // page_document, so applying a product-specific refresh here would write
  // that one product's copy into the shop-wide template. draft.server.ts's
  // downgradeLegacyPdpCandidate keeps this from ever being drafted as an
  // applyable move going forward, but this guard fails safe for anything
  // already drafted before that check existed - checked before any read, so
  // it can never be bypassed by publish state.
  if (target === "pdp") {
    throw new RadarApplyError(
      "pdp_shared_template",
      "Product pages share one layout on this store. Open the store builder to update it.",
      422,
    );
  }
  const pageKey: PageKey = "home";
  const brief = String(move.payload.brief ?? "").trim();
  if (!brief) throw new RadarApplyError("bad_payload", "This move is missing its refresh brief.", 422);
  const published = await loadPublishedDoc(shopId, pageKey);
  if (!published) {
    throw new RadarApplyError(
      "page_not_published",
      "This page isn't published yet, so there's nothing to refresh.",
      409,
    );
  }
  const draft = await loadDraftDoc(shopId, pageKey);
  if (draft && sha256(draft) !== sha256(published)) {
    throw new RadarApplyError(
      "draft_in_progress",
      "You have unpublished store changes. Publish or undo them first, then apply this move.",
      409,
    );
  }
  const picked = pickSectionBlock(published);
  if (!picked) {
    throw new RadarApplyError("no_refreshable_section", "This page has no section Radar can refresh.", 422);
  }
  const block = published.blocks[picked.index];
  const current = picked.type === "hero"
    ? {
        headline: typeof block.props.headline === "string" ? block.props.headline : "",
        subhead: typeof block.props.subhead === "string" ? block.props.subhead : "",
      }
    : { headline: "", subhead: "" };
  const copy = await generateSectionCopy(shopId, brief, current);

  const next: BlockDocument = JSON.parse(JSON.stringify(published)) as BlockDocument;
  const nextBlock = next.blocks[picked.index];
  if (picked.type === "hero") {
    nextBlock.props = { ...nextBlock.props, headline: copy.headline, subhead: copy.subhead };
  } else {
    const html = String(nextBlock.props.html);
    const escapedHeadline = escapeHtml(copy.headline);
    nextBlock.props = {
      ...nextBlock.props,
      // Replace only the first heading's inner text. A replacer FUNCTION (not a replacement
      // pattern string) so a headline containing $1/$&/$`/$'-shaped substrings (e.g. "Save $2
      // today") is inserted verbatim rather than being read as a capture-group reference and
      // corrupting the surrounding markup; entity-escaped since it's untrusted merchant/AI text
      // going straight into HTML. saveDraft re-sanitizes regardless.
      html: html.replace(
        /(<h[1-4][^>]*>)[\s\S]*?(<\/h[1-4]>)/i,
        (_match, open: string, close: string) => `${open}${escapedHeadline}${close}`,
      ),
    };
  }

  const [products, collections] = await Promise.all([
    getCatalog().listProducts(shopId),
    getCatalog().listCollections(shopId),
  ]);
  const result = validateDocument(next, {
    productIds: new Set(products.map((p) => p.id)),
    collectionHandles: new Set(collections.map((c) => c.handle)),
  });
  if (result.missingFunctional.length > 0) {
    throw new RadarApplyError("section_apply_failed", "The refreshed page failed validation. Your store was not changed.", 422);
  }
  await saveDraft(shopId, pageKey, result.doc);
  await publishDoc(shopId, pageKey);
  // Re-read what actually landed instead of hashing the in-memory doc: Postgres jsonb
  // canonicalizes object key order on write, so a hash taken before the round trip (even of the
  // sanitized doc) can byte-differ from what loadPublishedDoc returns later - which is exactly
  // what the revert-side staleness check (below) hashes. Hash identically-shaped reads on both
  // sides or every legitimate one-click revert false-conflicts.
  const publishedNow = await loadPublishedDoc(shopId, pageKey);
  return {
    priorState: { kind: "section", runtime: 0, pageKey, doc: published, actorId },
    appliedStateHash: sha256(publishedNow),
  };
}

// ── Entry points ────────────────────────────────────────────────────────────

export async function applySectionRefresh(
  shopId: string,
  move: RadarMoveRow,
  actorId: string | null,
): Promise<ApplyOutcome> {
  const release = await readStorefrontReleaseState(shopId);
  if (release.publishedRuntimeVersion === 1) {
    return applyRuntime1(shopId, move, actorId, release);
  }
  return applyLegacy(shopId, move, actorId);
}

export async function revertSectionRefresh(
  shopId: string,
  move: RadarMoveRow,
  opts: { confirm: boolean },
  actorId: string | null,
): Promise<void> {
  const ps = move.priorState as {
    runtime?: number;
    priorPublishedVersionId?: string | null;
    appliedVersionId?: string;
    pageKey?: PageKey;
    doc?: BlockDocument;
  } | null;
  if (!ps) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);

  if (ps.runtime === 1) {
    if (!ps.priorPublishedVersionId) {
      throw new RadarApplyError("no_prior_version", "There was no earlier published store to go back to.", 422);
    }
    const release = await readStorefrontReleaseState(shopId);
    if (release.publishedVersionId !== ps.appliedVersionId && !opts.confirm) {
      throw new RadarApplyError(
        "revert_conflict",
        "Your store was published again after this move was applied. Reverting will replace the newer version.",
        409,
      );
    }
    await rollbackStorefrontRelease({
      shopId,
      targetVersionId: ps.priorPublishedVersionId,
      expectedPublishedVersionId: release.publishedVersionId,
      actorId,
    });
    return;
  }

  const pageKey = ps.pageKey ?? "home";
  const doc = ps.doc;
  if (!doc) throw new RadarApplyError("nothing_to_revert", "This move has nothing to undo.", 422);
  const current = await loadPublishedDoc(shopId, pageKey);
  // Staleness guard: hash the live doc against what the apply published; a
  // mismatch means the merchant edited since - require an explicit confirm.
  if (sha256(current) !== move.appliedStateHash && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "This page was edited after the move was applied. Reverting will overwrite those edits.",
      409,
    );
  }
  // Draft guard: saveDraft below overwrites draft_json unconditionally. If the merchant has
  // started (unpublished) edits since the apply, blowing those away silently would blame them for
  // work Radar itself destroyed - require the same explicit confirm as the staleness guard above.
  const liveDraft = await loadDraftDoc(shopId, pageKey);
  if (liveDraft && sha256(liveDraft) !== sha256(current) && !opts.confirm) {
    throw new RadarApplyError(
      "revert_conflict",
      "You have unpublished edits on this page. Reverting will overwrite them.",
      409,
    );
  }
  await saveDraft(shopId, pageKey, doc);
  await publishDoc(shopId, pageKey);
}
