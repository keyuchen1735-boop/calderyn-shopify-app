import { describe, it, expect, afterEach } from "vitest";
import { routeArgs } from "../../lib/__tests__/_route-test-helpers";
import { loader } from "../pilot.api.preview";

afterEach(() => { delete process.env.PUBLIC_APP_URL; });

describe("GET /pilot/api/preview", () => {
  it("returns email HTML for the given fields", async () => {
    process.env.PUBLIC_APP_URL = "https://app.test";
    const res = await loader(routeArgs({ request: new Request("https://app.test/pilot/api/preview?first_name=Jane&store_name=Acme"), params: {}, context: {} }));
    const body = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(body).toContain("Jane");
    expect(body).toContain("https://apps.shopify.com/calderynextension");
  });
});
