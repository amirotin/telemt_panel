import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { requireAuth, redirectIfAuthenticated } from "./guards";
import { getMe } from "../lib/api/generated/sdk.gen";

// getMe is the generated SDK call getMeOptions()'s queryFn wraps — mocked
// here so requireAuth/redirectIfAuthenticated can be tested without a real
// network round trip.
vi.mock("../lib/api/generated/sdk.gen", () => ({
  getMe: vi.fn(),
}));

const mockedGetMe = vi.mocked(getMe);

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("requireAuth", () => {
  it("resolves without redirecting when GET /api/auth/me succeeds", async () => {
    mockedGetMe.mockResolvedValue({
      data: { username: "admin", totp_enabled: false, passkeys: [] },
      request: new Request("http://x/api/auth/me"),
      response: new Response(null, { status: 200 }),
    });

    await expect(requireAuth(newQueryClient(), "/people")).resolves.toBeUndefined();
  });

  it("throws a redirect to /login with the current href on 401", async () => {
    mockedGetMe.mockRejectedValue({ code: "session_expired", message: "no valid session" });

    let caught: unknown;
    try {
      await requireAuth(newQueryClient(), "/pulse");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(isRedirect(caught)).toBe(true);
    const redirectErr = caught as { options: { to: string; search?: { redirect?: string } } };
    expect(redirectErr.options.to).toBe("/login");
    expect(redirectErr.options.search?.redirect).toBe("/pulse");
  });
});

describe("redirectIfAuthenticated", () => {
  it("does nothing when not authenticated (lets /login render)", async () => {
    mockedGetMe.mockRejectedValue({ code: "session_expired", message: "no valid session" });

    await expect(redirectIfAuthenticated(newQueryClient(), undefined)).resolves.toBeUndefined();
  });

  it("redirects to /people by default when already authenticated", async () => {
    mockedGetMe.mockResolvedValue({
      data: { username: "admin", totp_enabled: false, passkeys: [] },
      request: new Request("http://x/api/auth/me"),
      response: new Response(null, { status: 200 }),
    });

    let caught: unknown;
    try {
      await redirectIfAuthenticated(newQueryClient(), undefined);
    } catch (err) {
      caught = err;
    }

    expect(isRedirect(caught)).toBe(true);
    const redirectErr = caught as { options: { href?: string } };
    expect(redirectErr.options.href).toBe("/people");
  });

  it("redirects to the requested target when already authenticated", async () => {
    mockedGetMe.mockResolvedValue({
      data: { username: "admin", totp_enabled: false, passkeys: [] },
      request: new Request("http://x/api/auth/me"),
      response: new Response(null, { status: 200 }),
    });

    let caught: unknown;
    try {
      await redirectIfAuthenticated(newQueryClient(), "/server");
    } catch (err) {
      caught = err;
    }

    expect(isRedirect(caught)).toBe(true);
    const redirectErr = caught as { options: { href?: string } };
    expect(redirectErr.options.href).toBe("/server");
  });
});
