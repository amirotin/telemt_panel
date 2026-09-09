import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../lib/api/generated/types.gen";
import { IconDesktop, IconDevice } from "../../ui/icons";
import { SessionIcon } from "./SessionIcon";

describe("SessionIcon", () => {
  it.each(["iPhone", "IPAD", "android", "Chrome · Linux", undefined])(
    "preserves device icon, current-session tone and decorative semantics for %s",
    (label) => {
      for (const current of [true, false]) {
        const session: SessionInfo = {
          id: "s1", created: "2026-09-09T00:00:00Z", last_seen: "2026-09-09T00:00:00Z",
          current, user_agent_label: label,
        };
        const markup = renderToStaticMarkup(<SessionIcon session={session} />);
        expect(markup).toContain('aria-hidden="true"');
        expect(markup).toContain("h-9 w-9 shrink-0");
        expect(markup).toContain(current ? "bg-ok/12 text-ok" : "bg-accent/10 text-accent");
        expect(markup).toContain(renderToStaticMarkup(
          label === "iPhone" || label === "IPAD" || label === "android" ? <IconDevice /> : <IconDesktop />,
        ));
      }
    },
  );
});
