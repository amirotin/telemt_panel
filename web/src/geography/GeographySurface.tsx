import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useStrings } from "../i18n";
import { Sheet } from "../ui/Sheet";
import { Button } from "../ui/Button";
import { VectorMap } from "./VectorMap";
import type { CameraState, MapModel, RendererControls, GeographySelection } from "./model";

const Globe = lazy(() => import("./Globe"));
class RendererBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailure();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function GeographySurface({
  model,
  view,
  onView,
  onSelect,
}: {
  model: MapModel;
  view: "map" | "globe";
  onView: (view: "map" | "globe") => void;
  onSelect: (s: GeographySelection) => void;
}) {
  const s = useStrings().geography;
  const [expanded, setExpanded] = useState(false),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0),
    [rotate, setRotate] = useState(false);
  const inline = useRef<HTMLDivElement>(null),
    large = useRef<HTMLDivElement>(null),
    controls = useRef<RendererControls | null>(null);
  const mapCamera = useRef<CameraState>({ zoom: 1, x: 0, y: 0 }),
    globeCamera = useRef<CameraState>({ zoom: 1, x: 0, y: 0 });
  const [host] = useState(() => {
    const node = document.createElement("div");
    node.className = "geo-renderer-host";
    node.dataset["geographyRenderer"] = "";
    return node;
  });
  useLayoutEffect(() => {
    (expanded ? large.current : inline.current)?.append(host);
  }, [expanded, host]);
  useEffect(() => () => host.remove(), [host]);
  useEffect(() => {
    controls.current?.motion?.(rotate);
  }, [view, rotate]);
  function unavailable() {
    setFailed(true);
    setRotate(false);
    onView("map");
  }
  const toolbar = (
    <div className="geo-map-controls">
      <Button variant="ghost" aria-label={s.zoomIn} onClick={() => controls.current?.zoom(1.25)}>
        +
      </Button>
      <Button variant="ghost" aria-label={s.zoomOut} onClick={() => controls.current?.zoom(0.8)}>
        −
      </Button>
      <Button variant="ghost" onClick={() => controls.current?.reset()}>
        {s.world}
      </Button>
      <Button
        variant="ghost"
        disabled={!model.selection.location}
        onClick={() => controls.current?.focus()}
      >
        {s.focus}
      </Button>
      {view === "globe" && !failed && (
        <Button variant="ghost" aria-pressed={rotate} onClick={() => setRotate(!rotate)}>
          {s.rotate}
        </Button>
      )}
    </div>
  );
  const renderer =
    view === "globe" && !failed ? (
      <RendererBoundary key={attempt} onFailure={unavailable}>
        <Suspense
          fallback={
            <div className="geo-loading" role="status">
              {s.loading}
            </div>
          }
        >
          <Globe
            model={model}
            expanded={expanded}
            onSelect={onSelect}
            cameraRef={globeCamera}
            controlsRef={controls}
            rotation={rotate}
            onUnavailable={unavailable}
          />
        </Suspense>
      </RendererBoundary>
    ) : (
      <VectorMap
        model={model}
        expanded={expanded}
        onSelect={onSelect}
        cameraRef={mapCamera}
        controlsRef={controls}
      />
    );
  return (
    <section className="geo-map-card">
      <header>
        <div className="geo-list-tabs">
          <Button variant="ghost" aria-pressed={view === "map"} onClick={() => onView("map")}>
            {s.map}
          </Button>
          <Button
            variant="ghost"
            aria-pressed={view === "globe"}
            disabled={failed}
            onClick={() => onView("globe")}
          >
            {s.globe}
          </Button>
        </div>
        <Button variant="secondary" onClick={() => setExpanded(true)}>
          {s.expand}
        </Button>
      </header>
      {failed && (
        <div className="geo-banner" role="status">
          {s.globeUnavailable}
          <Button
            variant="ghost"
            onClick={() => {
              setAttempt(attempt + 1);
              setFailed(false);
              onView("globe");
            }}
          >
            {s.retryGlobe}
          </Button>
        </div>
      )}
      <div ref={inline} className="geo-map-inline" />
      {!expanded && toolbar}
      <div className="geo-map-legend">
        <span className="geo-weight-gradient" />
        {s.weight}
      </div>
      {model.arcs.length > 0 && <p className="geo-note">{s.arcs}</p>}
      <Sheet
        open={expanded}
        onClose={() => setExpanded(false)}
        title={s.title}
        placement="form"
        className="geo-expanded-sheet"
        bodyClassName="geo-expanded-body"
      >
        <div ref={large} className="geo-map-expanded" />
        {toolbar}
        <p className="geo-note">{s.weight}</p>
      </Sheet>
      {createPortal(renderer, host)}
    </section>
  );
}
