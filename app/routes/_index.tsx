import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return null;
};

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Calderyn</h1>
      <p>Ad-and-inventory autopilot for Shopify merchants.</p>
      <p>
        Install Calderyn from the{" "}
        <a href="https://apps.shopify.com">Shopify App Store</a>, or open it
        from the Apps section of your Shopify admin.
      </p>
    </div>
  );
}
