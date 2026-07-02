import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { redirect } from "react-router";
import { consumeVerifyToken, markEmailVerified } from "~/lib/auth/verify.server";

export const headers: HeadersFunction = () => ({ "Referrer-Policy": "no-referrer" });

export async function loader({ request }: LoaderFunctionArgs) {
  const t = new URL(request.url).searchParams.get("t") ?? "";
  const consumed = await consumeVerifyToken(t);
  if (!consumed) return { ok: false };
  await markEmailVerified(consumed.userId);
  return redirect("/dashboard", { headers: { "Referrer-Policy": "no-referrer" } });
}

export default function VerifyRoute() {
  return (
    <main style={{ font: "16px/1.5 system-ui, sans-serif", maxWidth: "26rem", margin: "12vh auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Link expired</h1>
      <p>That verification link is invalid or has expired. <a href="/dashboard/verify-needed">Request a new one</a>.</p>
    </main>
  );
}
