// app/lib/storebuilder/fx/shader.ts
// Protected WebGL host. Source and palette arrive through a validated typed spec;
// DOM attributes identify only the platform-owned visual host and fallback.

import type { VisualLayerSpec } from "../../storefront-bundle/types";

export type RGB = [number, number, number];

export const SHADER_SOURCE_CAP = 4000;

// Stable defaults keep the palette parser total for malformed persisted input.
const DEFAULT_COLORS: [RGB, RGB, RGB] = [
  [0.05, 0.05, 0.08],
  [0.2, 0.1, 0.4],
  [0.9, 0.4, 0.6],
];

const VERTEX_SOURCE = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Fixed prelude prepended to the validated fragment source. The fragment defines
// void main() and may read these uniforms.
const FRAGMENT_PRELUDE = `precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;
`;

const DPR_CAP = 1.5;

export function shaderSourceWithinCap(source: string): boolean {
  return source.length <= SHADER_SOURCE_CAP;
}

export function isVisualLayerSpec(value: unknown): value is VisualLayerSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const spec = value as Record<string, unknown>;
  if (spec.kind === "none") return Object.keys(spec).length === 1;
  return spec.kind === "fragment_shader" && Object.keys(spec).length === 3 &&
    typeof spec.source === "string" && spec.source.length > 0 && shaderSourceWithinCap(spec.source) &&
    Array.isArray(spec.colors) && spec.colors.length === 3 &&
    spec.colors.every((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
}

export function hexToRgb(hex: string): RGB | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

// Parses up to three "#rrggbb" values, defensively: an absent, short, or malformed
// entry keeps its default so the three uniforms are always valid vec3s.
export function parseShaderColors(raw: string | undefined): [RGB, RGB, RGB] {
  const out: [RGB, RGB, RGB] = [
    [...DEFAULT_COLORS[0]],
    [...DEFAULT_COLORS[1]],
    [...DEFAULT_COLORS[2]],
  ];
  if (!raw) return out;
  raw.split(",").slice(0, 3).forEach((part, i) => {
    const rgb = hexToRgb(part);
    if (rgb) out[i] = rgb;
  });
  return out;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  try {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  } catch (error) {
    gl.deleteShader(shader);
    throw error;
  }
}

function buildProgram(gl: WebGLRenderingContext, fragmentSource: string): WebGLProgram | null {
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_PRELUDE + fragmentSource);
    if (!vertex || !fragment) return null;
    program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
    gl.deleteProgram(program);
    program = null;
    return null;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function loseContext(gl: WebGLRenderingContext): void {
  const ext = gl.getExtension("WEBGL_lose_context");
  if (ext) ext.loseContext();
}

export function mountVisualLayer(host: HTMLElement, spec: VisualLayerSpec): (() => void) | null {
  if (typeof document === "undefined") return null;
  if (!isVisualLayerSpec(spec) || spec.kind !== "fragment_shader") return null;

  let canvas: HTMLCanvasElement | null = null;
  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  let onContextLost: ((event: Event) => void) | null = null;
  let raf = 0;
  let running = false;
  let disposed = false;
  const prevPosition = host.style.position;
  const prevIsolation = host.style.isolation;
  const fallback = host.querySelector<HTMLElement>("[data-cd-visual-fallback]");
  const prevFallbackVisibility = fallback?.style.visibility;
  const release = (reportError: boolean): void => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    const attempt = (operation: () => void) => {
      try { operation(); } catch (error) { errors.push(error); }
    };
    running = false;
    if (raf) attempt(() => cancelAnimationFrame(raf));
    raf = 0;
    if (resizeObserver) attempt(() => resizeObserver?.disconnect());
    if (intersectionObserver) attempt(() => intersectionObserver?.disconnect());
    if (canvas && onContextLost) attempt(() => canvas?.removeEventListener("webglcontextlost", onContextLost!));
    if (canvas) attempt(() => canvas?.remove());
    attempt(() => { host.style.position = prevPosition; });
    attempt(() => { host.style.isolation = prevIsolation; });
    if (fallback) attempt(() => { fallback.style.visibility = prevFallbackVisibility ?? ""; });
    if (gl && buffer) attempt(() => gl?.deleteBuffer(buffer!));
    if (gl && program) attempt(() => gl?.deleteProgram(program!));
    if (gl) attempt(() => loseContext(gl!));
    if (reportError && errors.length > 0) throw errors[0];
  };
  const cleanup = () => release(true);
  onContextLost = (event: Event) => {
    event.preventDefault();
    cleanup();
  };

  try {
    canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: true });
    if (!gl) return null;
    program = buildProgram(gl, spec.source);
    if (!program) {
      release(false);
      return null;
    }

    const colors = parseShaderColors(spec.colors.join(","));
    buffer = gl.createBuffer();
    if (!buffer) {
      release(false);
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL vertex upload failed");
    const aPosition = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.useProgram(program);
    const uTime = gl.getUniformLocation(program, "u_time");
    const uResolution = gl.getUniformLocation(program, "u_resolution");
    const uPointer = gl.getUniformLocation(program, "u_pointer");
    if (uPointer) gl.uniform2f(uPointer, 0.5, 0.5);
    gl.uniform3fv(gl.getUniformLocation(program, "u_color1"), colors[0]);
    gl.uniform3fv(gl.getUniformLocation(program, "u_color2"), colors[1]);
    gl.uniform3fv(gl.getUniformLocation(program, "u_color3"), colors[2]);

    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const w = Math.max(1, Math.round(host.clientWidth * dpr));
      const h = Math.max(1, Math.round(host.clientHeight * dpr));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas!.width = w;
      canvas!.height = h;
      gl!.viewport(0, 0, w, h);
      if (uResolution) gl!.uniform2f(uResolution, w, h);
    };
    const start = performance.now();
    const renderFrame = (seconds: number) => {
      if (uTime) gl!.uniform1f(uTime, seconds);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      if (gl!.getError() !== gl!.NO_ERROR) throw new Error("WebGL draw failed");
    };
    const tick = () => {
      try {
        renderFrame((performance.now() - start) / 1000);
        raf = requestAnimationFrame(tick);
      } catch {
        release(false);
      }
    };
    const startLoop = () => {
      if (running || disposed) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };
    const stopLoop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const reduce = typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    resize();
    renderFrame(0);
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    // Isolation keeps the negative layer inside this host instead of placing it
    // beneath the host background or an ancestor.
    canvas.style.zIndex = "-1";
    canvas.style.pointerEvents = "none";
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.style.isolation = "isolate";
    host.insertBefore(canvas, host.firstChild);
    if (fallback) fallback.style.visibility = "hidden";
    canvas.addEventListener("webglcontextlost", onContextLost);
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(() => {
        try {
          resize();
          if (reduce) renderFrame(0);
        } catch {
          release(false);
        }
      });
      resizeObserver.observe(host);
    }
    if (!reduce && typeof IntersectionObserver === "function") {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) startLoop();
          else stopLoop();
        }
      });
      intersectionObserver.observe(host);
    }
    if (!reduce && !intersectionObserver) {
      // No IntersectionObserver to gate on: run immediately.
      startLoop();
    }
  } catch {
    release(false);
    return null;
  }

  return cleanup;
}
