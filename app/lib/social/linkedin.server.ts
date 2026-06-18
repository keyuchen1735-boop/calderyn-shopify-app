// LinkedIn API client — OAuth helpers + member multi-image post (carousel).
//
// All functions are pure w.r.t. storage and env: they take explicit params,
// read nothing from process.env, and touch no DB. The caller owns persistence.
//
// Network errors surface as thrown Errors that include the HTTP status and a
// snippet of the response body — never swallowed (rule 12: fail visibly).

// LinkedIn versions follow YYYYMM and are supported ~12 months. Tunable knob:
// if a call returns a "version" error, bump this to a current published month.
const LINKEDIN_VERSION = "202605";

const AUTH_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const IMAGES_ENDPOINT = "https://api.linkedin.com/rest/images";
const POSTS_ENDPOINT = "https://api.linkedin.com/rest/posts";

const DEFAULT_SCOPE = "openid profile w_member_social";

export interface LinkedInTokens {
  accessToken: string;
  expiresInSec: number;
  refreshToken?: string;
  refreshExpiresInSec?: number;
  scope?: string;
}

// ---------------------------------------------------------------------------
// 1. OAuth authorize URL
// ---------------------------------------------------------------------------

export function getAuthorizeUrl(o: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    state: o.state,
    scope: o.scope ?? DEFAULT_SCOPE,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Shared: throw on non-2xx with status + body snippet
// ---------------------------------------------------------------------------

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const snippet = await response.text().catch(() => "");
    throw new Error(
      `LinkedIn ${context} failed: HTTP ${response.status} — ${snippet.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared: POST form-urlencoded to the token endpoint
// ---------------------------------------------------------------------------

async function postTokenForm(body: Record<string, string>): Promise<LinkedInTokens> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  await assertOk(response, "token");

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
  };

  const tokens: LinkedInTokens = {
    accessToken: data.access_token,
    expiresInSec: data.expires_in,
  };
  if (data.refresh_token !== undefined) tokens.refreshToken = data.refresh_token;
  if (data.refresh_token_expires_in !== undefined)
    tokens.refreshExpiresInSec = data.refresh_token_expires_in;
  if (data.scope !== undefined) tokens.scope = data.scope;

  return tokens;
}

// ---------------------------------------------------------------------------
// 2. Exchange auth code for tokens
// ---------------------------------------------------------------------------

export async function exchangeCode(o: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinkedInTokens> {
  return postTokenForm({
    grant_type: "authorization_code",
    code: o.code,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  });
}

// ---------------------------------------------------------------------------
// 3. Refresh access token
// ---------------------------------------------------------------------------

export async function refreshAccessToken(o: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinkedInTokens> {
  return postTokenForm({
    grant_type: "refresh_token",
    refresh_token: o.refreshToken,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  });
}

// ---------------------------------------------------------------------------
// 4. Resolve the member URN via OpenID userinfo
// ---------------------------------------------------------------------------

export async function fetchMemberUrn(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await assertOk(response, "userinfo");

  const data = (await response.json()) as { sub: string };
  return `urn:li:person:${data.sub}`;
}

// ---------------------------------------------------------------------------
// 5. Post a multi-image member post (carousel)
// ---------------------------------------------------------------------------

const LINKEDIN_HEADERS = {
  "LinkedIn-Version": LINKEDIN_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
} as const;

interface InitUploadResult {
  uploadUrl: string;
  imageUrn: string;
}

async function initializeImageUpload(
  accessToken: string,
  authorUrn: string,
): Promise<InitUploadResult> {
  const response = await fetch(`${IMAGES_ENDPOINT}?action=initializeUpload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...LINKEDIN_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  await assertOk(response, "images/initializeUpload");

  const data = (await response.json()) as { value: { uploadUrl: string; image: string } };
  return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
}

async function uploadImageBytes(accessToken: string, uploadUrl: string, bytes: Buffer): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: new Uint8Array(bytes),
  });
  await assertOk(response, "image upload PUT");
}

export async function postMemberMultiImage(o: {
  accessToken: string;
  authorUrn: string;
  commentary: string;
  images: { bytes: Buffer; altText: string }[];
}): Promise<{ postUrn: string }> {
  if (o.images.length < 2 || o.images.length > 20) {
    throw new Error(
      `LinkedIn multiImage requires between 2 and 20 images; got ${o.images.length}`,
    );
  }

  // Upload each image sequentially (keeps order deterministic for carousel)
  const uploadedImages: { id: string; altText: string }[] = [];
  for (const img of o.images) {
    const { uploadUrl, imageUrn } = await initializeImageUpload(o.accessToken, o.authorUrn);
    await uploadImageBytes(o.accessToken, uploadUrl, img.bytes);
    uploadedImages.push({ id: imageUrn, altText: img.altText });
  }

  // Create the post
  const postBody = {
    author: o.authorUrn,
    commentary: o.commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      multiImage: {
        images: uploadedImages,
      },
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  const response = await fetch(POSTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${o.accessToken}`,
      ...LINKEDIN_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(postBody),
  });
  await assertOk(response, "posts");

  const postUrn =
    response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id");
  if (!postUrn) {
    throw new Error(
      "LinkedIn posts response missing x-restli-id / x-linkedin-id header (status " +
        response.status +
        ")",
    );
  }

  return { postUrn };
}
