import { describe, expect, it } from "vitest";

import {
  planeFrame,
  routeViewportPolicy,
  sampleRouteArc,
  selectAnimatedRoutes,
  shouldAnimatePlanes,
  type RouteArc,
  type RoutePoint,
} from "../shipping-route-model";

const naPoints: RoutePoint[] = [
  {
    id: "vancouver",
    longitude: -123.1207,
    latitude: 49.2827,
    country: "CA",
  },
  {
    id: "new-york",
    longitude: -74.006,
    latitude: 40.7128,
    country: "US",
  },
  {
    id: "mexico-city",
    longitude: -99.1332,
    latitude: 19.4326,
    country: "MX",
  },
];

const singapore: RoutePoint = {
  id: "singapore",
  longitude: 103.8198,
  latitude: 1.3521,
  country: "SG",
};

const fourRoutes: RouteArc[] = [
  {
    id: "eight-orders",
    from: [-123.1207, 49.2827],
    to: [-74.006, 40.7128],
    orderCount: 8,
  },
  {
    id: "twenty-orders",
    from: [-123.1207, 49.2827],
    to: [139.6917, 35.6895],
    orderCount: 20,
  },
  {
    id: "four-orders",
    from: [-123.1207, 49.2827],
    to: [-99.1332, 19.4326],
    orderCount: 4,
  },
  {
    id: "twelve-orders",
    from: [-123.1207, 49.2827],
    to: [103.8198, 1.3521],
    orderCount: 12,
  },
];

describe("routeViewportPolicy", () => {
  it("uses the North America zoom policy for North American points", () => {
    expect(routeViewportPolicy(naPoints).maxZoom).toBe(3.25);
    expect(routeViewportPolicy(naPoints).international).toBe(false);
  });

  it("uses the international zoom policy when a point is outside North America", () => {
    expect(routeViewportPolicy([...naPoints, singapore]).maxZoom).toBe(2.4);
    expect(routeViewportPolicy([...naPoints, singapore]).international).toBe(
      true,
    );
  });
});

describe("selectAnimatedRoutes", () => {
  it("returns the top three routes by order count without mutating the input", () => {
    const originalOrder = fourRoutes.map((route) => route.id);
    const selected = selectAnimatedRoutes(fourRoutes);

    expect(selected.map((route) => route.orderCount)).toEqual([20, 12, 8]);
    expect(fourRoutes.map((route) => route.id)).toEqual(originalOrder);
  });

  it("breaks equal order-count ties by route ID", () => {
    const tiedRoutes = ["charlie", "alpha", "bravo"].map((id) => ({
      id,
      from: [-123.1207, 49.2827] as [number, number],
      to: [-74.006, 40.7128] as [number, number],
      orderCount: 10,
    }));

    expect(selectAnimatedRoutes(tiedRoutes).map((route) => route.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });
});

describe("sampleRouteArc", () => {
  it("samples a curved route between its endpoints", () => {
    const [segment] = sampleRouteArc([-74.006, 40.7128], [-99.1332, 19.4326]);

    expect(segment[0]).toEqual([-74.006, 40.7128]);
    expect(segment.at(-1)).toEqual([-99.1332, 19.4326]);
    expect(segment.length).toBeGreaterThan(2);
  });

  it("splits a Vancouver-to-Tokyo route at the antimeridian", () => {
    const segments = sampleRouteArc([-123.1207, 49.2827], [139.6917, 35.6895]);

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      for (let index = 1; index < segment.length; index += 1) {
        expect(
          Math.abs(segment[index][0] - segment[index - 1][0]),
        ).toBeLessThanOrEqual(180);
      }
    }
  });

  it.each([
    { from: [170, 0], to: [-170, 0] },
    { from: [-170, 0], to: [170, 0] },
    { from: [180, 0], to: [-170, 0] },
    { from: [-180, 0], to: [170, 0] },
  ] as const)(
    "keeps exact and boundary-start antimeridian samples contiguous from $from to $to",
    ({ from, to }) => {
      const segments = sampleRouteArc([...from], [...to]);

      for (const segment of segments) {
        for (let index = 1; index < segment.length; index += 1) {
          expect(
            Math.abs(segment[index][0] - segment[index - 1][0]),
          ).toBeLessThanOrEqual(180);
        }
      }
    },
  );
});

describe("planeFrame", () => {
  const topThree = selectAnimatedRoutes(fourRoutes);

  it("loops the first plane over the configured duration", () => {
    expect(planeFrame(topThree, 15_000)[0].progress).toBeCloseTo(0, 5);
    expect(planeFrame(topThree, 7_500)[0].progress).toBeCloseTo(0.5, 2);
  });

  it("staggers planes evenly and returns route position and bearing", () => {
    const frames = planeFrame(topThree, 0);

    expect(frames.map((frame) => frame.progress)).toEqual([
      0,
      1 / topThree.length,
      2 / topThree.length,
    ]);
    expect(frames[0]).toMatchObject({
      routeId: topThree[0].id,
      longitude: topThree[0].from[0],
      latitude: topThree[0].from[1],
    });
    expect(Number.isFinite(frames[0].bearing)).toBe(true);
  });
});

describe("shouldAnimatePlanes", () => {
  it.each([
    {
      state: { reducedMotion: true, documentVisible: true, intersecting: true },
      expected: false,
    },
    {
      state: {
        reducedMotion: false,
        documentVisible: false,
        intersecting: true,
      },
      expected: false,
    },
    {
      state: {
        reducedMotion: false,
        documentVisible: true,
        intersecting: false,
      },
      expected: false,
    },
    {
      state: {
        reducedMotion: false,
        documentVisible: true,
        intersecting: true,
      },
      expected: true,
    },
  ])("returns $expected for $state", ({ state, expected }) => {
    expect(shouldAnimatePlanes(state)).toBe(expected);
  });
});
