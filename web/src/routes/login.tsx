import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { loginMutation } from "../lib/api/generated/@tanstack/react-query.gen";
import type { LoginError } from "../lib/api/generated/types.gen";
import { getMeQueryKey, redirectIfAuthenticated } from "../auth/guards";
import { safeRedirectTarget } from "../auth/safeRedirect";
import { ru, errorMessage, errorMessages } from "../i18n/ru";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search["redirect"] === "string" ? search["redirect"] : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    await redirectIfAuthenticated(context.queryClient, search.redirect);
  },
  component: LoginPage,
});

// LoginPage — username/password form (deliverable A): 16px inputs (Input's
// own floor), autocomplete attrs for password managers, submit disabled
// while pending, and every documented failure mode turned into a Russian
// sentence (invalid credentials, rate_limited with a retry hint baked into
// its message, bad_request, and a synthesized "network" message when fetch
// itself never got a response at all).
function LoginPage() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    ...loginMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      // redirect came off the wire (a URL search param) — never navigate to
      // it raw, see auth/safeRedirect.ts.
      await router.navigate({ href: safeRedirectTarget(redirect) });
    },
    onError: (err: LoginError) => {
      setFormError(loginErrorMessage(err));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    mutation.mutate({ body: { username, password } });
  }

  const canSubmit = username.length > 0 && password.length > 0 && !mutation.isPending;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <h1 className="text-center text-xl font-semibold text-text">{ru.app.title}</h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1 text-sm text-text-muted">
          {ru.auth.username}
          <Input
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-muted">
          {ru.auth.password}
          <Input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {formError && (
          <p role="alert" className="text-sm text-error">
            {formError}
          </p>
        )}
        <Button type="submit" disabled={!canSubmit}>
          {mutation.isPending ? ru.auth.signingIn : ru.auth.signIn}
        </Button>
      </form>
    </main>
  );
}

function loginErrorMessage(err: LoginError | undefined): string {
  // A well-formed envelope error always has a non-empty `code` (openapi.yaml's
  // Error schema requires it); no `err` at all — or one that isn't shaped
  // like the envelope — means fetch itself never got a response (offline,
  // DNS, CORS), not a documented error code.
  if (!err || typeof err.code !== "string") return errorMessages["network"];
  return errorMessage(err.code);
}
