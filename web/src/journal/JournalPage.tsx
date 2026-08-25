import { useState } from "react";
import { cn } from "../lib/cn";
import { ru } from "../i18n/ru";
import { LogsTab } from "./LogsTab";
import { EventsTab } from "./EventsTab";

type JournalTab = "logs" | "events";

// JournalPage — /journal (06-ui.md §Журнал): live logs by default, plus a
// "События" tab for the panel's own audit ring (Task 7 deliverable D).
// Local tab state, not nested routes — 06-ui.md describes this as one
// screen with an internal source/tab switcher, matching the People and
// Пульс screens' own header controls rather than a route-per-tab.
export function JournalPage() {
  const [tab, setTab] = useState<JournalTab>("logs");

  return (
    <div className="flex flex-col gap-3">
      <div
        className="inline-flex w-fit rounded-lg border border-border bg-surface-2 p-0.5"
        role="tablist"
        aria-label={ru.nav.journal}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "logs"}
          onClick={() => setTab("logs")}
          className={cn(
            "tap-target rounded-md px-4 text-sm font-medium transition-colors",
            tab === "logs" ? "bg-accent text-accent-text" : "text-text-muted hover:text-text",
          )}
        >
          {ru.journal.tabs.logs}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "events"}
          onClick={() => setTab("events")}
          className={cn(
            "tap-target rounded-md px-4 text-sm font-medium transition-colors",
            tab === "events" ? "bg-accent text-accent-text" : "text-text-muted hover:text-text",
          )}
        >
          {ru.journal.tabs.events}
        </button>
      </div>

      {tab === "logs" ? <LogsTab /> : <EventsTab />}
    </div>
  );
}
