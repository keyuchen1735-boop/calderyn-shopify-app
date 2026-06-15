import { describe, it, expect } from "vitest";
import { isAuthorizedCron } from "../cron-auth.server";

describe("isAuthorizedCron", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedCron(`Bearer s3cret`, "s3cret")).toBe(true);
  });
  it("rejects a wrong secret", () => {
    expect(isAuthorizedCron(`Bearer nope`, "s3cret")).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(isAuthorizedCron(null, "s3cret")).toBe(false);
  });
  it("rejects when the configured secret is empty", () => {
    expect(isAuthorizedCron(`Bearer `, "")).toBe(false);
  });
  it("rejects a length-mismatched header without throwing", () => {
    expect(isAuthorizedCron(`Bearer short`, "a-much-longer-secret")).toBe(false);
  });
});

import { isAuthorizedBearer } from "../cron-auth.server";

describe("isAuthorizedBearer", () => {
  it("is false when the secret is unset (fail closed)", () => {
    expect(isAuthorizedBearer("Bearer x", undefined)).toBe(false);
  });
  it("is false on a missing or wrong header", () => {
    expect(isAuthorizedBearer(null, "s3cret")).toBe(false);
    expect(isAuthorizedBearer("Bearer nope", "s3cret")).toBe(false);
  });
  it("is true on an exact match", () => {
    expect(isAuthorizedBearer("Bearer s3cret", "s3cret")).toBe(true);
  });
});
