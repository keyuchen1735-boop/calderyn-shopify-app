// app/routes/social.review.$id.tsx
//
// Public approve/reject confirmation page for weekly social digest email links.
// GET is side-effect-free (email scanners pre-fetch links); mutation only on POST.
// Authorization is the HMAC token — no Shopify authenticate.admin here.

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
// DB row shape — only the fields we actually read. Do not leak the full row.
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
}

// ---------------------------------------------------------------------------
// Loader return shapes
// ---------------------------------------------------------------------------

type LoaderData =
  | { state: "invalid" }
  | { state: "stale" }
  | { state: "already_done" }
  | {
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
    };

// ---------------------------------------------------------------------------
// Action return shapes
// ---------------------------------------------------------------------------

type LinkedInResult =
  | { posted: true; postUrn: string }
  | { posted: false; staged: true; reason: string }
  | { posted: false; staged?: never; error: string };

type ActionData =
  | { state: "invalid" }
  | {
      state: "approved";
      linkedin: LinkedInResult;
      liUrls: string[];
      igUrls: string[];
      liCaption: string;
      igCaption: string;
    }
  | { state: "regenerated" }
  | { state: "capped" }
  | { state: "error"; message: string };

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
    .select("id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption")
    .eq("id", id)
    .single();

  if (error || !data) {
    return json<LoaderData>({ state: "invalid" });
  }

  const r = data as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.week_range !== "string" ||
    typeof r.status !== "string" ||
    typeof r.regen_count !== "number" ||
    (r.consumed_at !== null && typeof r.consumed_at !== "string") ||
    !Array.isArray(r.li_image_paths) ||
    !Array.isArray(r.ig_image_paths) ||
    typeof r.li_caption !== "string" ||
    typeof r.ig_caption !== "string"
  ) {
    return json<LoaderData>({ state: "invalid" });
  }
  const row = r as unknown as DigestRow;

  // Version mismatch — a newer regeneration has superseded this token.
  if (payload.version !== row.regen_count) {
    return json<LoaderData>({ state: "stale" });
  }

  // Already consumed — was this an approve? Show a distinct message.
  if (row.consumed_at != null) {
    return json<LoaderData>({ state: "already_done" });
  }

  // Wrong lifecycle state — shouldn't happen in normal flow, but guard it.
  if (row.status !== "pending") {
    return json<LoaderData>({ state: "stale" });
  }

  let liUrls: string[];
  let igUrls: string[];
  try {
    liUrls = await signedUrls(row.li_image_paths);
    igUrls = await signedUrls(row.ig_image_paths);
  } catch {
    return json<LoaderData>({ state: "invalid" });
  }

  return json<LoaderData>({
    state: "confirm",
    action: payload.action,
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

  // Re-check the row state — guard against replays.
  const { data, error } = await getSupabase()
    .from("social_digest")
    .select("id, week_range, status, regen_count, consumed_at, li_image_paths, ig_image_paths, li_caption, ig_caption")
    .eq("id", id)
    .single();

  if (error || !data) {
    return json<ActionData>({ state: "invalid" });
  }

  const r = data as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.week_range !== "string" ||
    typeof r.status !== "string" ||
    typeof r.regen_count !== "number" ||
    (r.consumed_at !== null && typeof r.consumed_at !== "string") ||
    !Array.isArray(r.li_image_paths) ||
    !Array.isArray(r.ig_image_paths) ||
    typeof r.li_caption !== "string" ||
    typeof r.ig_caption !== "string"
  ) {
    return json<ActionData>({ state: "invalid" });
  }
  const row = r as unknown as DigestRow;

  if (
    payload.version !== row.regen_count ||
    row.consumed_at != null ||
    row.status !== "pending"
  ) {
    return json<ActionData>({ state: "invalid" });
  }

  if (payload.action === "approve") {
    const now = new Date().toISOString();

    // Step 1: Atomic claim — only the winner proceeds.
    const { error: claimError, data: claimed } = await getSupabase()
      .from("social_digest")
      .update({
        consumed_at: now,
        status: "posted",
        acted_at: now,
      })
      .eq("id", id)
      .eq("status", "pending")
      .is("consumed_at", null)
      .eq("regen_count", payload.version)
      .select("id");

    if (claimError) {
      return json<ActionData>({ state: "error", message: claimError.message });
    }
    if (!claimed?.length) {
      // Lost the race — someone else already consumed this drop.
      return json<ActionData>({ state: "invalid" });
    }

    // Step 2: Attempt LinkedIn auto-post.
    let linkedin: LinkedInResult;
    const conn = await getValidConnection();
    if (conn === null) {
      linkedin = { posted: false, staged: true, reason: "not connected" };
    } else {
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
        // Rule 12: record failure, never claim success.
        linkedin = {
          posted: false,
          error: err instanceof Error ? err.message : "Unknown LinkedIn error",
        };
      }
    }

    // Step 3: Persist the LinkedIn outcome.
    await getSupabase()
      .from("social_digest")
      .update({
        post_results_json: { linkedin, instagram: "manual" },
      })
      .eq("id", id)
      .select("id");

    // Step 4: Mint signed URLs for the response.
    let liUrls: string[];
    let igUrls: string[];
    try {
      liUrls = await signedUrls(row.li_image_paths);
      igUrls = await signedUrls(row.ig_image_paths);
    } catch (err) {
      return json<ActionData>({
        state: "error",
        message: err instanceof Error ? err.message : "Storage error",
      });
    }

    return json<ActionData>({
      state: "approved",
      linkedin,
      liUrls,
      igUrls,
      liCaption: row.li_caption,
      igCaption: row.ig_caption,
    });
  }

  // reject
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
// Styles (inline, no external deps)
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
      case "approved": {
        const { linkedin, liUrls, igUrls, liCaption, igCaption } = actionData;

        let liHeading: React.ReactNode;
        let liBody: React.ReactNode;

        if (linkedin.posted) {
          // Successfully posted — confirm with URN-derived link where possible.
          const postId = linkedin.postUrn.split(":").pop();
          const liLink = postId
            ? `https://www.linkedin.com/feed/update/${linkedin.postUrn}/`
            : null;
          liHeading = (
            <p style={{ color: BRAND.teal, fontWeight: 700, marginBottom: 8 }}>
              ✅ Posted to LinkedIn
              {liLink && (
                <>
                  {" — "}
                  <a href={liLink} target="_blank" rel="noreferrer" style={{ color: BRAND.teal }}>
                    view post
                  </a>
                </>
              )}
            </p>
          );
          liBody = null;
        } else if ("staged" in linkedin && linkedin.staged) {
          // Not connected — manual posting required.
          liHeading = (
            <p style={{ color: BRAND.muted, fontWeight: 600, marginBottom: 8 }}>
              LinkedIn isn&apos;t connected yet — post these manually:
            </p>
          );
          liBody = (
            <>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
              <div style={{ marginTop: 12 }}>
                {liUrls.map((u, i) => (
                  <a
                    key={`li-dl-${i}`}
                    href={u}
                    download={`linkedin-slide-${i + 1}.png`}
                    style={{ ...btnStyle(BRAND.teal), fontSize: 13, padding: "9px 18px" }}
                  >
                    LI {i + 1}
                  </a>
                ))}
              </div>
            </>
          );
        } else {
          // Auto-post failed — show error + manual download.
          const errMsg = "error" in linkedin ? linkedin.error : "Unknown error";
          liHeading = (
            <p style={{ color: BRAND.red, fontWeight: 600, marginBottom: 8 }}>
              ⚠️ LinkedIn auto-post failed: {errMsg}. Post these 4 slides + caption manually:
            </p>
          );
          liBody = (
            <>
              <ImageRow urls={liUrls} />
              <CaptionBlock label="LinkedIn caption" caption={liCaption} />
              <div style={{ marginTop: 12 }}>
                {liUrls.map((u, i) => (
                  <a
                    key={`li-dl-${i}`}
                    href={u}
                    download={`linkedin-slide-${i + 1}.png`}
                    style={{ ...btnStyle(BRAND.teal), fontSize: 13, padding: "9px 18px" }}
                  >
                    LI {i + 1}
                  </a>
                ))}
              </div>
            </>
          );
        }

        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 16px", fontSize: 22, color: BRAND.teal }}>
                Approved
              </h1>

              <span style={labelStyle}>LinkedIn</span>
              {liHeading}
              {liBody}

              <span style={{ ...labelStyle, marginTop: 24 }}>Instagram</span>
              <p style={{ color: BRAND.muted, fontSize: 14, marginBottom: 8 }}>
                Post these 4 manually on Instagram:
              </p>
              <ImageRow urls={igUrls} />
              <CaptionBlock label="Instagram caption" caption={igCaption} />
              <div style={{ marginTop: 12 }}>
                {igUrls.map((u, i) => (
                  <a
                    key={`ig-dl-${i}`}
                    href={u}
                    download={`instagram-slide-${i + 1}.png`}
                    style={{ ...btnStyle(BRAND.navy), fontSize: 13, padding: "9px 18px" }}
                  >
                    IG {i + 1}
                  </a>
                ))}
              </div>
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

    case "already_done":
      return (
        <MessageCard
          heading="Already actioned"
          body="This drop has already been actioned — check your inbox for the latest email."
        />
      );

    case "confirm": {
      const { action: digestAction, token, range, liUrls, igUrls, liCaption, igCaption } =
        loaderData;

      if (digestAction === "approve") {
        return (
          <div style={pageStyle}>
            <div style={cardStyle}>
              <h1 style={{ margin: "0 0 4px", fontSize: 22, color: BRAND.navy }}>
                Approve social post
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
                <button type="submit" style={btnStyle(BRAND.teal)}>
                  Approve &amp; post
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
                Reject &amp; regenerate
              </button>
            </Form>
          </div>
        </div>
      );
    }
  }
}
