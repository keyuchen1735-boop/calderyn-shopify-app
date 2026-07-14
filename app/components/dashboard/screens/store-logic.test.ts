// Pure composer-staging + send-gating rules for the Store studio chat rail. Kept
// out of Store.tsx so the non-image / oversize / over-cap filtering is testable
// without object URLs or React state.
import { describe, it, expect } from "vitest";
import {
  buildSteps,
  canSendComposer,
  MAX_ATTACHMENT_BYTES,
  MAX_STAGED_ATTACHMENTS,
  parseBuildEvent,
  planStagedAttachments,
} from "./store-logic";

describe("parseBuildEvent", () => {
  it("parses stage lines and the terminal done line with its receipt", () => {
    expect(parseBuildEvent('{"stage":"brand"}')).toEqual({ stage: "brand" });
    expect(parseBuildEvent('{"stage":"checking"}')).toEqual({ stage: "checking" });
    const done = parseBuildEvent('{"stage":"done","receipt":{"runId":"r1","status":"draft"}}');
    expect(done).toEqual({ stage: "done", receipt: { runId: "r1", status: "draft" } });
  });
  it("parses the in-band error line", () => {
    expect(parseBuildEvent('{"stage":"error","message":"boom"}')).toEqual({ stage: "error", message: "boom" });
  });
  it("returns null for junk, unknown stages, and a done line missing its receipt", () => {
    expect(parseBuildEvent("not json")).toBeNull();
    expect(parseBuildEvent('{"stage":"reticulating"}')).toBeNull();
    expect(parseBuildEvent('{"stage":"done"}')).toBeNull();
  });
});

describe("buildSteps", () => {
  it("renders the five runtime-1 install stages without mixing in legacy generator copy", () => {
    const routing = buildSteps({ kind: "running", stage: "routing" });
    expect(routing).toHaveLength(5);
    expect(routing.map((row) => row.dot)).toEqual(["run", "wait", "wait", "wait", "wait"]);
    expect(routing[0].title).toMatch(/match|rout|recommend/i);
    const proofing = buildSteps({ kind: "running", stage: "proofing" });
    expect(proofing.map((row) => row.dot)).toEqual(["done", "done", "done", "done", "run"]);
    expect(proofing.map((row) => row.title).join(" ")).not.toMatch(/brand kit/i);
  });

  it("renders the three real stages with run/done/wait dots as the build advances", () => {
    const atBrand = buildSteps({ kind: "running", stage: "brand" });
    expect(atBrand.map((r) => r.dot)).toEqual(["run", "wait", "wait"]);
    const atDesign = buildSteps({ kind: "running", stage: "designing" });
    expect(atDesign.map((r) => r.dot)).toEqual(["done", "run", "wait"]);
    const atCheck = buildSteps({ kind: "running", stage: "checking" });
    expect(atCheck.map((r) => r.dot)).toEqual(["done", "done", "run"]);
    // the verification step is named for what it really does
    expect(atCheck[2].title).toMatch(/verify|check/i);
  });
  it("falls back to the single legacy row when no stage is known (non-streaming path)", () => {
    const rows = buildSteps({ kind: "running" });
    expect(rows).toHaveLength(1);
    expect(rows[0].dot).toBe("run");
  });
  it("keeps the existing single-row semantics for done and failed phases", () => {
    expect(buildSteps({ kind: "failed", message: "x" })).toHaveLength(1);
    expect(buildSteps({ kind: "done", status: "draft" })).toHaveLength(1);
  });
});

// Fabricate a File with a controlled reported size so tests never allocate
// multi-MB buffers just to cross the byte cap.
function imageOfSize(name: string, size: number, type = "image/png"): File {
  const f = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("planStagedAttachments", () => {
  it("stages plain in-size images and reports nothing rejected", () => {
    const plan = planStagedAttachments([imageOfSize("a.png", 100), imageOfSize("b.png", 200)], 0);
    expect(plan.accepted.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.oversize).toHaveLength(0);
    expect(plan.overflow).toBe(0);
  });

  it("separates non-image files into skipped", () => {
    const pdf = new File([new Uint8Array(1)], "notes.pdf", { type: "application/pdf" });
    const plan = planStagedAttachments([imageOfSize("a.png", 100), pdf], 0);
    expect(plan.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(plan.skipped.map((f) => f.name)).toEqual(["notes.pdf"]);
  });

  it("skips image types outside the server allowlist (image/* is not enough)", () => {
    // HEIC/SVG pass an image/* check but the server 422s them — they must be
    // rejected at staging, before the chips are cleared by a doomed send.
    const plan = planStagedAttachments(
      [
        imageOfSize("photo.heic", 100, "image/heic"),
        imageOfSize("logo.svg", 100, "image/svg+xml"),
        imageOfSize("ok.webp", 100, "image/webp"),
        imageOfSize("ok.gif", 100, "image/gif"),
        imageOfSize("ok.jpg", 100, "image/jpeg"),
      ],
      0,
    );
    expect(plan.accepted.map((f) => f.name)).toEqual(["ok.webp", "ok.gif", "ok.jpg"]);
    expect(plan.skipped.map((f) => f.name)).toEqual(["photo.heic", "logo.svg"]);
  });

  it("rejects images over the byte cap into oversize", () => {
    const plan = planStagedAttachments(
      [imageOfSize("ok.png", MAX_ATTACHMENT_BYTES), imageOfSize("big.png", MAX_ATTACHMENT_BYTES + 1)],
      0,
    );
    expect(plan.accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(plan.oversize.map((f) => f.name)).toEqual(["big.png"]);
  });

  it("keeps only the first images that fit under the 4-image cap and counts the overflow", () => {
    const files = [1, 2, 3, 4, 5].map((n) => imageOfSize(`${n}.png`, 100));
    const plan = planStagedAttachments(files, 0);
    expect(plan.accepted).toHaveLength(MAX_STAGED_ATTACHMENTS);
    expect(plan.accepted.map((f) => f.name)).toEqual(["1.png", "2.png", "3.png", "4.png"]);
    expect(plan.overflow).toBe(1);
  });

  it("accounts for images already staged when computing remaining slots", () => {
    const plan = planStagedAttachments([imageOfSize("a.png", 100), imageOfSize("b.png", 100)], 3);
    expect(plan.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(plan.overflow).toBe(1);
  });

  it("accepts nothing (all overflow) when the cap is already full", () => {
    const plan = planStagedAttachments([imageOfSize("a.png", 100)], MAX_STAGED_ATTACHMENTS);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.overflow).toBe(1);
  });
});

describe("canSendComposer", () => {
  it("enables send with some text and no attachments", () => {
    expect(canSendComposer({ prompt: "hi", attachmentCount: 0, busy: false, attaching: false })).toBe(true);
  });

  it("enables send with attachments and no text", () => {
    expect(canSendComposer({ prompt: "   ", attachmentCount: 1, busy: false, attaching: false })).toBe(true);
  });

  it("disables send when the composer is empty", () => {
    expect(canSendComposer({ prompt: "  ", attachmentCount: 0, busy: false, attaching: false })).toBe(false);
  });

  it("disables send while busy or attaching, even with content", () => {
    expect(canSendComposer({ prompt: "hi", attachmentCount: 2, busy: true, attaching: false })).toBe(false);
    expect(canSendComposer({ prompt: "hi", attachmentCount: 2, busy: false, attaching: true })).toBe(false);
  });
});
