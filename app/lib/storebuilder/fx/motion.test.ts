// app/lib/storebuilder/fx/motion.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import gsap from "gsap";
import { parseMotionSpec, applyMotion } from "./motion";

describe("parseMotionSpec", () => {
  it("accepts a well-formed spec and preserves its shape", () => {
    const spec = parseMotionSpec(
      JSON.stringify({
        trigger: "inview",
        targets: ".card",
        from: { y: 40, opacity: 0 },
        to: { y: 0, opacity: 1, duration: 0.8, ease: "power2.out", stagger: 0.1, repeat: 2, yoyo: true },
      }),
    );
    expect(spec).not.toBeNull();
    expect(spec?.trigger).toBe("inview");
    expect(spec?.targets).toBe(".card");
    expect(spec?.from).toEqual({ y: 40, opacity: 0 });
    expect(spec?.to).toEqual({ y: 0, opacity: 1, duration: 0.8, ease: "power2.out", stagger: 0.1, repeat: 2, yoyo: true });
  });

  it("accepts a load-trigger spec with only a `to` block", () => {
    const spec = parseMotionSpec(JSON.stringify({ to: { opacity: 1, duration: 1 } }));
    expect(spec).not.toBeNull();
    expect(spec?.to).toEqual({ opacity: 1, duration: 1 });
  });

  it("accepts the documented gsap ease names", () => {
    for (const ease of ["power2.out", "back.out(1.7)", "sine.inOut", "expo.out", "none"]) {
      expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, ease } }))).not.toBeNull();
    }
  });

  it("rejects invalid JSON", () => {
    expect(parseMotionSpec("{not json")).toBeNull();
  });

  it("rejects a non-object top level (array, string, number)", () => {
    expect(parseMotionSpec("[]")).toBeNull();
    expect(parseMotionSpec('"x"')).toBeNull();
    expect(parseMotionSpec("42")).toBeNull();
  });

  it("rejects an unknown top-level key", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1 }, loop: true }))).toBeNull();
  });

  it("rejects an unknown property inside from/to", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, color: "red" } }))).toBeNull();
  });

  it("rejects a spec that animates nothing (no from and no to)", () => {
    expect(parseMotionSpec(JSON.stringify({ trigger: "load", targets: ".x" }))).toBeNull();
  });

  it("rejects an unknown trigger", () => {
    expect(parseMotionSpec(JSON.stringify({ trigger: "hover", to: { opacity: 1 } }))).toBeNull();
  });

  it("rejects non-finite numeric props", () => {
    // JSON has no Infinity/NaN literal, so exercise the type guard with a string.
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: "1" } }))).toBeNull();
  });

  it("rejects raw JSON over the 2000-char cap", () => {
    const filler = "x".repeat(2100);
    expect(parseMotionSpec(JSON.stringify({ to: { clipPath: filler } }))).toBeNull();
  });

  it("rejects a string prop over the 120-char cap", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { filter: "b".repeat(121) } }))).toBeNull();
  });

  it("rejects a malformed ease", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, ease: "expo.out; drop" } }))).toBeNull();
  });

  it("rejects a selector containing forbidden characters", () => {
    expect(parseMotionSpec(JSON.stringify({ targets: ".a < .b", to: { opacity: 1 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ targets: "[data-x]", to: { opacity: 1 } }))).toBeNull();
    // A lone closing bracket is forbidden too, not just the opening one.
    expect(parseMotionSpec(JSON.stringify({ targets: "div]", to: { opacity: 1 } }))).toBeNull();
  });

  it("rejects a selector over the 100-char cap", () => {
    expect(parseMotionSpec(JSON.stringify({ targets: `.${"a".repeat(120)}`, to: { opacity: 1 } }))).toBeNull();
  });

  it("rejects a selector list beyond three selectors", () => {
    expect(parseMotionSpec(JSON.stringify({ targets: ".a,.b,.c", to: { opacity: 1 } }))).not.toBeNull();
    expect(parseMotionSpec(JSON.stringify({ targets: ".a,.b,.c,.d", to: { opacity: 1 } }))).toBeNull();
  });

  it("rejects repeat out of range and non-integer repeat", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, repeat: 21 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, repeat: -2 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, repeat: 1.5 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, repeat: -1 } }))).not.toBeNull();
  });

  it("rejects duration and delay and stagger out of range", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, duration: 21 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, delay: 11 } }))).toBeNull();
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, stagger: 3 } }))).toBeNull();
  });

  it("rejects a non-boolean yoyo", () => {
    expect(parseMotionSpec(JSON.stringify({ to: { opacity: 1, yoyo: "yes" } }))).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseMotionSpec("")).toBeNull();
  });
});

describe("applyMotion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("neither throws nor animates on a syntactically invalid selector, returning a callable no-op cleanup", () => {
    // "div::" passes the parse-time character screen but is invalid CSS, so a
    // real querySelectorAll throws SyntaxError. jsdom is not a dependency of
    // this repo; a minimal host stub reproduces exactly that DOM behavior.
    const spec = parseMotionSpec(JSON.stringify({ targets: "div::", to: { opacity: 1, duration: 1 } }));
    expect(spec).not.toBeNull();

    const noopTween = { kill: () => {} } as unknown as gsap.core.Tween;
    const to = vi.spyOn(gsap, "to").mockReturnValue(noopTween);
    const from = vi.spyOn(gsap, "from").mockReturnValue(noopTween);
    const fromTo = vi.spyOn(gsap, "fromTo").mockReturnValue(noopTween);
    const set = vi.spyOn(gsap, "set").mockReturnValue(noopTween);

    const host = {
      querySelectorAll: () => {
        throw new SyntaxError("'div::' is not a valid selector");
      },
    } as unknown as HTMLElement;

    let cleanup: (() => void) | undefined;
    expect(() => {
      cleanup = applyMotion(host, spec!);
    }).not.toThrow();
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup!()).not.toThrow();
    expect(to).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(fromTo).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
