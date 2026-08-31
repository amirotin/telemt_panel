import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en, ru, type Dict } from "../i18n";
import {
  MANAGEMENT_NAV_ITEMS,
  NAV_ITEMS,
  OPERATIONAL_NAV_ITEMS,
  isNavItemActive,
} from "./nav";

// The operational and management sections of the navigation concept. The
// list is spelled out here rather than derived from NAV_ITEMS: a test that
// read the same array it checks would happily accept a section silently
// dropped from the bar.
const OPERATIONAL_SECTIONS = [
  { to: "/overview", labelKey: "overview" },
  { to: "/people", labelKey: "people" },
  { to: "/pulse", labelKey: "pulse" },
  { to: "/journal", labelKey: "journal" },
] as const;
const MANAGEMENT_SECTIONS = [
  { to: "/server", labelKey: "server" },
  { to: "/web", labelKey: "web" },
] as const;
const SECTIONS = [...OPERATIONAL_SECTIONS, ...MANAGEMENT_SECTIONS] as const;

describe("the grouped navigation", () => {
  it("keeps operational sections before management sections", () => {
    expect(OPERATIONAL_NAV_ITEMS.map(({ to, labelKey }) => ({ to, labelKey }))).toEqual([
      ...OPERATIONAL_SECTIONS,
    ]);
    expect(MANAGEMENT_NAV_ITEMS.map(({ to, labelKey }) => ({ to, labelKey }))).toEqual([
      ...MANAGEMENT_SECTIONS,
    ]);
    expect(NAV_ITEMS.map(({ to, labelKey }) => ({ to, labelKey }))).toEqual([...SECTIONS]);
  });

  it("gives every section its own icon", () => {
    const icons = new Set(NAV_ITEMS.map((item) => item.Icon));
    expect(icons.size).toBe(NAV_ITEMS.length);
  });

  it("has a distinct, non-empty label in both dictionaries", () => {
    for (const dict of [ru, en] as Dict[]) {
      const labels = NAV_ITEMS.map((item) => dict.nav[item.labelKey]);
      expect(labels.every((label) => label.trim().length > 0)).toBe(true);
      expect(new Set(labels).size).toBe(NAV_ITEMS.length);
    }
    expect(NAV_ITEMS.map((item) => ru.nav[item.labelKey])).toEqual([
      "Сводка",
      "Люди",
      "Пульс",
      "Журнал",
      "Сервер",
      "WEB",
    ]);
  });

  it("marks a section current for its own path and for anything nested under it", () => {
    expect(isNavItemActive("/pulse", "/pulse")).toBe(true);
    expect(isNavItemActive("/pulse", "/pulse/diag/dc")).toBe(true);
    expect(isNavItemActive("/people", "/people/alice")).toBe(true);
    expect(isNavItemActive("/overview", "/overview")).toBe(true);
  });

  it("never marks a sibling that merely shares a prefix", () => {
    expect(isNavItemActive("/pulse", "/pulseX")).toBe(false);
    expect(isNavItemActive("/overview", "/people")).toBe(false);
    expect(isNavItemActive("/server", "/")).toBe(false);
  });
});

// The route tree is GENERATED from the files in src/routes (the TanStack
// router vite plugin), so a route file that was moved, renamed or lost
// shows up here as a missing path. Checking the generated artifact rather
// than importing it keeps this test from pulling every route module — and
// with them CodeMirror and the whole app — into a unit run.
describe("the generated route tree", () => {
  const tree = readFileSync(join(process.cwd(), "src", "routeTree.gen.ts"), "utf8");

  it("carries a route for every navigation target", () => {
    for (const { to } of SECTIONS) {
      expect(tree, to).toContain(`path: '${to}'`);
    }
  });

  it("keeps the Details drill-down under Пульс, where the hub links to it", () => {
    // The generated tree spells a nested path relative to its parent
    // (`/diag/$domain` under `/pulse`) and the resolved one in its route
    // maps — both have to be there for the hub's links to resolve.
    expect(tree).toContain("path: '/diag/$domain'");
    expect(tree).toContain("'/pulse/diag/$domain'");
  });

  it("still resolves the pre-M4 /pulse bookmark — now to the hub", () => {
    // No redirect exists on purpose: /pulse did not change meaning so much
    // as gain a landing screen, and the dashboard it used to show carried
    // no deep-link state to carry over (its editor is component state).
    expect(tree).toContain("path: '/pulse'");
    expect(tree).toContain("AuthedPulseIndexRoute");
  });
});
