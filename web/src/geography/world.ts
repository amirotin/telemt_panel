import { feature } from "topojson-client";
import type { FeatureCollection, Geometry, GeoJsonProperties } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import atlas from "world-atlas/countries-110m.json";
import codes from "./world-country-codes.json";

export const numericForAlpha2: Readonly<Record<string,string>> = codes;
const alpha2ByNumeric = new Map(Object.entries(codes).map(([alpha2,numeric]) => [numeric,alpha2]));
export function alpha2ForNumeric(id: string | number | undefined): string | null {
  return id === undefined ? null : alpha2ByNumeric.get(String(id).padStart(3,"0")) ?? null;
}
const topology = atlas as unknown as Topology<{ countries: GeometryCollection }>;
export const features = (feature(topology,topology.objects.countries) as FeatureCollection<Geometry,GeoJsonProperties>).features;
const available = new Set(features.map(f => alpha2ForNumeric(f.id)).filter(Boolean));
export function hasGeometry(code: string): boolean { return available.has(code); }
