import type { Dict } from "./dict";

export const geographyEn: Dict["geography"] = {
  title: "Geography", description: "Countries and cities of observed IP networks", mapLabel: "Map of observed IP networks",
  range: "Period", ranges: { now: "Now", "24h": "24 hours", "7d": "7 days", "30d": "30 days" }, family: "IP family", all: "All IPs",
  ips: "Unique IPs", accounts: "Accounts", countries: "Countries", coverage: "With coordinates", locations: "Locations", users: "Location accounts",
  map: "Map", globe: "Globe", expand: "Expand", zoomIn: "Zoom in", zoomOut: "Zoom out", world: "World", focus: "Focus selection", rotate: "Rotate", clear: "Clear selection", refresh: "Refresh", settings: "Telemt position",
  ready: "Observed networks", partial: "Incomplete data · lower bound", partialEmpty: "No IPs in the available subset", empty: "No IPs observed in this period", unavailable: "Source is not available yet", stale: "Last snapshot",
  expired: "Snapshot changed. Refresh to continue.", error: "Could not load geography", loading: "Loading geography…", geoipOff: "No geodata: counts remain available without coordinates", configure: "Configure GeoIP databases",
  mapLimit: "Showing {n} of {total} locations with coordinates", weight: "Color and size represent unique IPs", arcs: "Server links, not traffic routes", approximate: "Approximate network area, not a person's position", radius: "Area radius", radiusUnknown: "Accuracy is unknown", noCoordinates: "No coordinates", noGeometry: "Country outline is unavailable",
  networkLocation: "Network location", private: "Private and local addresses", notFound: "Location not found", geoUnavailable: "Geodata unavailable", countryOnly: "Country without a location",
  memory: "Memory history: at most 24 hours available", historyNote: "Current GeoIP estimate for previously observed addresses", pending: "Saved observations may lag by up to a minute", paused: "Auto refresh paused while inspecting", age: "Snapshot age", seconds: "s", previous: "Previous", next: "Next", total: "Total", selected: "Selected",
  globeUnavailable: "3D is unavailable. Showing the SVG map.", retryGlobe: "Retry 3D", licenses: "Sources and licenses",
  settingsTitle: "Telemt server position", settingsNote: "Specify the position of Telemt itself. The panel or browser address is never filled in automatically.", modes: { hidden: "Hidden", manual: "Coordinates", ip: "Public IP" }, label: "Label", publicIP: "Telemt public IP", latitude: "Latitude", longitude: "Longitude", ipNote: "Coordinates come from the local City-MMDB. This address is excluded from client counts.", saved: "Telemt position saved", settingsError: "Check the coordinates and public IP", unresolved: "Telemt coordinates could not be resolved",
};
