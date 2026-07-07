import { describe, it, expect } from "vitest";
import { buildHomeDraft, buildCollectionDraft } from "../writer.server";
import { metaFromDraft } from "../render.server";
import type { StoreSettings } from "~/lib/storefront/settings.server";

const store: StoreSettings = {
  shopId: "s1", storeName: "Ember House", logoUrl: "https://l/x.png",
  palette: { primary: "#111", background: "#fff", text: "#111" },
  voiceTagline: "Small-batch soy candles from Amsterdam.",
  vibe: "classic" as StoreSettings["vibe"], typeStyle: "classic" as StoreSettings["typeStyle"], density: "standard" as StoreSettings["density"],
};
const ORIGIN = "https://ember.calderyncompany.com";

describe("home + collection meta composition", () => {
  it("home carries Organization + WebSite JSON-LD", () => {
    const m = metaFromDraft(buildHomeDraft(store, ORIGIN));
    const types = m.filter((d) => "script:ld+json" in (d as object)).map((d) => (d as Record<string, { "@type": string }>)["script:ld+json"]["@type"]);
    expect(types.sort()).toEqual(["Organization", "WebSite"]);
  });
  it("collection canonical targets the collection path", () => {
    const m = metaFromDraft(buildCollectionDraft({ handle: "soy", title: "Soy Candles" }, store, ORIGIN));
    expect(m).toContainEqual({ tagName: "link", rel: "canonical", href: `${ORIGIN}/storefront/collections/soy` });
  });
});
