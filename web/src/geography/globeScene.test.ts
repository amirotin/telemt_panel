import { Color, InstancedMesh, Matrix4, Mesh, MeshPhongMaterial, Vector3, type CanvasTexture, type PerspectiveCamera, type Scene, type SphereGeometry } from "three";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGlobeScene } from "./globeScene";
import { buildMapModel } from "./mapModel";
import { location, overview } from "./testFixtures";

type RenderedScene = { domElement: HTMLCanvasElement; scene: Scene | null; camera: PerspectiveCamera | null };
const renderers = vi.hoisted(() => ({ instances: [] as RenderedScene[] }));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      scene: Scene | null = null;
      camera: PerspectiveCamera | null = null;
      constructor() { renderers.instances.push(this); }
      setPixelRatio() {}
      setSize() {}
      render(scene: Scene, camera: PerspectiveCamera) { this.scene = scene; this.camera = camera; }
      dispose() {}
      forceContextLoss() {}
    },
  };
});

let frameID = 0;
let pending: Map<number, FrameRequestCallback>;
let host: HTMLDivElement;
let globe: ReturnType<typeof createGlobeScene> | undefined;

beforeEach(() => {
  pending = new Map();
  renderers.instances.length = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { pending.set(++frameID, callback); return frameID; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => pending.delete(id));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const context = {
    clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  host = document.createElement("div");
  Object.defineProperties(host, { clientWidth: { value: 900 }, clientHeight: { value: 450, configurable: true } });
  document.body.append(host);
});

afterEach(() => {
  globe?.dispose();
  globe = undefined;
  host.remove();
  document.documentElement.style.removeProperty("--geo-data");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frame(time: number) {
  const callbacks = [...pending.values()];
  pending.clear();
  callbacks.forEach(callback => callback(time));
}

function start(selected = false) {
  const model = buildMapModel(overview(), { country: null, location: selected ? "city:DE:1" : null });
  globe = createGlobeScene(host, model, { onSelect: () => {}, onUnavailable: () => {} });
  frame(0);
  const renderer = renderers.instances[0];
  const markers = renderer.scene!.children.find(child => child instanceof InstancedMesh) as InstancedMesh;
  const sphere = renderer.scene!.children.find(child => child instanceof Mesh && child.material instanceof MeshPhongMaterial) as Mesh<SphereGeometry, MeshPhongMaterial>;
  const texture = sphere.material.map as CanvasTexture;
  return { model, renderer, markers, texture };
}

function markerRadius(markers: InstancedMesh) {
  const matrix = new Matrix4();
  markers.getMatrixAt(0, matrix);
  return new Vector3().setFromMatrixScale(matrix).x;
}

it.each(["zoom", "reset", "focus", "resize"] as const)("updates markers without uploading the country atlas on %s", (operation) => {
  const { markers, texture } = start(operation === "focus");
  if (operation === "reset") globe!.zoom(1.4);
  if (operation === "resize") Object.defineProperty(host, "clientHeight", { value: 900 });
  const previousTexture = texture.version;
  const previousMatrices = markers.instanceMatrix.version;
  const previousRadius = markerRadius(markers);
  if (operation === "zoom") globe!.zoom(1.2);
  else globe![operation]();
  expect(texture.version).toBe(previousTexture);
  expect(markers.instanceMatrix.version).toBeGreaterThan(previousMatrices);
  if (operation === "zoom") expect(markerRadius(markers)).toBeCloseTo(previousRadius / 1.2, 6);
  if (operation === "resize") expect(markerRadius(markers)).toBeCloseTo(previousRadius / 2, 6);
});

it("updates points, arcs and location selection without repainting identical country values", () => {
  const { model, renderer, markers, texture } = start();
  const previousTexture = texture.version;
  globe!.update({
    ...model,
    countries: model.countries.map(country => ({ ...country })),
    points: [model.points[0], location("city:DE:2", 2)],
    arcs: [location("city:DE:2", 2)],
    server: { ...model.server, location: { latitude: 10, longitude: 20, accuracy_radius_km: null } },
    selection: { country: null, location: "city:DE:2" },
  });
  expect(texture.version).toBe(previousTexture);
  expect(markers.count).toBe(2);
  const second = new Matrix4();
  markers.getMatrixAt(1, second);
  expect(new Vector3().setFromMatrixPosition(second).x).toBeCloseTo(1.012);
  expect(renderer.scene!.children.some(child => child instanceof Mesh && !(child instanceof InstancedMesh) && child.geometry.type === "OctahedronGeometry" && child.visible)).toBe(true);
  expect(renderer.scene!.children.flatMap(child => child.children).some(child => child.type === "Line")).toBe(true);
});

it("repaints the atlas when country shading or selected country changes", () => {
  const { model, texture } = start();
  const previousTexture = texture.version;
  globe!.update({ ...model, countries: model.countries.map(country => ({ ...country, unique_ips: 4 })) });
  expect(texture.version).toBeGreaterThan(previousTexture);
  const changedTexture = texture.version;
  globe!.update({ ...model, selection: { country: "DE", location: null } });
  expect(texture.version).toBeGreaterThan(changedTexture);
});

it("refreshes theme texture and marker colors from RGB triplets", async () => {
  const { markers, texture } = start();
  const previousTexture = texture.version;
  document.documentElement.style.setProperty("--geo-data", "100 150 200");
  await Promise.resolve();
  expect(texture.version).toBeGreaterThan(previousTexture);
  const color = new Color();
  markers.getColorAt(0, color);
  expect(color.getStyle()).toBe("rgb(100,150,200)");
});

it("updates marker sizes for OrbitControls wheel zoom inside the existing scheduled frame", () => {
  const { renderer, markers, texture } = start();
  globe!.setExpanded(true);
  frame(34);
  const previousTexture = texture.version;
  const previousMatrices = markers.instanceMatrix.version;
  const previousDistance = renderer.camera!.position.length();
  const previousRadius = markerRadius(markers);
  for (let i = 0; i < 3; i++) renderer.domElement.dispatchEvent(new WheelEvent("wheel", { cancelable: true, deltaY: 100 }));
  const nextDistance = renderer.camera!.position.length();
  expect(nextDistance).toBeGreaterThan(previousDistance * 1.01);
  expect(markers.instanceMatrix.version).toBe(previousMatrices);
  expect(pending.size).toBe(1);
  frame(68);
  expect(markers.instanceMatrix.version).toBeGreaterThan(previousMatrices);
  expect(markerRadius(markers)).toBeCloseTo(previousRadius * nextDistance / previousDistance, 6);
  expect(texture.version).toBe(previousTexture);
  expect(pending.size).toBe(0);
  globe!.dispose();
  expect(host.querySelectorAll("canvas")).toHaveLength(0);
  expect(pending.size).toBe(0);
});
