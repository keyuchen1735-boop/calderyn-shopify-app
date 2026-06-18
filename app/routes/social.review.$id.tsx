// app/routes/social.review.$id.tsx
//
// Public per-founder approve/reject confirmation page for weekly social digest
// email links. GET is side-effect-free (email scanners pre-fetch links);
// mutation only on POST.
//
// Two token actions:
//   approve — per-founder: token carries `owner` (the founder's email).
//             GET shows confirm page or LI outcome (+ IG assets) for that founder.
//             POST claims a per-(drop,owner) row in social_link_post, posts to
//             THAT founder's own LinkedIn, and returns IG assets for manual posting.
//             The UNIQUE(digest_id,owner_email,platform) constraint is the atomic
//             single-post guard. Every result state carries igUrls + igCaption.
//   reject  — GET shows reject form; POST calls regenerateDigest

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { verifyActionToken } from "~/lib/social-digest/token.server";
import { regenerateDigest } from "~/lib/social-digest/run.server";
import { signedUrls, downloadSlide } from "~/lib/social-digest/store.server";
import { getSupabase } from "~/lib/supabase.server";
import { getValidConnectionFor } from "~/lib/social/linkedin-connection.server";
import { postMemberMultiImage, LinkedInPostError } from "~/lib/social/linkedin.server";

// Warning shown whenever a LinkedIn post may have left a partial post behind
// (post-phase failure or an already-failed claim) — must check before retrying.
const MAYBE_POSTED_WARNING = "⚠️ a post may have been created — check LinkedIn before retrying";
const NOT_CONNECTED_MESSAGE = "You haven't connected YOUR LinkedIn yet — connect first, then click the link again";

// social_link_post column subset we read back on the already-claimed path.
const LINK_POST_COLS = "status, post_urn, error";

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

interface DigestRow {
  id: string;
  week_range: string;
  status: string;
  regen_count: number;
  consumed_at: string | null;
  li_image_paths: string[];
  ig_image_paths: string[];
  li_caption: string;
  ig_caption: string;
  li_posted_at: string | null;
  post_results_json: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Loader return shapes
// ---------------------------------------------------------------------------

type LinkedInResult =
  | { posted: true; postUrn: string }
  | { posted: false; staged: true; reason: string }
  | { posted: false; staged?: never; error: string };

type LoaderData =
  | { state: "invalid" }
  | { state: "stale" }
  | { state: "stale_link" }
  | {
      // approve: not yet posted → show confirm
      state: "confirm";
      action: "approve" | "reject";
      id: string;
      token: string;
      range: string;
      liUrls: string[];
      igUrls: string[];
      liCaption: string;
      igCaption: string;
      regenCount: number;
      /** For approve: the founder whose profile this posts to. */
      owner?: string;
    }
  | {
      // approve: already posted → show LI result + IG assets
      state: "li_result";
      linkedin: LinkedInResult;
      liUrls: string[];
      liCaption: string;
      igUrls: string[];
      igCaption: string;
    };

// ---------------------------------------------------------------------------
// Action return shapes
// ---------------------------------------------------------------------------

type ActionData =
  | { state: "invalid" }
  | { state: "stale_link" }
  | { state: "li_posted"; linkedin: { posted: true; postUrn: string }; igUrls: string[]; igCaption: string }
  | { state: "li_not_connected"; liUrls: string[]; liCaption: string; igUrls: string[]; igCaption: string }
  | { state: "li_failed"; linkedin: { posted: false; error: string }; liUrls: string[]; liCaption: string; igUrls: string[]; igCaption: string }
  | { state: "regenerated" }
  | { state: "capped" }
  | { state: "error"; message: string };

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

function validateRow(r: unknown): r is DigestRow {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.week_range === "string" &&
    typeof o.status === "string" &&
    typeof o.regen_count === "number" &&
    (o.consumed_at === null || typeof o.consumed_at === "string") &&
    Array.isArray(o.li_image_paths) &&
    Array.isArray(o.ig_image_paths) &&
    typeof o.li_caption === "string" &&
    typeof o.ig_caption === "string" &&
    (o.li_posted_at === null || typeof o.li_posted_at === "string")
  );
}

// ---------------------------------------------------------------------------
// Loader — GET, no mutations
// ---------------------------------------------------------------------------

export async function loader({ request, params }: LoaderFunctionArgs) {
  const id = params.id ?? "";
  const token = new URL(request.url).searchParams.get("t") ?? "";

  const payload = verifyActionToken(token);
  if (!payload || payload.id !== id) {
    return json<LoaderData>({ state: "invalid" });
  }

  const { data, error } = await getSupabase()
    .from("social_digest")
    .select(
      "id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption, li_posted_at, post_results_json",
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    return json<LoaderData>({ state: "invalid" });
  }

  const r = data as Record<string, unknown>;
  if (!validateRow(r)) {
    return json<LoaderData>({ state: "invalid" });
  }
  const row = r as DigestRow;

  // Version mismatch — newer regeneration has superseded this token.
  if (payload.version !== row.regen_count) {
    return json<LoaderData>({ state: "stale" });
  }

  const { action } = payload;

  // Per-founder approve: if already actioned for this founder, show the result page.
  if (action === "approve") {
    // The token must name a founder (their email) — links from the pre-consolidation
    // era (or any tampered token) lack `owner` and can't be acted on.
    const owner = payload.owner;
    if (!owner) {
      return json<LoaderData>({ state: "stale_link" });
    }

    // Per-(drop, founder) claim/result lives in social_link_post.
    const { data: linkRow } = await getSupabase()
      .from("social_link_post")
      .select(LINK_POST_COLS)
      .eq("digest_id", id)
      .eq("owner_email", owner)
      .eq("platform", "linkedin")
      .single();

    const status = (linkRow as { status?: string } | null)?.status;
    if (status === "posted" || status === "failed") {
      let liUrls: string[];
      let igUrls: string[];
      try {
        [liUrls, igUrls] = await Promise.all([
          signedUrls(row.li_image_paths),
          signedUrls(row.ig_image_paths),
        ]);
      } catch {
        liUrls = [];
        igUrls = [];
      }
      const lr = linkRow as { status: string; post_urn: string | null };
      const linkedin: LinkedInResult =
        status === "posted"
          ? { posted: true, postUrn: lr.post_urn ?? "" }
          : { posted: false, staged: true, reason: MAYBE_POSTED_WARNING };
      return json<LoaderData>({
        state: "li_result",
        linkedin,
        liUrls,
        liCaption: row.li_caption,
        igUrls,
        igCaption: row.ig_caption,
      });
    }
    // No row (or status 'posting') → fall through to the confirm page below.
  }

  // Confirm page — generate preview URLs for both platforms (reject shows both too).
  let liUrls: string[];
  let igUrls: string[];
  try {
    [liUrls, igUrls] = await Promise.all([
      signedUrls(row.li_image_paths),
      signedUrls(row.ig_image_paths),
    ]);
  } catch {
    return json<LoaderData>({ state: "invalid" });
  }

  return json<LoaderData>({
    state: "confirm",
    action,
    id,
    token,
    range: row.week_range,
    liUrls,
    igUrls,
    liCaption: row.li_caption,
    igCaption: row.ig_caption,
    regenCount: row.regen_count,
    owner: action === "approve" ? payload.owner : undefined,
  });
}

// ---------------------------------------------------------------------------
// Action — POST, performs the mutation
// ---------------------------------------------------------------------------

export async function action({ request, params }: ActionFunctionArgs) {
  const id = params.id ?? "";
  const formData = await request.formData();
  const token = String(formData.get("token") ?? "");

  const payload = verifyActionToken(token);
  if (!payload || payload.id !== id) {
    return json<ActionData>({ state: "invalid" });
  }

  // Re-fetch row to verify version still matches.
  const { data, error } = await getSupabase()
    .from("social_digest")
    .select(
      "id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption, li_posted_at, post_results_json",
    )
    .eq("id", id)
    .single();

  if (error || !data) {
    return json<ActionData>({ state: "invalid" });
  }

  const r = data as Record<string, unknown>;
  if (!validateRow(r)) {
    return json<ActionData>({ state: "invalid" });
  }
  const row = r as DigestRow;

  // Version must match.
  if (payload.version !== row.regen_count) {
    return json<ActionData>({ state: "invalid" });
  }

  // ---------------------------------------------------------------------------
  // approve — per-founder, double-post-safe via social_link_post.
  // Every result state carries igUrls + igCaption for the Instagram "post manually"
  // section below the LinkedIn outcome.
  // ---------------------------------------------------------------------------
  if (payload.action === "approve") {
    // Re-verify the token names a founder; a missing owner means an outdated link.
    const owner = payload.owner;
    if (!owner) {
      return json<ActionData>({ state: "stale_link" });
    }

    const getIgAssets = async (): Promise<{ igUrls: string[]; igCaption: string }> => {
      try {
        const igUrls = await signedUrls(row.ig_image_paths);
        return { igUrls, igCaption: row.ig_caption };
      } catch {
        return { igUrls: [], igCaption: row.ig_caption };
      }
    };

    const getLiUrls = async (): Promise<string[]> => {
      try {
        return await signedUrls(row.li_image_paths);
      } catch {
        return [];
      }
    };

    // 1. ATOMIC CLAIM — insert the (drop, owner, linkedin) row. The UNIQUE
    //    constraint makes a second insert fail with 23505 = "someone already
    //    claimed this post", so we never double-post for the same founder.
    const { error: claimError } = await getSupabase()
      .from("social_link_post")
      .insert({ digest_id: id, owner_email: owner, platform: "linkedin", status: "posting" });

    if (claimError?.code === "23505") {
      // Already claimed — return the existing result without re-posting.
      const { data: existingRow } = await getSupabase()
        .from("social_link_post")
        .select(LINK_POST_COLS)
        .eq("digest_id", id)
        .eq("owner_email", owner)
        .eq("platform", "linkedin")
        .single();
      const existing = existingRow as { status?: string; post_urn?: string | null } | null;
      const ig = await getIgAssets();
      if (existing?.status === "posted") {
        return json<ActionData>({
          state: "li_posted",
          linkedin: { posted: true, postUrn: existing.post_urn ?? "" },
          ...ig,
        });
      }
      return json<ActionData>({
        state: "li_failed",
        linkedin: { posted: false, error: MAYBE_POSTED_WARNING },
        liUrls: await getLiUrls(),
        liCaption: row.li_caption,
        ...ig,
      });
    }

    if (claimError) {
      return json<ActionData>({ state: "error", message: claimError.message });
    }

    // 2. Claim won — resolve THIS founder's own LinkedIn connection.
    const conn = await getValidConnectionFor(owner);

    if (conn === null) {
      // Not connected: drop the claim so the link works once they connect.
      await getSupabase()
        .from("social_link_post")
        .delete()
        .eq("digest_id", id)
        .eq("owner_email", owner)
        .eq("platform", "linkedin");
      const ig = await getIgAssets();
      return json<ActionData>({
        state: "li_not_connected",
        liUrls: await getLiUrls(),
        liCaption: row.li_caption,
        ...ig,
      });
    }

    // 3. Download slides and post to the founder's profile.
    try {
      const slideBuffers = await Promise.all(row.li_image_paths.map(downloadSlide));
      const images = slideBuffers.map((bytes, i) => ({
        bytes,
        altText: `Calderyn — slide ${i + 1}`,
      }));
      const { postUrn } = await postMemberMultiImage({
        accessToken: conn.accessToken,
        authorUrn: conn.memberUrn,
        commentary: row.li_caption,
        images,
      });
      await getSupabase()
        .from("social_link_post")
        .update({ status: "posted", post_urn: postUrn })
        .eq("digest_id", id)
        .eq("owner_email", owner)
        .eq("platform", "linkedin");
      const ig = await getIgAssets();
      return json<ActionData>({ state: "li_posted", linkedin: { posted: true, postUrn }, ...ig });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown LinkedIn error";

      // Phase decides retryability (rule 12 — never silently claim success):
      //   pre-post → nothing was created → DELETE the claim so it's retryable.
      //   post/other → a post MAY exist → KEEP the row as 'failed'; warn the user.
      if (err instanceof LinkedInPostError && err.phase === "pre-post") {
        await getSupabase()
          .from("social_link_post")
          .delete()
          .eq("digest_id", id)
          .eq("owner_email", owner)
          .eq("platform", "linkedin");
        const ig = await getIgAssets();
        return json<ActionData>({
          state: "li_failed",
          linkedin: { posted: false, error: errMsg },
          liUrls: await getLiUrls(),
          liCaption: row.li_caption,
          ...ig,
        });
      }

      await getSupabase()
        .from("social_link_post")
        .update({ status: "failed", error: errMsg })
        .eq("digest_id", id)
        .eq("owner_email", owner)
        .eq("platform", "linkedin");
      const ig = await getIgAssets();
      return json<ActionData>({
        state: "li_failed",
        linkedin: { posted: false, error: MAYBE_POSTED_WARNING },
        liUrls: await getLiUrls(),
        liCaption: row.li_caption,
        ...ig,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // reject
  // ---------------------------------------------------------------------------
  const reasons = formData.getAll("reasons").map(String);
  const note = formData.get("note") != null ? String(formData.get("note")) : undefined;

  const result = await regenerateDigest(id, { reasons, note });

  if (result.capped) {
    return json<ActionData>({ state: "capped" });
  }
  if (result.ok) {
    return json<ActionData>({ state: "regenerated" });
  }
  return json<ActionData>({ state: "error", message: result.error ?? "Regeneration failed." });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const BRAND = {
  navy: "#10293B",
  cream: "#F1EFE8",
  teal: "#1E7079",
  tealDark: "#165860",
  white: "#ffffff",
  red: "#c0392b",
  muted: "#5b6b6e",
} as const;

const cardStyle: React.CSSProperties = {
  maxWidth: 600,
  margin: "80px auto",
  padding: "40px 36px",
  background: BRAND.white,
  borderRadius: 18,
  border: `1px solid rgba(0,0,0,.07)`,
  fontFamily: "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  color: BRAND.navy,
};

const btnStyle = (bg: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "13px 26px",
  background: bg,
  color: BRAND.white,
  border: 0,
  borderRadius: 999,
  fontSize: 15,
  fontWeight: 700,
  cursor: "pointer",
  marginRight: 12,
  marginTop: 8,
});

const imgStyle: React.CSSProperties = {
  width: 140,
  borderRadius: 8,
  border: `1px solid #d9d6cc`,
  marginRight: 8,
  marginBottom: 8,
  display: "inline-block",
};

const captionStyle: React.CSSProperties = {
  background: BRAND.cream,
  borderRadius: 10,
  padding: "14px 16px",
  fontSize: 14,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
  marginTop: 8,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontWeight: 600,
  color: BRAND.teal,
  marginBottom: 6,
  marginTop: 18,
};

const checkboxGroupStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  margin: "12px 0",
};

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: BRAND.cream,
  padding: "24px 16px",
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ImageRow({ urls }: { urls: string[] }) {
  return (
    <div style={{ margin: "10px 0" }}>
      {urls.map((u, i) => (
        // eslint-disable-next-line jsx-a11y/img-redundant-alt
        <img key={i} src={u} alt={`slide ${i + 1}`} style={imgStyle} />
      ))}
    </div>
  );
}

function CaptionBlock({ label, caption }: { label: string; caption: string }) {
  return (
    <>
      <span style={labelStyle}>{label}</span>
      <div style={captionStyle}>{caption}</div>
    </>
  );
}

function DownloadRow({ urls, prefix, btnBg }: { urls: string[]; prefix: string; btnBg: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      {urls.map((u, i) => (
        <a
          key={`${prefix}-dl-${i}`}
          href={u}
          download={`${prefix}-slide-${i + 1}.png`}
          style={{ ...btnStyle(btnBg), fontSize: 13, padding: "9px 18px" }}
        >
          {prefix.toUpperCase()} {i + 1}
        </a>
      ))}
    </div>
  );
}

function MessageCard({ heading, body }: { heading: string; body: string }) {
  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.navy }}>{heading}</h1>
        <p style={{ color: BRAND.muted, margin: 0 }}>{body}</p>
      </div>
    </div>
  );
}

/** Instagram assets section — shown below every LinkedIn outcome. */
function InstagramSection({ igUrls, igCaption }: { igUrls: string[]; igCaption: string }) {
  return (
    <div style={{ marginTop: 32, borderTop: `1px solid #e0ddd2`, paddingTop: 24 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, color: BRAND.navy }}>
        Instagram — post these {igUrls.length || 4} slides manually
      </h2>
      <p style={{ color: BRAND.muted, marginBottom: 8, fontSize: 14 }}>
        Download and post to your Instagram account.
      </p>
      <ImageRow urls={igUrls} />
      <CaptionBlock label="Instagram caption" caption={igCaption} />
      <DownloadRow urls={igUrls} prefix="ig" btnBg={BRAND.navy} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Default export — React component
// ---------------------------------------------------------------------------

export default function SocialReview() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  // After a successful action, show the action result.
  if (actionData) {
    switch (actionData.state) {
      case "li_posted": {
        const { linkedin, igUrls, igCaption } = actionData;
        const liLink = `https://www.linkedin.com/feed/update/${linkedin.postUrn}/`;
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 16px", fontSize: 22, color: BRAND.teal }}>
                ✅ Posted to LinkedIn
              </h1>
              <p style={{ color: BRAND.muted, margin: 0 }}>
                <a href={liLink} target="_blank" rel="noreferrer" style={{ color: BRAND.teal }}>
                  View post on LinkedIn
                </a>
              </p>
              <InstagramSection igUrls={igUrls} igCaption={igCaption} />
            </div>
          </div>
        );
      }

      case "li_not_connected": {
        const { liUrls, liCaption, igUrls, igCaption } = actionData;
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.navy }}>
                LinkedIn not connected
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 16 }}>
                {NOT_CONNECTED_MESSAGE}. In the meantime, post these slides manually:
              </p>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
              <DownloadRow urls={liUrls} prefix="li" btnBg={BRAND.teal} />
              <InstagramSection igUrls={igUrls} igCaption={igCaption} />
            </div>
          </div>
        );
      }

      case "li_failed": {
        const { linkedin, liUrls, liCaption, igUrls, igCaption } = actionData;
        const errMsg = "error" in linkedin ? linkedin.error : "Unknown error";
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.red }}>
                ⚠️ LinkedIn auto-post failed
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 16 }}>
                {errMsg}. The link in your email is still active — retry after fixing the issue,
                or post these slides manually:
              </p>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
              <DownloadRow urls={liUrls} prefix="li" btnBg={BRAND.teal} />
              <InstagramSection igUrls={igUrls} igCaption={igCaption} />
            </div>
          </div>
        );
      }

      case "regenerated":
        return (
          <MessageCard
            heading="Regenerating…"
            body="New content is being generated — a fresh email is on its way."
          />
        );

      case "capped":
        return (
          <MessageCard
            heading="Regeneration limit reached"
            body="5 regenerations reached — post the latest version manually or edit by hand."
          />
        );

      case "error":
        return (
          <MessageCard
            heading="Something went wrong"
            body={actionData.message}
          />
        );

      case "stale_link":
        return (
          <MessageCard
            heading="Link outdated"
            body="This link is from an old email — use your latest email to approve."
          />
        );

      case "invalid":
        return (
          <MessageCard
            heading="Link invalid or expired"
            body="This action link is no longer valid."
          />
        );
    }
  }

  // Loader states
  switch (loaderData.state) {
    case "invalid":
      return (
        <MessageCard
          heading="Link invalid or expired"
          body="This link is invalid or has expired. Links are valid for 7 days."
        />
      );

    case "stale":
      return (
        <MessageCard
          heading="Link no longer current"
          body="This link is no longer current — check your inbox for the latest email."
        />
      );

    case "stale_link":
      return (
        <MessageCard
          heading="Link outdated"
          body="This link is from an old email — use your latest email to approve."
        />
      );

    case "li_result": {
      const { linkedin, liUrls, liCaption, igUrls, igCaption } = loaderData;
      if (linkedin.posted) {
        const liLink = `https://www.linkedin.com/feed/update/${linkedin.postUrn}/`;
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.teal }}>
                ✅ Posted to LinkedIn
              </h1>
              <p style={{ margin: 0 }}>
                <a href={liLink} target="_blank" rel="noreferrer" style={{ color: BRAND.teal }}>
                  View post on LinkedIn
                </a>
              </p>
              <InstagramSection igUrls={igUrls} igCaption={igCaption} />
            </div>
          </div>
        );
      }
      // Not posted (failed/staged earlier) — show assets for manual posting.
      const errMsg = "error" in linkedin ? linkedin.error : ("reason" in linkedin ? linkedin.reason : "Unknown");
      return (
        <div style={pageStyle}>
          <div style={cardStyle}>
            <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.red }}>
              LinkedIn post result
            </h1>
            <p style={{ color: BRAND.muted, marginBottom: 16 }}>{errMsg}</p>
            <ImageRow urls={liUrls} />
            <CaptionBlock label="LinkedIn caption" caption={liCaption} />
            <DownloadRow urls={liUrls} prefix="li" btnBg={BRAND.teal} />
            <InstagramSection igUrls={igUrls} igCaption={igCaption} />
          </div>
        </div>
      );
    }

    case "confirm": {
      const { action: digestAction, token, range, liUrls, igUrls, liCaption, igCaption, owner } = loaderData;

      if (digestAction === "approve") {
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 4px", fontSize: 22, color: BRAND.navy }}>
                Approve &amp; post — {owner ?? ""}
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 20 }}>
                Week of {range} · posts your LinkedIn carousel + gives you the Instagram slides
              </p>

              <span style={labelStyle}>LinkedIn slides</span>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />

              <span style={{ ...labelStyle, marginTop: 24 }}>Instagram slides (for manual posting)</span>
              <ImageRow urls={igUrls} />
              <CaptionBlock label="Instagram caption" caption={igCaption} />

              <Form method="post" style={{ marginTop: 28 }}>
                <input type="hidden" name="token" value={token} />
                <button type="submit" style={btnStyle(BRAND.teal)}>
                  Approve &amp; post to LinkedIn
                </button>
              </Form>
            </div>
          </div>
        );
      }

      // reject
      return (
        <div style={pageStyle}>
          <div style={cardStyle}>
            <h1 style={{ margin: "0 0 4px", fontSize: 22, color: BRAND.navy }}>
              Reject &amp; regenerate
            </h1>
            <p style={{ color: BRAND.muted, marginBottom: 20 }}>Week of {range}</p>

            <span style={labelStyle}>LinkedIn slides</span>
            <ImageRow urls={liUrls} />
            <CaptionBlock label="LinkedIn caption" caption={liCaption} />

            <span style={{ ...labelStyle, marginTop: 24 }}>Instagram slides</span>
            <ImageRow urls={igUrls} />
            <CaptionBlock label="Instagram caption" caption={igCaption} />

            <Form method="post" style={{ marginTop: 28 }}>
              <input type="hidden" name="token" value={token} />

              <span style={labelStyle}>What needs improvement?</span>
              <div style={checkboxGroupStyle}>
                {(
                  [
                    "Tone too salesy",
                    "Wrong feature highlighted",
                    "Weak visuals",
                    "Captions need work",
                  ] as const
                ).map((reason) => (
                  <label
                    key={reason}
                    style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
                  >
                    <input type="checkbox" name="reasons" value={reason} />
                    <span style={{ fontSize: 14 }}>{reason}</span>
                  </label>
                ))}
              </div>

              <span style={labelStyle}>Additional notes (optional)</span>
              <textarea
                name="note"
                rows={3}
                placeholder="Anything else to guide the next version…"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid #c8c4bb",
                  fontSize: 14,
                  fontFamily: "inherit",
                  resize: "vertical" as const,
                  boxSizing: "border-box" as const,
                  marginBottom: 20,
                }}
              />

              <button type="submit" style={btnStyle(BRAND.red)}>
                Reject &amp; regenerate for everyone
              </button>
            </Form>
          </div>
        </div>
      );
    }
  }
}
