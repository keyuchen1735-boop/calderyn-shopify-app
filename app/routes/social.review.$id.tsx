// app/routes/social.review.$id.tsx
//
// Public per-platform approve/reject confirmation page for weekly social digest
// email links. GET is side-effect-free (email scanners pre-fetch links);
// mutation only on POST.
//
// Three token actions:
//   approve-linkedin  — GET shows LI confirm or LI result; POST claims li_posted_at + auto-posts
//   approve-instagram — GET shows IG confirm or IG assets; POST claims ig_approved_at
//   reject            — GET shows reject form; POST calls regenerateDigest

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { verifyActionToken } from "~/lib/social-digest/token.server";
import { regenerateDigest } from "~/lib/social-digest/run.server";
import { signedUrls, downloadSlide } from "~/lib/social-digest/store.server";
import { getSupabase } from "~/lib/supabase.server";
import { getValidConnection } from "~/lib/social/linkedin-connection.server";
import { postMemberMultiImage } from "~/lib/social/linkedin.server";

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
  ig_approved_at: string | null;
  post_results_json: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// post_results_json helpers — merge individual platform results without
// clobbering the other platform's entry.
// ---------------------------------------------------------------------------

type LinkedInResult =
  | { posted: true; postUrn: string }
  | { posted: false; staged: true; reason: string }
  | { posted: false; staged?: never; error: string };

function mergePostResults(
  existing: Record<string, unknown> | null,
  update: { linkedin?: LinkedInResult; instagram?: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const result: Record<string, unknown> = { ...base };
  if (update.linkedin !== undefined) result.linkedin = update.linkedin;
  if (update.instagram !== undefined) result.instagram = update.instagram;
  return result;
}

// ---------------------------------------------------------------------------
// Loader return shapes
// ---------------------------------------------------------------------------

type LoaderData =
  | { state: "invalid" }
  | { state: "stale" }
  | {
      // approve-linkedin: not yet posted → show confirm
      state: "confirm";
      action: "approve-linkedin" | "approve-instagram" | "reject";
      id: string;
      token: string;
      range: string;
      liUrls: string[];
      igUrls: string[];
      liCaption: string;
      igCaption: string;
      regenCount: number;
    }
  | {
      // approve-linkedin: already posted → show LI result
      state: "li_result";
      linkedin: LinkedInResult;
      liUrls: string[];
      liCaption: string;
    }
  | {
      // approve-instagram: already approved → show IG assets
      state: "ig_assets";
      igUrls: string[];
      igCaption: string;
    };

// ---------------------------------------------------------------------------
// Action return shapes
// ---------------------------------------------------------------------------

type ActionData =
  | { state: "invalid" }
  | { state: "li_posted"; linkedin: { posted: true; postUrn: string } }
  | { state: "li_not_connected"; liUrls: string[]; liCaption: string }
  | { state: "li_failed"; linkedin: { posted: false; error: string }; liUrls: string[]; liCaption: string }
  | { state: "ig_assets"; igUrls: string[]; igCaption: string }
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
    (o.li_posted_at === null || typeof o.li_posted_at === "string") &&
    (o.ig_approved_at === null || typeof o.ig_approved_at === "string")
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
      "id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption, li_posted_at, ig_approved_at, post_results_json",
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

  // Per-platform: if already actioned for this platform, show the result page.
  if (action === "approve-linkedin" && row.li_posted_at !== null) {
    const prJson = row.post_results_json ?? {};
    const liResult = (prJson.linkedin as LinkedInResult | undefined) ?? { posted: false, error: "No result recorded" };
    let liUrls: string[];
    try {
      liUrls = await signedUrls(row.li_image_paths);
    } catch {
      liUrls = [];
    }
    return json<LoaderData>({ state: "li_result", linkedin: liResult, liUrls, liCaption: row.li_caption });
  }

  if (action === "approve-instagram" && row.ig_approved_at !== null) {
    let igUrls: string[];
    try {
      igUrls = await signedUrls(row.ig_image_paths);
    } catch {
      igUrls = [];
    }
    return json<LoaderData>({ state: "ig_assets", igUrls, igCaption: row.ig_caption });
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
      "id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption, li_posted_at, ig_approved_at, post_results_json",
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
  // approve-linkedin
  // ---------------------------------------------------------------------------
  if (payload.action === "approve-linkedin") {
    const now = new Date().toISOString();

    // ATOMIC CLAIM: set li_posted_at only if currently null + version matches.
    const { error: claimError, data: claimed } = await getSupabase()
      .from("social_digest")
      .update({ li_posted_at: now })
      .eq("id", id)
      .is("li_posted_at", null)
      .eq("regen_count", payload.version)
      .select("id");

    if (claimError) {
      return json<ActionData>({ state: "error", message: claimError.message });
    }

    if (!claimed?.length) {
      // Already claimed — return stored result without re-posting.
      const prJson = row.post_results_json ?? {};
      const stored = (prJson.linkedin as LinkedInResult | undefined) ?? { posted: false, error: "Already actioned" };
      // Return the right state based on stored result.
      if ("posted" in stored && stored.posted === true) {
        return json<ActionData>({ state: "li_posted", linkedin: stored as { posted: true; postUrn: string } });
      }
      let liUrls: string[];
      try {
        liUrls = await signedUrls(row.li_image_paths);
      } catch {
        liUrls = [];
      }
      return json<ActionData>({ state: "li_failed", linkedin: stored as { posted: false; error: string }, liUrls, liCaption: row.li_caption });
    }

    // We won the claim — attempt auto-post.
    const conn = await getValidConnection();

    if (conn === null) {
      // Not connected: reset the claim so the link still works after reconnect.
      const { error: resetErr } = await getSupabase()
        .from("social_digest")
        .update({
          li_posted_at: null,
          post_results_json: mergePostResults(row.post_results_json, {
            linkedin: { posted: false, staged: true, reason: "not connected" },
          }),
        })
        .eq("id", id);
      if (resetErr) {
        console.error("[social.review] li_posted_at reset failed (not connected)", id, resetErr.message);
      }
      let liUrls: string[];
      try {
        liUrls = await signedUrls(row.li_image_paths);
      } catch {
        liUrls = [];
      }
      return json<ActionData>({ state: "li_not_connected", liUrls, liCaption: row.li_caption });
    }

    // Connected — download slides and post.
    let linkedin: LinkedInResult;
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
      linkedin = { posted: true, postUrn };
    } catch (err) {
      // Rule 12: post failed — reset li_posted_at so the link is retryable.
      const errMsg = err instanceof Error ? err.message : "Unknown LinkedIn error";
      linkedin = { posted: false, error: errMsg };

      const { error: resetErr } = await getSupabase()
        .from("social_digest")
        .update({
          li_posted_at: null,
          post_results_json: mergePostResults(row.post_results_json, { linkedin }),
        })
        .eq("id", id);
      if (resetErr) {
        console.error("[social.review] li_posted_at reset failed (post threw)", id, resetErr.message);
      }

      let liUrls: string[];
      try {
        liUrls = await signedUrls(row.li_image_paths);
      } catch {
        liUrls = [];
      }
      return json<ActionData>({ state: "li_failed", linkedin, liUrls, liCaption: row.li_caption });
    }

    // Post succeeded — persist result (li_posted_at already set by claim).
    const { error: persistErr } = await getSupabase()
      .from("social_digest")
      .update({
        post_results_json: mergePostResults(row.post_results_json, { linkedin }),
      })
      .eq("id", id);
    if (persistErr) {
      console.error("[social.review] post_results_json persist failed (linkedin posted)", id, persistErr.message);
    }

    return json<ActionData>({ state: "li_posted", linkedin: linkedin as { posted: true; postUrn: string } });
  }

  // ---------------------------------------------------------------------------
  // approve-instagram
  // ---------------------------------------------------------------------------
  if (payload.action === "approve-instagram") {
    const now = new Date().toISOString();

    // ATOMIC CLAIM: set ig_approved_at only if currently null + version matches.
    const { error: claimError } = await getSupabase()
      .from("social_digest")
      .update({
        ig_approved_at: now,
        post_results_json: mergePostResults(row.post_results_json, { instagram: "approved (manual)" }),
      })
      .eq("id", id)
      .is("ig_approved_at", null)
      .eq("regen_count", payload.version)
      .select("id");

    if (claimError) {
      console.error("[social.review] ig_approved_at claim failed", id, claimError.message);
    }

    // Whether we won the claim or it was already set, serve the IG assets.
    let igUrls: string[];
    try {
      igUrls = await signedUrls(row.ig_image_paths);
    } catch {
      igUrls = [];
    }

    return json<ActionData>({ state: "ig_assets", igUrls, igCaption: row.ig_caption });
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
        const { linkedin } = actionData;
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
            </div>
          </div>
        );
      }

      case "li_not_connected": {
        const { liUrls, liCaption } = actionData;
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.navy }}>
                LinkedIn not connected
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 16 }}>
                LinkedIn isn&apos;t connected — reconnect, then retry the link in your email.
                In the meantime, post these slides manually:
              </p>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
              <DownloadRow urls={liUrls} prefix="li" btnBg={BRAND.teal} />
            </div>
          </div>
        );
      }

      case "li_failed": {
        const { linkedin, liUrls, liCaption } = actionData;
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
            </div>
          </div>
        );
      }

      case "ig_assets": {
        const { igUrls, igCaption } = actionData;
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.teal }}>
                Instagram approved
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 12 }}>
                Post these 4 slides manually on Instagram:
              </p>
              <ImageRow urls={igUrls} />
              <CaptionBlock label="Instagram caption" caption={igCaption} />
              <DownloadRow urls={igUrls} prefix="ig" btnBg={BRAND.navy} />
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

    case "li_result": {
      const { linkedin, liUrls, liCaption } = loaderData;
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
          </div>
        </div>
      );
    }

    case "ig_assets": {
      const { igUrls, igCaption } = loaderData;
      return (
        <div style={pageStyle}>
          <div style={cardStyle}>
            <h1 style={{ margin: "0 0 12px", fontSize: 22, color: BRAND.teal }}>
              Instagram approved
            </h1>
            <p style={{ color: BRAND.muted, marginBottom: 12 }}>
              Post these 4 slides manually on Instagram:
            </p>
            <ImageRow urls={igUrls} />
            <CaptionBlock label="Instagram caption" caption={igCaption} />
            <DownloadRow urls={igUrls} prefix="ig" btnBg={BRAND.navy} />
          </div>
        </div>
      );
    }

    case "confirm": {
      const { action: digestAction, token, range, liUrls, igUrls, liCaption, igCaption } = loaderData;

      if (digestAction === "approve-linkedin") {
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 4px", fontSize: 22, color: BRAND.navy }}>
                Approve &amp; post to LinkedIn
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 20 }}>Week of {range}</p>
              <span style={labelStyle}>LinkedIn slides</span>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
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

      if (digestAction === "approve-instagram") {
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 4px", fontSize: 22, color: BRAND.navy }}>
                Approve Instagram
              </h1>
              <p style={{ color: BRAND.muted, marginBottom: 20 }}>Week of {range}</p>
              <span style={labelStyle}>Instagram slides</span>
              <ImageRow urls={igUrls} />
              <CaptionBlock label="Instagram caption" caption={igCaption} />
              <Form method="post" style={{ marginTop: 28 }}>
                <input type="hidden" name="token" value={token} />
                <button type="submit" style={btnStyle(BRAND.teal)}>
                  Approve Instagram (get assets)
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
                Reject &amp; regenerate both
              </button>
            </Form>
          </div>
        </div>
      );
    }
  }
}
