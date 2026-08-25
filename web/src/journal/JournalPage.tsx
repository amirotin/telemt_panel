import { useState } from "react";
import { useStrings } from "../i18n";
import { Chip } from "../ui/Chip";
import { LogsTab } from "./LogsTab";
import { EventsTab } from "./EventsTab";

type JournalTab = "logs" | "events";

const TABS: JournalTab[] = ["logs", "events"];

// JournalPage — /journal (06-ui.md §Журнал): live logs by default, plus a
// "События" tab for the panel's own audit ring (Task 7 deliverable D).
// Local tab state, not nested routes — 06-ui.md describes this as one
// screen with an internal source/tab switcher, matching the People and
// Пульс screens' own header controls rather than a route-per-tab.
export function JournalPage() {
  const s = useStrings();
  const [tab, setTab] = useState<JournalTab>("logs");

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-title font-extrabold tracking-tight text-text">
        {s.nav.journal}
      </h1>

      {/*
        Chip is the app's one segmented-control language (D1), so the tab
        strip is built from it rather than a second pill implementation.
        `aria-pressed={undefined}` clears Chip's own toggle-button semantics:
        a role="tab" carries aria-selected instead, and having both would be
        an invalid combination for assistive tech.
      */}
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="tablist"
        aria-label={s.nav.journal}
      >
        {TABS.map((id) => (
          <Chip
            key={id}
            role="tab"
            aria-pressed={undefined}
            aria-selected={tab === id}
            active={tab === id}
            onClick={() => setTab(id)}
          >
            {s.journal.tabs[id]}
          </Chip>
        ))}
      </div>

      {/*
        Both tabs stay mounted at all times, toggled via the native `hidden`
        attribute rather than a conditional render — LogsTab owns a live SSE
        stream (useLogStream) plus the in-memory ring/pause/filter state
        (journalReducer), all of which unmounting-and-remounting on every
        tab switch would silently drop: switching to «События» and back used
        to reopen a brand-new EventSource and reset the ring to empty. Each
        of LogsTab/EventsTab is still only ever mounted once for the
        JournalPage's lifetime (one `useEffect([service])` run in
        useLogStream), so this can't create a second concurrent
        EventSource — see LogList.test.tsx's sibling
        `useLogStream.test.tsx` for the one-EventSource-per-mount guarantee
        this relies on.
      */}
      <div hidden={tab !== "logs"}>
        <LogsTab />
      </div>
      <div hidden={tab !== "events"}>
        <EventsTab />
      </div>
    </div>
  );
}
