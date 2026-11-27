import { act } from "react";
import { expect, vi } from "vitest";

// Query notifications can arrive after the first render of a confirmation.
export async function waitForEnabled(element: () => HTMLElement | null | undefined) {
  await vi.waitFor(async () => {
    await act(async () => {
      await Promise.resolve();
    });
    expect(element()?.matches(':disabled, [aria-disabled="true"]')).toBe(false);
  });
}
