import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { geoGraticule10, geoNaturalEarth1, geoPath } from "d3-geo";
import { useStrings } from "../i18n";
import { features, alpha2ForNumeric } from "./world";
import { pointRadius, weight } from "./mapModel";
import type { CameraState, RendererProps } from "./model";

const width = 960,
  height = 500;
const projection = geoNaturalEarth1().fitExtent(
  [
    [24, 24],
    [width - 24, height - 24],
  ],
  { type: "Sphere" },
);
const path = geoPath(projection);
const graticule = path(geoGraticule10()) ?? undefined;
const outline = path({ type: "Sphere" }) ?? undefined;

export function VectorMap({ model, expanded, onSelect, cameraRef, controlsRef }: RendererProps) {
  const s = useStrings();
  const oceanId = useId();
  const svg = useRef<SVGSVGElement>(null);
  const [pose, setPose] = useState<CameraState>({ zoom: 1, x: 0, y: 0 });
  const poseRef = useRef(pose);
  useLayoutEffect(() => {
    let active = true;
    const saved = cameraRef?.current;
    if (saved)
      queueMicrotask(() => {
        if (active) {
          poseRef.current = saved;
          setPose(saved);
        }
      });
    return () => {
      active = false;
    };
  }, [cameraRef]);
  const [cssScale, setCssScale] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    distance: number;
    centerX: number;
    centerY: number;
    pose: CameraState;
  } | null>(null);
  const dragged = useRef(false);
  const max = Math.max(0, ...model.countries.map((c) => c.unique_ips));
  const pointMax = Math.max(0, ...model.points.map((p) => p.unique_ips));
  const countries = new Map(model.countries.map((c) => [c.country_code, c]));
  const change = useCallback(
    (next: CameraState) => {
      poseRef.current = next;
      if (cameraRef) cameraRef.current = next;
      setPose(next);
    },
    [cameraRef],
  );
  useEffect(() => {
    const element = svg.current;
    if (!expanded || !element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = poseRef.current;
      change({
        ...current,
        zoom: Math.max(1, Math.min(8, current.zoom * Math.exp(-event.deltaY * 0.001))),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [expanded, change]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setCssScale(
        box.width > 0 && box.height > 0 ? Math.max(width / box.width, height / box.height) : 1,
      );
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  useEffect(() => {
    if (!controlsRef) return;
    controlsRef.current = {
      zoom: (factor) => {
        const current = poseRef.current;
        change({ ...current, zoom: Math.max(1, Math.min(8, current.zoom * factor)) });
      },
      reset: () => change({ zoom: 1, x: 0, y: 0 }),
      focus: () => {
        const target = model.points.find((p) => p.id === model.selection.location)?.location;
        if (!target) return;
        const xy = projection([target.longitude, target.latitude]);
        if (!xy) return;
        const zoom = 3;
        change({ zoom, x: (width / 2 - xy[0]) * zoom, y: (height / 2 - xy[1]) * zoom });
      },
    };
    return () => {
      controlsRef.current = null;
    };
  }, [controlsRef, change, model]);
  function rebaseGesture() {
    const points = [...pointers.current.values()];
    gesture.current = points.length
      ? {
          pose: poseRef.current,
          distance:
            points.length >= 2
              ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
              : 0,
          centerX: points.reduce((n, p) => n + p.x, 0) / points.length,
          centerY: points.reduce((n, p) => n + p.y, 0) / points.length,
        }
      : null;
  }
  function begin(event: PointerEvent<SVGSVGElement>) {
    dragged.current = false;
    if (!expanded) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (event.target instanceof Element) event.target.setPointerCapture?.(event.pointerId);
    dragged.current = false;
    rebaseGesture();
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!expanded || !pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()],
      g = gesture.current;
    const x = points.reduce((n, p) => n + p.x, 0) / points.length,
      y = points.reduce((n, p) => n + p.y, 0) / points.length;
    const deltaX = x - g.centerX,
      deltaY = y - g.centerY;
    dragged.current = dragged.current || Math.abs(deltaX) + Math.abs(deltaY) > 5;
    const ratio =
      points.length === 2 && g.distance > 0
        ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / g.distance
        : 1;
    change({
      ...g.pose,
      zoom: Math.max(1, Math.min(8, g.pose.zoom * ratio)),
      x: g.pose.x + deltaX * cssScale,
      y: g.pose.y + deltaY * cssScale,
    });
  }
  function end(event: PointerEvent<SVGSVGElement>) {
    pointers.current.delete(event.pointerId);
    rebaseGesture();
  }
  const select = (selection: RendererProps["model"]["selection"]) => {
    if (!dragged.current) onSelect(selection);
  };
  const radiusScale = cssScale / pose.zoom;
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${width} ${height}`}
      className="geo-vector"
      aria-label={s.geography.mapLabel}
      style={{ touchAction: expanded ? "none" : "pan-y pinch-zoom" }}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <defs>
        <radialGradient id={oceanId} cx="45%" cy="35%" r="75%">
          <stop
            offset="0"
            stopColor="color-mix(in srgb, rgb(var(--geo-ocean)) 92%, rgb(var(--geo-land)))"
          />
          <stop offset="1" stopColor="rgb(var(--geo-ocean))" />
        </radialGradient>
      </defs>
      <g
        transform={`translate(${width / 2 + pose.x} ${height / 2 + pose.y}) scale(${pose.zoom}) translate(${-width / 2} ${-height / 2})`}
      >
        <path
          d={outline}
          fill={`url(#${oceanId})`}
          stroke="rgb(var(--geo-border))"
          strokeOpacity=".5"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={graticule}
          fill="none"
          stroke="rgb(var(--geo-grid))"
          strokeOpacity=".22"
          strokeWidth=".7"
          vectorEffect="non-scaling-stroke"
        />
        {features.map((f, i) => {
          const code = alpha2ForNumeric(f.id),
            country = code ? countries.get(code) : undefined,
            selected = !!code && code === model.selection.country;
          return (
            <path
              key={`${f.id}-${i}`}
              d={path(f) ?? undefined}
              fill={
                country
                  ? `color-mix(in srgb, rgb(var(--geo-data)) ${40 + weight(country.unique_ips, max) * 56}%, rgb(var(--geo-land)))`
                  : "rgb(var(--geo-land))"
              }
              stroke={
                selected
                  ? "rgb(var(--text))"
                  : country
                    ? "rgb(var(--geo-data))"
                    : "rgb(var(--geo-border))"
              }
              strokeWidth={selected ? 2 : country ? 1.1 : 0.65}
              vectorEffect="non-scaling-stroke"
              className={country ? "geo-country-active" : ""}
              role={country ? "button" : undefined}
              tabIndex={country ? 0 : undefined}
              aria-label={
                country
                  ? `${country.name_ru || country.name || code}: ${country.unique_ips} IP`
                  : undefined
              }
              onClick={() => {
                if (country) select({ country: country.country_code, location: null });
              }}
              onKeyDown={(event) => {
                if (country && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onSelect({ country: country.country_code, location: null });
                }
              }}
            >
              <title>
                {country
                  ? (s.locale === "ru" ? country.name_ru || country.name : country.name) || code
                  : f.properties?.["name"]}
              </title>
            </path>
          );
        })}
        {model.server.location &&
          model.arcs.map((p) => (
            <path
              key={`arc-${p.id}`}
              d={
                path({
                  type: "LineString",
                  coordinates: [
                    [model.server.location!.longitude, model.server.location!.latitude],
                    [p.location!.longitude, p.location!.latitude],
                  ],
                }) ?? undefined
              }
              fill="none"
              stroke="rgb(var(--geo-data))"
              strokeOpacity=".65"
              strokeWidth="1.3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        {model.points.map((p) => {
          const position = projection([p.location!.longitude, p.location!.latitude]);
          if (!position) return null;
          const selected = p.id === model.selection.location;
          const title =
            (s.locale === "ru" ? p.name_ru || p.name : p.name) || s.geography.networkLocation;
          return (
            <g
              key={p.id}
              data-geo-point={p.id}
              transform={`translate(${position[0]} ${position[1]})`}
              role="button"
              tabIndex={0}
              aria-label={`${title}: ${p.unique_ips} IP`}
              onClick={() => select({ country: p.country_code, location: p.id })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect({ country: p.country_code, location: p.id });
                }
              }}
            >
              <title>
                {title} · {p.unique_ips} IP
              </title>
              <circle r={22 * radiusScale} fill="transparent" />
              <circle
                r={pointRadius(p.unique_ips, pointMax) * radiusScale}
                fill="rgb(var(--geo-data))"
                stroke={selected ? "rgb(var(--text))" : "rgb(var(--geo-backdrop))"}
                strokeWidth={(selected ? 3 : 1.5) * radiusScale}
              />
              {selected && (
                <circle
                  r={(pointRadius(p.unique_ips, pointMax) + 5) * radiusScale}
                  fill="none"
                  stroke="rgb(var(--text))"
                  strokeWidth={radiusScale}
                />
              )}
            </g>
          );
        })}
        {model.server.location &&
          (() => {
            const xy = projection([
              model.server.location.longitude,
              model.server.location.latitude,
            ]);
            return xy ? (
              <g transform={`translate(${xy[0]} ${xy[1]})`}>
                <title>{model.server.label || "Telemt"}</title>
                <path
                  d={`M0 ${-9 * radiusScale} L${9 * radiusScale} 0 L0 ${9 * radiusScale} L${-9 * radiusScale} 0Z`}
                  fill="rgb(var(--text))"
                  stroke="rgb(var(--surface))"
                  strokeWidth={2 * radiusScale}
                />
              </g>
            ) : null;
          })()}
      </g>
    </svg>
  );
}
