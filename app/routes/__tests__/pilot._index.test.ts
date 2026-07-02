import { describe, it, expect, afterEach } from "vitest";
import { routeArgs } from "../../lib/__tests__/_route-test-helpers";
import { loader } from "../pilot._index";

afterEach(() => { delete process.env.PUBLIC_APP_URL; });

describe("GET /pilot", () => {
  it("returns personalized HTML", async () => {
    process.env.PUBLIC_APP_URL = "https://app.test";
    const res = await loader(routeArgs({ request: new Request("https://app.test/pilot?first_name=Jane&store_name=Acme"), params: {}, context: {} }));
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Jane");
    expect(body).toContain("Acme");
  });
});
