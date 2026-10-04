import type { MutableRefObject } from "react";
import type { GeographyCountry, GeographyLocation, GeographyOverview } from "../lib/api/generated/types.gen";

export type GeographySelection = { country: string | null; location: string | null };
export type MapModel = { countries: GeographyCountry[]; points: GeographyLocation[]; arcs: GeographyLocation[]; server: GeographyOverview["server"]; selection: GeographySelection };
export type CameraState = { zoom: number; x: number; y: number; position?: [number, number, number] };
export type RendererControls = { zoom: (factor: number) => void; reset: () => void; focus: () => void; motion?: (enabled: boolean) => void };
export type RendererProps = { model: MapModel; expanded: boolean; onSelect: (selection: GeographySelection) => void; cameraRef?: MutableRefObject<CameraState>; controlsRef?: MutableRefObject<RendererControls | null> };
