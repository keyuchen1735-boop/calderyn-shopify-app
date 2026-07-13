export const PLANE_DURATION_MS = 15_000;
export const MAX_ANIMATED_ROUTES = 3;
export const NORTH_AMERICA_COUNTRIES = new Set(["CA", "US", "MX"]);

export interface RoutePoint {
  id: string;
  longitude: number;
  latitude: number;
  country: string;
}

export interface RouteArc {
  id: string;
  from: [number, number];
  to: [number, number];
  orderCount: number;
}

export type RouteSegment = [number, number][];

export interface RouteViewportPolicy {
  maxZoom: 3.25 | 2.4;
  international: boolean;
}

export interface PlaneFrame {
  routeId: string;
  longitude: number;
  latitude: number;
  bearing: number;
  progress: number;
}

export interface PlaneAnimationState {
  reducedMotion: boolean;
  documentVisible: boolean;
  intersecting: boolean;
}

const DEFAULT_ARC_SAMPLES = 64;
const BEARING_SAMPLE_STEP = 1 / 1_024;

export function routeViewportPolicy(
  points: readonly RoutePoint[],
): RouteViewportPolicy {
  const international = points.some(
    (point) => !NORTH_AMERICA_COUNTRIES.has(point.country),
  );

  return {
    maxZoom: international ? 2.4 : 3.25,
    international,
  };
}

export function selectAnimatedRoutes(routes: readonly RouteArc[]): RouteArc[] {
  return [...routes]
    .sort((left, right) => {
      const orderCountDifference = right.orderCount - left.orderCount;
      if (orderCountDifference !== 0) return orderCountDifference;
      if (left.id < right.id) return -1;
      if (left.id > right.id) return 1;
      return 0;
    })
    .slice(0, MAX_ANIMATED_ROUTES);
}

export function sampleRouteArc(
  from: [number, number],
  to: [number, number],
  samples = DEFAULT_ARC_SAMPLES,
): RouteSegment[] {
  const sampleCount = Math.max(2, Math.floor(samples));
  const unwrappedTo = unwrapLongitude(from[0], to[0]);
  const sampledPoints = Array.from({ length: sampleCount + 1 }, (_, index) =>
    pointOnArc(from, [unwrappedTo, to[1]], index / sampleCount),
  );

  return splitAtAntimeridian(sampledPoints);
}

export function planeFrame(
  routes: readonly RouteArc[],
  elapsedMs: number,
): PlaneFrame[] {
  const routeCount = routes.length;
  if (routeCount === 0) return [];

  const elapsedProgress =
    positiveModulo(elapsedMs, PLANE_DURATION_MS) / PLANE_DURATION_MS;

  return routes.map((route, index) => {
    const progress = (elapsedProgress + index / routeCount) % 1;
    const unwrappedTo: [number, number] = [
      unwrapLongitude(route.from[0], route.to[0]),
      route.to[1],
    ];
    const current = pointOnArc(route.from, unwrappedTo, progress);
    const next = pointOnArc(
      route.from,
      unwrappedTo,
      Math.min(1, progress + BEARING_SAMPLE_STEP),
    );

    return {
      routeId: route.id,
      longitude: normalizeLongitude(current[0]),
      latitude: current[1],
      bearing: bearingBetween(current, next),
      progress,
    };
  });
}

export function shouldAnimatePlanes(state: PlaneAnimationState): boolean {
  return !state.reducedMotion && state.documentVisible && state.intersecting;
}

function pointOnArc(
  from: [number, number],
  unwrappedTo: [number, number],
  progress: number,
): [number, number] {
  const oneMinusProgress = 1 - progress;
  const controlLongitude = (from[0] + unwrappedTo[0]) / 2;
  const directDistance = Math.hypot(
    unwrappedTo[0] - from[0],
    unwrappedTo[1] - from[1],
  );
  const controlLatitude = Math.min(
    85,
    (from[1] + unwrappedTo[1]) / 2 + Math.min(30, directDistance * 0.2),
  );

  return [
    oneMinusProgress * oneMinusProgress * from[0] +
      2 * oneMinusProgress * progress * controlLongitude +
      progress * progress * unwrappedTo[0],
    oneMinusProgress * oneMinusProgress * from[1] +
      2 * oneMinusProgress * progress * controlLatitude +
      progress * progress * unwrappedTo[1],
  ];
}

function splitAtAntimeridian(
  points: readonly [number, number][],
): RouteSegment[] {
  const first = points[0];
  const segments: RouteSegment[] = [[[normalizeLongitude(first[0]), first[1]]]];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const boundary = crossedAntimeridian(previous[0], current[0]);
    const activeSegment = segments[segments.length - 1];

    if (boundary === undefined) {
      activeSegment.push([normalizeLongitude(current[0]), current[1]]);
      continue;
    }

    const crossingProgress =
      (boundary - previous[0]) / (current[0] - previous[0]);
    const crossingLatitude =
      previous[1] + crossingProgress * (current[1] - previous[1]);
    const wrappedBoundary = boundary > 0 ? -180 : 180;

    activeSegment.push([boundary, crossingLatitude]);
    segments.push([
      [wrappedBoundary, crossingLatitude],
      [normalizeLongitude(current[0]), current[1]],
    ]);
  }

  return segments;
}

function crossedAntimeridian(
  fromLongitude: number,
  toLongitude: number,
): 180 | -180 | undefined {
  if (fromLongitude <= 180 && toLongitude > 180) return 180;
  if (fromLongitude >= -180 && toLongitude < -180) return -180;
  return undefined;
}

function unwrapLongitude(fromLongitude: number, toLongitude: number): number {
  let delta = toLongitude - fromLongitude;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return fromLongitude + delta;
}

function normalizeLongitude(longitude: number): number {
  if (longitude >= -180 && longitude <= 180) return longitude;
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function bearingBetween(from: [number, number], to: [number, number]): number {
  const fromLatitude = degreesToRadians(from[1]);
  const toLatitude = degreesToRadians(to[1]);
  const longitudeDelta = degreesToRadians(to[0] - from[0]);
  const y = Math.sin(longitudeDelta) * Math.cos(toLatitude);
  const x =
    Math.cos(fromLatitude) * Math.sin(toLatitude) -
    Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(longitudeDelta);

  return (radiansToDegrees(Math.atan2(y, x)) + 360) % 360;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
