import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi, afterEach } from "vitest";
import { TlsSourceNotice } from "./TlsSourceNotice";
import type { TlsFingerprintsState } from "./tlsFingerprints.helpers";
import { ru } from "../../i18n";
import { tlsFingerprints } from "../details-builder/__fixtures__";

function renderInto(node: React.ReactElement): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

function notice(state: TlsFingerprintsState, as: "note" | "card" = "note", refetch = () => {}) {
  return <TlsSourceNotice state={{ ...state, refetch }} as={as} />;
}

describe("TlsSourceNotice", () => {
  it("renders nothing while loading or when data is present", () => {
    mounted = renderInto(notice({ status: "loading" }));
    expect(mounted.container.textContent).toBe("");
    act(() => mounted!.root.unmount());
    mounted.container.remove();

    mounted = renderInto(
      notice({ status: "ok", data: tlsFingerprints, stale: false, updatedAt: 0 }),
    );
    expect(mounted.container.textContent).toBe("");
  });

  it("renders the runtime_edge hint when the capability is switched off", () => {
    mounted = renderInto(notice({ status: "disabled", reason: "feature_disabled" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain(ru.gated.disabledPrefix);
    expect(text).toContain("feature_disabled");
    expect(text).toContain(ru.gated.hints.runtime_edge);
  });

  it("points at a Telemt update instead of a setting when the build lacks the route", () => {
    // Ruling R5: unsupported is not the same state as disabled. Telling an
    // operator to flip runtime_edge_enabled on a build that never had the
    // route would send them looking for a setting they do not have.
    mounted = renderInto(notice({ status: "unsupported" }));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain(ru.gated.unsupportedPrefix);
    expect(text).toContain(ru.gated.hints.telemt_outdated);
    expect(text).not.toContain(ru.gated.hints.runtime_edge);
    expect(text).not.toContain(ru.gated.disabledPrefix);
  });

  it("renders a localized error with a retry when the source is broken", () => {
    // The regression this guards: both Security pages previously handled
    // only the gated branch, so an unreachable Telemt made the four TLS
    // sections vanish without a word.
    const refetch = vi.fn();
    mounted = renderInto(notice({ status: "error", code: "telemt_unreachable" }, "note", refetch));
    const text = mounted.container.textContent ?? "";
    expect(text).toContain(ru.errors.telemt_unreachable);

    const button = mounted.container.querySelector("button");
    expect(button).not.toBeNull();
    act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("shows no untranslated English prose in any state", () => {
    // The panel's own error `message` is English (telemt_tls_handler.go);
    // nothing here may print it. Latin letters are allowed only where a
    // config key is deliberately quoted (runtime_edge_enabled).
    for (const state of [
      { status: "disabled" } as const,
      { status: "unsupported" } as const,
      { status: "error", code: "telemt_unreachable" } as const,
    ]) {
      const view = renderInto(notice(state));
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("telemt build");
      expect(text).not.toContain("does not expose");
      act(() => view.root.unmount());
      view.container.remove();
    }
  });

  it("uses the standalone card on the Сервер screen and the inline note elsewhere", () => {
    const card = renderInto(notice({ status: "disabled" }, "card"));
    const cardHtml = card.container.innerHTML;
    act(() => card.root.unmount());
    card.container.remove();

    mounted = renderInto(notice({ status: "disabled" }, "note"));
    // caps/Gated is a surface card with an icon; GatedNote is a recessed
    // block without one — enough of a difference to prove the switch works.
    expect(cardHtml).toContain("<svg");
    expect(mounted.container.innerHTML).not.toContain("<svg");
  });
});
