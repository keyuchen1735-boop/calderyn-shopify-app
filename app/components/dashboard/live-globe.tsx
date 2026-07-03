// app/components/dashboard/live-globe.tsx
// Interactive WebGL globe for the Analytics Live subtab, rendered with the
// `cobe` library (dependency tradeoff: ~10 kB raw / ~5 kB gz, zero runtime
// deps, MIT, actively maintained; loaded as a lazy chunk so it never rides
// the main bundle or SSR graph). Markers come exclusively from the live
// snapshot's by-location session counts, mapped through a small
// country-centroid table — no synthetic activity. Client-only: cobe is loaded
// dynamically inside an effect, so this module imports cleanly under Node/SSR
// (the server renders an empty canvas). Drag to spin via pointer events;
// gentle auto-rotation otherwise, disabled when the user prefers reduced
// motion. If WebGL/the chunk is unavailable, an honest fallback note replaces
// the canvas instead of a permanently blank card.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { COBEOptions, Globe, Marker } from "cobe";

export interface LiveGlobeLocation {
  country: string;
  sessions: number;
}

// Approximate country centroids ([lat, lng]) keyed by ISO 3166-1 alpha-2 code
// — the format the live snapshot carries (geo IP header). Covers the common
// commerce countries; anything else (including the "Other"/"Unknown" buckets)
// simply doesn't get a marker.
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  US: [39.8, -98.6],
  CA: [56.1, -106.3],
  MX: [23.6, -102.6],
  BR: [-14.2, -51.9],
  AR: [-38.4, -63.6],
  CL: [-35.7, -71.5],
  CO: [4.6, -74.1],
  GB: [54.0, -2.9],
  IE: [53.4, -8.2],
  FR: [46.6, 2.5],
  DE: [51.2, 10.4],
  NL: [52.1, 5.3],
  BE: [50.6, 4.7],
  CH: [46.8, 8.2],
  AT: [47.6, 14.1],
  ES: [40.2, -3.6],
  PT: [39.6, -8.0],
  IT: [42.8, 12.8],
  SE: [62.2, 17.6],
  NO: [64.5, 11.0],
  DK: [56.0, 9.5],
  FI: [64.9, 26.0],
  PL: [52.1, 19.4],
  CZ: [49.8, 15.3],
  GR: [39.0, 22.0],
  RO: [45.9, 24.9],
  TR: [39.0, 35.2],
  IL: [31.4, 35.0],
  AE: [23.9, 54.3],
  SA: [24.0, 45.0],
  ZA: [-28.8, 24.7],
  NG: [9.1, 8.7],
  EG: [26.7, 29.8],
  KE: [0.5, 37.9],
  IN: [21.0, 78.0],
  CN: [35.0, 103.0],
  HK: [22.3, 114.2],
  SG: [1.35, 103.8],
  MY: [4.0, 102.0],
  TH: [15.0, 101.0],
  VN: [16.0, 107.8],
  PH: [12.9, 121.8],
  ID: [-2.5, 118.0],
  JP: [36.2, 138.3],
  KR: [36.4, 127.9],
  TW: [23.7, 121.0],
  AU: [-25.3, 133.8],
  NZ: [-41.8, 172.8],
};

// Fallback for data sources that carry full country names instead of codes.
const COUNTRY_ALIASES: Record<string, string> = {
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  "UNITED KINGDOM": "GB",
  CANADA: "CA",
  AUSTRALIA: "AU",
  GERMANY: "DE",
  FRANCE: "FR",
  SPAIN: "ES",
  ITALY: "IT",
  NETHERLANDS: "NL",
  BRAZIL: "BR",
  MEXICO: "MX",
  INDIA: "IN",
  JAPAN: "JP",
  "SOUTH KOREA": "KR",
  "NEW ZEALAND": "NZ",
  SINGAPORE: "SG",
  IRELAND: "IE",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
};

function centroidFor(country: string): [number, number] | null {
  const key = country.trim().toUpperCase();
  const code = key.length === 2 ? key : COUNTRY_ALIASES[key];
  if (!code) return null;
  const centroid: [number, number] | undefined = COUNTRY_CENTROIDS[code];
  return centroid ?? null;
}

/** Map real by-location session counts to globe markers; size follows each
 *  country's share of the (mappable) sessions. Unknown countries are skipped,
 *  so an empty result is a valid, honest state. */
export function countryMarkers(locations: readonly LiveGlobeLocation[]): Marker[] {
  const known: Array<{ location: [number, number]; sessions: number }> = [];
  for (const l of locations) {
    if (l.sessions <= 0) continue;
    const location = centroidFor(l.country);
    if (location) known.push({ location, sessions: l.sessions });
  }
  const total = known.reduce((n, k) => n + k.sessions, 0);
  if (total === 0) return [];
  return known.map((k) => ({
    location: k.location,
    size: Math.min(0.14, 0.04 + 0.1 * (k.sessions / total)),
  }));
}

type ThemeOptions = Pick<
  COBEOptions,
  "dark" | "mapBrightness" | "baseColor" | "markerColor" | "glowColor"
>;

function themeOptions(dark: boolean): ThemeOptions {
  return dark
    ? {
        dark: 1,
        mapBrightness: 9,
        baseColor: [0.5, 0.62, 1],
        markerColor: [1, 1, 1],
        glowColor: [0.6, 0.7, 1],
      }
    : {
        dark: 0,
        mapBrightness: 7,
        baseColor: [0.35, 0.5, 0.95],
        markerColor: [0.18, 0.45, 0.95],
        glowColor: [0.94, 0.95, 0.97],
      };
}

interface SpinState {
  phi: number;
  theta: number;
  dragging: boolean;
  pointerX: number;
  pointerY: number;
  /** Pause auto-rotation until this timestamp after a drag. */
  holdUntil: number;
  lastFrame: number;
  reducedMotion: boolean;
  dirty: boolean;
  size: number;
}

export default function LiveGlobe({
  locations,
  dark = false,
}: {
  locations: readonly LiveGlobeLocation[];
  dark?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const globeRef = useRef<Globe | null>(null);
  const markersRef = useRef<Marker[]>(countryMarkers(locations));
  const darkRef = useRef(dark);
  const [failed, setFailed] = useState(false);
  const spinRef = useRef<SpinState>({
    phi: 4.4,
    theta: 0.28,
    dragging: false,
    pointerX: 0,
    pointerY: 0,
    holdUntil: 0,
    lastFrame: 0,
    reducedMotion: false,
    dirty: true,
    size: 0,
  });

  // Markers follow the polled snapshot; a repaint happens on the next frame.
  useEffect(() => {
    markersRef.current = countryMarkers(locations);
    globeRef.current?.update({ markers: markersRef.current });
  }, [locations]);

  // Theme flips restyle the existing globe in place — no re-create.
  useEffect(() => {
    darkRef.current = dark;
    globeRef.current?.update(themeOptions(dark));
  }, [dark]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const spin = spinRef.current;
    let disposed = false;
    let raf = 0;

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    spin.reducedMotion = media.matches;
    const onMediaChange = () => {
      spin.reducedMotion = media.matches;
    };
    media.addEventListener("change", onMediaChange);

    // cobe renders on create and on every update() call, so we drive the
    // frames: auto-rotation marks the state dirty each frame; drags and
    // resizes mark it dirty out of band. Nothing dirty → no GPU work.
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      const globe = globeRef.current;
      if (!globe) return;
      const dt = Math.min(100, t - (spin.lastFrame || t));
      spin.lastFrame = t;
      if (!spin.reducedMotion && !spin.dragging && Date.now() > spin.holdUntil) {
        spin.phi += dt * 0.00012;
        spin.dirty = true;
      }
      if (spin.dirty) {
        spin.dirty = false;
        globe.update({ phi: spin.phi, theta: spin.theta });
      }
    };

    const create = async (size: number) => {
      if (disposed || globeRef.current || size <= 0) return;
      try {
        // Dynamic import keeps the WebGL bundle out of SSR and the main chunk.
        const { default: createGlobe } = await import("cobe");
        if (disposed || globeRef.current) return;
        spin.size = size;
        globeRef.current = createGlobe(canvas, {
          devicePixelRatio: Math.min(2, window.devicePixelRatio || 1),
          width: size,
          height: size,
          phi: spin.phi,
          theta: spin.theta,
          diffuse: 1.3,
          mapSamples: 16000,
          opacity: 1,
          markers: markersRef.current,
          ...themeOptions(darkRef.current),
        });
        canvas.style.opacity = "1";
        raf = requestAnimationFrame(frame);
      } catch (err) {
        // WebGL unavailable (remote desktop, GPU policy) or the lazy chunk
        // failed to load after a deploy — fail visibly, not as a blank card.
        if (!disposed) setFailed(true);
        console.warn("[live-globe] globe unavailable:", err);
      }
    };

    const observer = new ResizeObserver(() => {
      const size = Math.floor(wrap.clientWidth);
      if (!globeRef.current) {
        void create(size);
        return;
      }
      if (size > 0 && Math.abs(size - spin.size) > 4) {
        spin.size = size;
        globeRef.current.update({ width: size, height: size });
        spin.dirty = true;
      }
    });
    observer.observe(wrap);
    void create(Math.floor(wrap.clientWidth));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      media.removeEventListener("change", onMediaChange);
      globeRef.current?.destroy();
      globeRef.current = null;
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const spin = spinRef.current;
    spin.dragging = true;
    spin.pointerX = e.clientX;
    spin.pointerY = e.clientY;
    e.currentTarget.style.cursor = "grabbing";
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort; dragging still works within the canvas
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const spin = spinRef.current;
    if (!spin.dragging) return;
    spin.phi += (e.clientX - spin.pointerX) * 0.005;
    spin.theta = Math.max(-0.5, Math.min(0.9, spin.theta + (e.clientY - spin.pointerY) * 0.003));
    spin.pointerX = e.clientX;
    spin.pointerY = e.clientY;
    spin.holdUntil = Date.now() + 3000;
    spin.dirty = true;
  };

  const endDrag = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    spinRef.current.dragging = false;
    e.currentTarget.style.cursor = "grab";
  };

  if (failed) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          minHeight: 240,
        }}
      >
        <p className="cd-emptyhint" style={{ textAlign: "center" }}>
          The live globe needs WebGL, which isn&apos;t available here. Your
          visitor locations are listed below.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        height: "min(100%, 780px)",
        aspectRatio: "1 / 1",
        maxWidth: "100%",
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label="Globe of live sessions by country"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          width: "100%",
          height: "100%",
          display: "block",
          cursor: "grab",
          touchAction: "none",
          opacity: 0,
          transition: "opacity 0.9s ease",
        }}
      />
    </div>
  );
}
