import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { PeopleList } from "../../../people/PeopleList";
import { useIsDesktop } from "../../../server/useIsDesktop";

// Layout for /people and /people/$username — the `_authed` guard already
// covers auth for the whole subtree.
//
// It also owns the desktop/mobile split for the детали: from `lg:` up the
// prototype keeps the list on screen and shows the selected person in the
// Инспектор panel beside it, so this route renders <PeopleList> itself and
// hands it the child route's username. Doing the switch here (rather than
// inside the $username route component) keeps ONE PeopleList instance
// mounted across selections — its search text, filter and scroll position
// survive clicking from person to person, which a remount would throw away.
// Below `lg:` nothing changes: the child routes render as usual, the index
// as the list and $username as the full-screen detail.
//
// Why a JS breakpoint (useIsDesktop) and not `hidden lg:block` / `lg:hidden`:
// a CSS split has to render BOTH branches. At /people that means two live
// PeopleList instances (the layout's and the index route's) — duplicate
// rows, duplicate data-testids; at /people/$username it means mounting the
// full PersonDetail on a desktop where the Инспектор already shows the same
// user, which re-runs SublinkPanel and generates a QR per connection link
// purely to keep it hidden. useIsDesktop is a useSyncExternalStore over
// matchMedia, so it only re-renders when the viewport actually crosses
// 1024px, and it renders exactly one of the two.
export const Route = createFileRoute("/_authed/people")({
  component: PeopleSection,
});

function PeopleSection() {
  const isDesktop = useIsDesktop();
  // strict:false — /people/ has no `username` param at all, so this is a
  // deliberately loose read of "the child route's param, if there is one".
  const params = useParams({ strict: false }) as { username?: string };

  if (isDesktop) return <PeopleList selectedUsername={params.username ?? null} />;
  return <Outlet />;
}
