import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: originalClipboard,
    configurable: true,
  });
  document.execCommand = originalExecCommand;
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the Clipboard API when it succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const result = await copyText("hello");

    expect(result).toBe("clipboard");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.execCommand = vi.fn().mockReturnValue(true);

    const result = await copyText("hello");

    expect(result).toBe("execCommand");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    // The scratch textarea must not leak into the document.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
      configurable: true,
    });
    document.execCommand = vi.fn().mockReturnValue(true);

    const result = await copyText("hello");

    expect(result).toBe("execCommand");
  });

  it("reports failure when both mechanisms are unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.execCommand = vi.fn().mockReturnValue(false);

    const result = await copyText("hello");

    expect(result).toBe("failed");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand throws", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error("not implemented");
    });

    const result = await copyText("hello");

    expect(result).toBe("failed");
  });
});
