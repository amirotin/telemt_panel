import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

// Guard for the premise the StrictMode-effect tests in this repo depend on
// (context.test.tsx, journal/useLogStream.test.tsx): that React's
// development build — which double-invokes an effect (run, cleanup, run
// again) on the initial mount of a <StrictMode> subtree — is actually what
// this vitest/jsdom setup runs, not the production build (which skips the
// double-invoke entirely and would make every "despite StrictMode's
// double-invoked effects" assertion in those files pass vacuously no
// matter what the code under test does).
//
// If this test ever starts failing (mount/cleanup/mount collapses to a
// single run), assume a resolution change silently pulled in React's
// production build for tests — vite.config.ts's `test` block, or a
// dependency's `resolve.conditions`/`package.json#exports` — and treat every
// StrictMode-labeled test in this repo as no longer proving anything until
// it's fixed.
describe("React StrictMode + development build (test harness assumption)", () => {
  it("double-invokes an effect (mount, cleanup, mount) on initial StrictMode mount", () => {
    const calls: string[] = [];
    function Probe() {
      useEffect(() => {
        calls.push("mount");
        return () => {
          calls.push("cleanup");
        };
      }, []);
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });

    expect(calls).toEqual(["mount", "cleanup", "mount"]);

    act(() => root.unmount());
    container.remove();
  });
});
