import { useState } from "react";
import { useStrings } from "../i18n";
import { IconActivity, IconJournal } from "../ui/icons";
import { LogsTab } from "./LogsTab";
import { ActionsTab } from "./EventsTab";

type JournalTab = "logs" | "actions";

const TABS: JournalTab[] = ["logs", "actions"];

// Both panes stay mounted while the internal tab changes: the Logs pane
// owns a live EventSource and an in-memory ring that must survive a quick
// look at the administrative action history.
export function JournalPage() {
  const s = useStrings();
  const [tab, setTab] = useState<JournalTab>("logs");

  return (
    <div className="journal-page">
      <section className="journal-surface">
        <header className="journal-app-head">
          <span className="journal-app-icon" aria-hidden="true">
            <IconJournal />
          </span>
          <div>
            <span>{s.journal.eyebrow}</span>
            <h1>{s.nav.journal}</h1>
          </div>
        </header>

        <div className="journal-tabs" role="tablist" aria-label={s.nav.journal}>
          {TABS.map((id) => {
            const Glyph = id === "logs" ? IconActivity : IconJournal;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "is-active" : undefined}
                onClick={() => setTab(id)}
              >
                <Glyph aria-hidden="true" />
                <span>
                  <strong>{s.journal.tabs[id]}</strong>
                  <small>{s.journal.tabDescriptions[id]}</small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="journal-pane-host" hidden={tab !== "logs"}>
          <LogsTab />
        </div>
        <div className="journal-pane-host" hidden={tab !== "actions"}>
          <ActionsTab />
        </div>
      </section>
    </div>
  );
}
