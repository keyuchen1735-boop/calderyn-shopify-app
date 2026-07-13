import type * as GeoJSON from "geojson";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { GeoJSONSource, MapLayerMouseEvent } from "maplibre-gl";

import {
  Map,
  MapControls,
  MapMarker,
  MarkerContent,
  MarkerTooltip,
  useMap,
  type MapRef,
} from "~/components/ui/mapcn-map";
import {
  planeFrame,
  routeViewportPolicy,
  sampleRouteArc,
  selectAnimatedRoutes,
  type PlaneFrame,
  type RouteArc,
} from "~/lib/shipping/shipping-route-model";
import type {
  ShippingRouteDestination,
  ShippingRoutes30d,
} from "~/lib/shipping/summary-types";

const ROUTE_SOURCE_ID = "shipping-customer-routes";
const ROUTE_BASE_LAYER_ID = "shipping-customer-routes-base";
const ROUTE_HIGHLIGHT_LAYER_ID = "shipping-customer-routes-highlight";
const PLANE_SOURCE_ID = "shipping-route-planes";
const PLANE_LAYER_ID = "shipping-route-planes-layer";
const PLANE_IMAGE_ID = "shipping-paper-plane";

const EMPTY_POINTS: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [],
};

type ShippingRouteMapProps = {
  routes: ShippingRoutes30d;
  dark: boolean;
  onOpenSetup: () => void;
};

type ShippingRouteLayerProps = {
  routes: RouteArc[];
  destinations: ShippingRouteDestination[];
  highlightedRouteId: string | null;
  onHighlightRoute: (routeId: string | null) => void;
  viewportRootRef: RefObject<HTMLDivElement | null>;
  maxZoom: 3.25 | 2.4;
};

function routeFeatureCollection(
  routes: readonly RouteArc[],
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: routes.flatMap((route) =>
      sampleRouteArc(route.from, route.to).map((coordinates, segmentIndex) => ({
        type: "Feature" as const,
        id: `${route.id}-${segmentIndex}`,
        properties: { routeId: route.id, orderCount: route.orderCount },
        geometry: { type: "LineString" as const, coordinates },
      })),
    ),
  };
}

function frameFeatureCollection(
  frames: readonly PlaneFrame[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: frames.map((frame) => ({
      type: "Feature",
      id: frame.routeId,
      properties: {
        routeId: frame.routeId,
        bearing: frame.bearing,
      },
      geometry: {
        type: "Point",
        coordinates: [frame.longitude, frame.latitude],
      },
    })),
  };
}

function fitBoundsForRoutes(
  map: MapRef,
  routes: readonly RouteArc[],
  maxZoom: 3.25 | 2.4,
): void {
  if (routes.length === 0) return;

  const origin = routes[0].from;
  const points = [
    { id: "origin", longitude: origin[0], latitude: origin[1], country: "" },
    ...routes.map((route) => {
      const destination = route.to;
      let longitude = destination[0];
      while (longitude - origin[0] > 180) longitude -= 360;
      while (longitude - origin[0] < -180) longitude += 360;
      return {
        id: route.id,
        longitude,
        latitude: destination[1],
        country: "",
      };
    }),
  ];
  const longitudes = points.map((point) => point.longitude);
  const latitudes = points.map((point) => point.latitude);

  map.fitBounds(
    [
      [Math.min(...longitudes), Math.min(...latitudes)],
      [Math.max(...longitudes), Math.max(...latitudes)],
    ],
    { padding: 42, maxZoom, duration: 0 },
  );
}

function paperPlaneSvgDataUrl(): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">',
    '<path d="M5 23.6 42 7 29.8 42l-7.5-12.4L5 23.6Zm18.4 2.1 5.2 8.5 7-20.1-12.2 11.6Z" fill="#fff" stroke="#17202a" stroke-width="2.5" stroke-linejoin="round"/>',
    "</svg>",
  ].join("");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
}

function useIntersection(
  viewportRootRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [intersecting, setIntersecting] = useState(false);

  useEffect(() => {
    const element = viewportRootRef.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      setIntersecting(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      setIntersecting(entry?.isIntersecting ?? false);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewportRootRef]);

  return intersecting;
}

function ShippingRouteLayer({
  routes,
  destinations,
  highlightedRouteId,
  onHighlightRoute,
  viewportRootRef,
  maxZoom,
}: ShippingRouteLayerProps) {
  const { map, isLoaded } = useMap();
  const reducedMotion = useReducedMotion();
  const intersecting = useIntersection(viewportRootRef);
  const [documentVisible, setDocumentVisible] = useState(true);
  const routeData = useMemo(() => routeFeatureCollection(routes), [routes]);
  const animatedRoutes = useMemo(() => selectAnimatedRoutes(routes), [routes]);
  const latestHighlight = useRef(onHighlightRoute);
  latestHighlight.current = onHighlightRoute;

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(!document.hidden);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (!map || !isLoaded) return;

    if (!map.getSource(ROUTE_SOURCE_ID)) {
      map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: routeData });
    }
    if (!map.getLayer(ROUTE_BASE_LAYER_ID)) {
      map.addLayer({
        id: ROUTE_BASE_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#8b9aad",
          "line-width": 2,
          "line-opacity": 0.58,
        },
      });
    }
    if (!map.getLayer(ROUTE_HIGHLIGHT_LAYER_ID)) {
      map.addLayer({
        id: ROUTE_HIGHLIGHT_LAYER_ID,
        type: "line",
        source: ROUTE_SOURCE_ID,
        filter: ["==", ["get", "routeId"], ""],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ff7a45",
          "line-width": 4,
          "line-opacity": 0.96,
        },
      });
    }
    if (!map.getSource(PLANE_SOURCE_ID)) {
      map.addSource(PLANE_SOURCE_ID, { type: "geojson", data: EMPTY_POINTS });
    }
    if (!map.getLayer(PLANE_LAYER_ID)) {
      map.addLayer({
        id: PLANE_LAYER_ID,
        type: "symbol",
        source: PLANE_SOURCE_ID,
        layout: {
          "icon-image": PLANE_IMAGE_ID,
          "icon-size": 0.42,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
        },
      });
    }

    const image = new Image(48, 48);
    const addPlaneImage = () => {
      if (!map.hasImage(PLANE_IMAGE_ID)) {
        map.addImage(PLANE_IMAGE_ID, image, { pixelRatio: 2 });
      }
    };
    image.addEventListener("load", addPlaneImage);
    image.src = paperPlaneSvgDataUrl();

    const highlightFromEvent = (event: MapLayerMouseEvent) => {
      const routeId = event.features?.[0]?.properties?.routeId;
      latestHighlight.current(typeof routeId === "string" ? routeId : null);
    };
    const clearHighlight = () => latestHighlight.current(null);
    map.on("mouseenter", ROUTE_BASE_LAYER_ID, highlightFromEvent);
    map.on("mouseleave", ROUTE_BASE_LAYER_ID, clearHighlight);

    fitBoundsForRoutes(map, routes, maxZoom);

    return () => {
      image.removeEventListener("load", addPlaneImage);
      map.off("mouseenter", ROUTE_BASE_LAYER_ID, highlightFromEvent);
      map.off("mouseleave", ROUTE_BASE_LAYER_ID, clearHighlight);
      try {
        if (map.getLayer(PLANE_LAYER_ID)) map.removeLayer(PLANE_LAYER_ID);
        if (map.getLayer(ROUTE_HIGHLIGHT_LAYER_ID)) {
          map.removeLayer(ROUTE_HIGHLIGHT_LAYER_ID);
        }
        if (map.getLayer(ROUTE_BASE_LAYER_ID))
          map.removeLayer(ROUTE_BASE_LAYER_ID);
        if (map.getSource(PLANE_SOURCE_ID)) map.removeSource(PLANE_SOURCE_ID);
        if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
        if (map.hasImage(PLANE_IMAGE_ID)) map.removeImage(PLANE_IMAGE_ID);
      } catch {
        // The owning Map may already have replaced or removed its style.
      }
    };
    // Sources and layers are created once per loaded style, then updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, map]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const source = map.getSource(ROUTE_SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(routeData);
    fitBoundsForRoutes(map, routes, maxZoom);
  }, [destinations, isLoaded, map, maxZoom, routeData, routes]);

  useEffect(() => {
    if (!map || !isLoaded || !map.getLayer(ROUTE_HIGHLIGHT_LAYER_ID)) return;
    map.setFilter(ROUTE_HIGHLIGHT_LAYER_ID, [
      "==",
      ["get", "routeId"],
      highlightedRouteId ?? "",
    ]);
  }, [highlightedRouteId, isLoaded, map]);

  useEffect(() => {
    if (!map || !isLoaded) return;
    const source = map.getSource(PLANE_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;

    let animationFrame = 0;
    const animate = (elapsedMs: number) => {
      if (reducedMotion || document.hidden || !intersecting) return;
      source.setData(
        frameFeatureCollection(planeFrame(animatedRoutes, elapsedMs)),
      );
      animationFrame = requestAnimationFrame(animate);
    };

    if (!reducedMotion && documentVisible && intersecting) {
      animationFrame = requestAnimationFrame(animate);
    } else {
      source.setData(EMPTY_POINTS);
    }

    return () => cancelAnimationFrame(animationFrame);
  }, [
    animatedRoutes,
    documentVisible,
    intersecting,
    isLoaded,
    map,
    reducedMotion,
  ]);

  return null;
}

function orderLabel(orderCount: number): string {
  return `${orderCount} ${orderCount === 1 ? "order" : "orders"}`;
}

function UnmappedOrders({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p
      role="status"
      style={{ margin: "10px 0 0", color: "var(--cd-muted, #748094)" }}
    >
      {count} {count === 1 ? "order could" : "orders could"} not be placed on
      the map
    </p>
  );
}

function ResolvedShippingRouteMap({
  routes,
  dark,
}: Pick<ShippingRouteMapProps, "routes" | "dark">) {
  const [highlightedRouteId, setHighlightedRouteId] = useState<string | null>(
    null,
  );
  const mapRef = useRef<MapRef>(null);
  const viewportRootRef = useRef<HTMLDivElement>(null);
  const origin = routes.origin!;
  const routeArcs = useMemo<RouteArc[]>(
    () =>
      routes.destinations.map((destination) => ({
        id: destination.id,
        from: [origin.longitude, origin.latitude],
        to: [destination.longitude, destination.latitude],
        orderCount: destination.orderCount,
      })),
    [origin.latitude, origin.longitude, routes.destinations],
  );
  const viewportPolicy = useMemo(
    () =>
      routeViewportPolicy([
        {
          id: "origin",
          longitude: origin.longitude,
          latitude: origin.latitude,
          country: origin.country,
        },
        ...routes.destinations.map((destination) => ({
          id: destination.id,
          longitude: destination.longitude,
          latitude: destination.latitude,
          country: destination.country,
        })),
      ]),
    [origin.country, origin.latitude, origin.longitude, routes.destinations],
  );

  const focusDestination = useCallback(
    (destination: ShippingRouteDestination) => {
      setHighlightedRouteId(destination.id);
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({
        center: [destination.longitude, destination.latitude],
        zoom: Math.min(map.getZoom(), viewportPolicy.maxZoom),
        duration: 650,
      });
    },
    [viewportPolicy.maxZoom],
  );

  return (
    <div>
      <div
        ref={viewportRootRef}
        role="region"
        aria-label="Customer shipping routes"
        style={{
          height: 340,
          overflow: "hidden",
          borderRadius: 14,
          border: "1px solid var(--cd-border, rgba(128, 140, 158, .24))",
          background: dark ? "#121820" : "#eef2f5",
        }}
      >
        {/* Omitting `theme` deliberately keeps the primitive's dashboard/system Carto detection. */}
        <Map
          ref={mapRef}
          renderWorldCopies={false}
          attributionControl={{ compact: true }}
        >
          <MapControls position="bottom-right" showZoom />
          <ShippingRouteLayer
            routes={routeArcs}
            destinations={routes.destinations}
            highlightedRouteId={highlightedRouteId}
            onHighlightRoute={setHighlightedRouteId}
            viewportRootRef={viewportRootRef}
            maxZoom={viewportPolicy.maxZoom}
          />
          <MapMarker longitude={origin.longitude} latitude={origin.latitude}>
            <MarkerContent>
              <span
                aria-hidden="true"
                style={{
                  display: "block",
                  width: 15,
                  height: 15,
                  borderRadius: 4,
                  border: "2px solid white",
                  background: "#ff7a45",
                  boxShadow: "0 2px 8px rgba(0,0,0,.34)",
                }}
              />
            </MarkerContent>
            <MarkerTooltip>
              <strong>Ship-from {origin.city}</strong>
            </MarkerTooltip>
          </MapMarker>
          {routes.destinations.map((destination) => (
            <MapMarker
              key={destination.id}
              longitude={destination.longitude}
              latitude={destination.latitude}
              onClick={() => focusDestination(destination)}
              onMouseEnter={() => setHighlightedRouteId(destination.id)}
              onMouseLeave={() => setHighlightedRouteId(null)}
            >
              <MarkerContent>
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: "2px solid white",
                    background:
                      highlightedRouteId === destination.id
                        ? "#ff7a45"
                        : "#52708f",
                    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
                  }}
                />
              </MarkerContent>
              <MarkerTooltip>
                <strong>{destination.city}</strong> ·{" "}
                {orderLabel(destination.orderCount)}
              </MarkerTooltip>
            </MapMarker>
          ))}
        </Map>
      </div>

      <ul
        aria-label="Shipping destinations"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 8,
          padding: 0,
          margin: "12px 0 0",
          listStyle: "none",
        }}
      >
        {routes.destinations.map((destination) => (
          <li key={destination.id}>
            <button
              type="button"
              aria-pressed={highlightedRouteId === destination.id}
              onFocus={() => setHighlightedRouteId(destination.id)}
              onBlur={() => setHighlightedRouteId(null)}
              onMouseEnter={() => setHighlightedRouteId(destination.id)}
              onMouseLeave={() => setHighlightedRouteId(null)}
              onClick={() => focusDestination(destination)}
              style={{
                width: "100%",
                padding: "9px 11px",
                textAlign: "left",
                borderRadius: 10,
                border: "1px solid var(--cd-border, rgba(128, 140, 158, .24))",
                color: "inherit",
                background:
                  highlightedRouteId === destination.id
                    ? "var(--cd-surface-hover, rgba(128, 140, 158, .14))"
                    : "transparent",
                cursor: "pointer",
              }}
            >
              <span style={{ display: "block", fontWeight: 650 }}>
                {destination.city}
              </span>
              <span style={{ color: "var(--cd-muted, #748094)", fontSize: 12 }}>
                {orderLabel(destination.orderCount)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <UnmappedOrders count={routes.unmappedOrderCount} />
    </div>
  );
}

export function ShippingRouteMapFrame({
  routes,
  dark,
  onOpenSetup,
}: ShippingRouteMapProps) {
  const orderCount = routes.mappedOrderCount + routes.unmappedOrderCount;

  if (orderCount === 0) {
    return (
      <p className="cd-emptyhint">Routes appear after your first orders</p>
    );
  }

  if (!routes.origin) {
    return (
      <div>
        <p className="cd-emptyhint">Set a ship-from origin to draw routes</p>
        <button
          type="button"
          className="cd-btn cd-btn-primary cd-btn-sm"
          onClick={onOpenSetup}
        >
          Setup
        </button>
        <UnmappedOrders count={routes.unmappedOrderCount} />
      </div>
    );
  }

  if (routes.destinations.length === 0) {
    return (
      <div>
        <p className="cd-emptyhint">
          No customer destinations could be placed on the map
        </p>
        <UnmappedOrders count={routes.unmappedOrderCount} />
      </div>
    );
  }

  return <ResolvedShippingRouteMap routes={routes} dark={dark} />;
}

export default function ShippingRouteMap(props: ShippingRouteMapProps) {
  return <ShippingRouteMapFrame {...props} />;
}
