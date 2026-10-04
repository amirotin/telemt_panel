import type { GeographyLocation, GeographyOverview } from "../lib/api/generated/types.gen";
import type { GeographySelection, MapModel } from "./model";

function top(points: GeographyLocation[], limit: number, selected: GeographyLocation | undefined): GeographyLocation[] {
  const sorted = [...points].sort((a,b) => b.unique_ips-a.unique_ips || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
  const result = sorted.slice(0,limit);
  if (selected && !result.some(p => p.id === selected.id)) {
    if (result.length === limit) result[limit-1] = selected;
    else result.push(selected);
  }
  return result;
}

export function buildMapModel(data: GeographyOverview, selection: GeographySelection): MapModel {
  const candidates = data.points.filter(p => p.location && (!selection.country || p.country_code === selection.country));
  const picked = data.selection && "city_id" in data.selection ? data.selection : null;
  const selected = candidates.find(p => p.id === selection.location) ?? (picked?.id === selection.location && picked.location ? picked : undefined);
  const points = top(candidates,200,selected);
  return { countries: data.countries.filter(c => !selection.country || c.country_code === selection.country), points, arcs: data.server.state === "ready" && data.server.location ? top(points,40,selected) : [], server: data.server, selection };
}

export function pointRadius(count: number, maximum: number): number {
  return count > 0 && maximum > 0 ? 4 + 12 * Math.sqrt(Math.min(1, Math.log1p(count)/Math.log1p(maximum))) : 4;
}

export function weight(count: number, maximum: number): number {
  return maximum > 0 ? Math.log1p(Math.max(0,count))/Math.log1p(maximum) : 0;
}
