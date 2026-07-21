import { describe, expect, it } from "vitest";
import { createStorefrontFullStory } from "./full-story.server";

describe("recipe storefront full story", () => {
  it("keeps the established recipe lifecycle off the redesign engine", async () => {
    const story = await createStorefrontFullStory();

    expect(story.initial.bundle.source.kind).toBe("recipe");
    expect(story.published.bundle.source.kind).toBe("recipe");
    expect(story.redesignCalls).toBe(0);
  });
});
