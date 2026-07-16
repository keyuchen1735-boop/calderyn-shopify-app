// app/lib/storebuilder/fx/shader.test.ts
// @vitest-environment jsdom

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  shaderSourceWithinCap,
  parseShaderColors,
  hexToRgb,
  mountVisualLayer,
  SHADER_SOURCE_CAP,
} from "./shader";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function installWebGl() {
  const loseContext = vi.fn();
  const createBuffer = vi.fn<() => WebGLBuffer | null>(() => ({} as WebGLBuffer));
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7, TRIANGLES: 8,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(), createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), deleteProgram: vi.fn(),
    createBuffer, bindBuffer: vi.fn(), bufferData: vi.fn(), getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(), useProgram: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => ({ name })), uniform3fv: vi.fn(),
    uniform2f: vi.fn(), uniform1f: vi.fn(), viewport: vi.fn(), drawArrays: vi.fn(),
    getExtension: vi.fn(() => ({ loseContext })),
  } as unknown as WebGLRenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as never);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  vi.stubGlobal("devicePixelRatio", 2);
  return { gl, loseContext, createBuffer };
}

describe("mountVisualLayer", () => {
  it("ignores legacy data attributes", () => {
    const host = document.createElement("div");
    host.dataset.fxShader = "void main(){gl_FragColor=vec4(1.0);}";
    host.dataset.fxColors = "#ffffff,#ffffff,#ffffff";
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    expect(mountVisualLayer(host, { kind: "none" })).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("rejects source above the cap before WebGL creation", () => {
    const host = document.createElement("div");
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");

    expect(mountVisualLayer(host, {
      kind: "fragment_shader",
      source: "x".repeat(SHADER_SOURCE_CAP + 1),
      colors: ["#000000", "#111111", "#222222"],
    })).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("renders a capped static layer with a fixed pointer and restores its fallback on context loss", () => {
    const { gl, loseContext } = installWebGl();
    const host = document.createElement("div");
    const fallback = document.createElement("img");
    fallback.dataset.cdVisualFallback = "";
    host.append(fallback);
    document.body.append(host);
    Object.defineProperties(host, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 100 },
    });

    const cleanup = mountVisualLayer(host, {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    });
    const canvas = host.querySelector("canvas")!;

    expect(cleanup).not.toBeNull();
    expect(canvas.style.pointerEvents).toBe("none");
    expect(fallback.style.visibility).toBe("hidden");
    expect(vi.mocked(gl.shaderSource).mock.calls.some(([, source]) => String(source).includes("uniform vec2 u_pointer;"))).toBe(true);
    expect(gl.uniform2f).toHaveBeenCalledWith(expect.objectContaining({ name: "u_pointer" }), 0.5, 0.5);
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 300, 150);
    expect(gl.drawArrays).toHaveBeenCalledOnce();

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(host.querySelector("canvas")).toBeNull();
    expect(fallback.style.visibility).toBe("");
    expect(loseContext).toHaveBeenCalledOnce();
    cleanup?.();
  });

  it("keeps the fallback when WebGL cannot allocate its vertex buffer", () => {
    const { createBuffer } = installWebGl();
    createBuffer.mockReturnValue(null);
    const host = document.createElement("div");
    const fallback = document.createElement("img");
    fallback.dataset.cdVisualFallback = "";
    host.append(fallback);
    document.body.append(host);

    expect(mountVisualLayer(host, {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    })).toBeNull();
    expect(host.querySelector("canvas")).toBeNull();
    expect(fallback.style.visibility).toBe("");
  });

  it("rolls back before returning when observer setup fails", () => {
    installWebGl();
    vi.stubGlobal("ResizeObserver", class {
      observe(): void { throw new Error("observer setup failed"); }
      disconnect(): void {}
      unobserve(): void {}
    });
    const host = document.createElement("div");
    const fallback = document.createElement("img");
    fallback.dataset.cdVisualFallback = "";
    host.append(fallback);
    document.body.append(host);

    expect(mountVisualLayer(host, {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    })).toBeNull();
    expect(host.querySelector("canvas")).toBeNull();
    expect(fallback.style.visibility).toBe("");
    expect(host.style.position).toBe("");
    expect(host.style.isolation).toBe("");
  });
});

describe("shaderSourceWithinCap", () => {
  it("accepts source at or under the cap", () => {
    expect(shaderSourceWithinCap("void main() {}")).toBe(true);
    expect(shaderSourceWithinCap("x".repeat(SHADER_SOURCE_CAP))).toBe(true);
  });

  it("rejects source over the cap", () => {
    expect(shaderSourceWithinCap("x".repeat(SHADER_SOURCE_CAP + 1))).toBe(false);
  });
});

describe("hexToRgb", () => {
  it("parses a #rrggbb value into normalized floats", () => {
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
  });

  it("tolerates surrounding whitespace and mixed case", () => {
    expect(hexToRgb("  #00FF00 ")).toEqual([0, 1, 0]);
  });

  it("rejects malformed hex (shorthand, missing hash, non-hex)", () => {
    expect(hexToRgb("#fff")).toBeNull();
    expect(hexToRgb("ff0000")).toBeNull();
    expect(hexToRgb("#gggggg")).toBeNull();
    expect(hexToRgb("")).toBeNull();
  });
});

describe("parseShaderColors", () => {
  it("returns three default colors when input is absent", () => {
    const colors = parseShaderColors(undefined);
    expect(colors).toHaveLength(3);
    for (const c of colors) {
      expect(c).toHaveLength(3);
      for (const channel of c) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("overrides only the parsed entries, keeping defaults for the rest", () => {
    const defaults = parseShaderColors(undefined);
    const colors = parseShaderColors("#ff0000,#00ff00");
    expect(colors[0]).toEqual([1, 0, 0]);
    expect(colors[1]).toEqual([0, 1, 0]);
    expect(colors[2]).toEqual(defaults[2]);
  });

  it("keeps the default for a malformed entry", () => {
    const defaults = parseShaderColors(undefined);
    const colors = parseShaderColors("#ff0000,nope,#0000ff");
    expect(colors[0]).toEqual([1, 0, 0]);
    expect(colors[1]).toEqual(defaults[1]);
    expect(colors[2]).toEqual([0, 0, 1]);
  });

  it("ignores entries beyond the third", () => {
    const colors = parseShaderColors("#ff0000,#00ff00,#0000ff,#ffffff");
    expect(colors).toHaveLength(3);
    expect(colors[2]).toEqual([0, 0, 1]);
  });
});
