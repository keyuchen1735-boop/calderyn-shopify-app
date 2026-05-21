import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Calderyn</h1>
      <p>Ad-and-inventory autopilot for Shopify merchants.</p>
      {showForm && (
        <Form method="post" action="/auth/login">
          <label>
            Shop domain{" "}
            <input
              type="text"
              name="shop"
              placeholder="example.myshopify.com"
            />
          </label>
          <button type="submit">Log in</button>
        </Form>
      )}
    </div>
  );
}
