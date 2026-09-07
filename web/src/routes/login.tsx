import { useState, type FormEvent } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthMethodsOptions, loginMutation } from "../lib/api/generated/@tanstack/react-query.gen";
import type { LoginError } from "../lib/api/generated/types.gen";
import { webauthnLoginBegin, webauthnLoginFinish } from "../lib/api/generated/sdk.gen";
import { getMeQueryKey, redirectIfAuthenticated } from "../auth/guards";
import { safeRedirectTarget } from "../auth/safeRedirect";
import { errorMessage, useStrings, type Dict } from "../i18n";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import {
  loginCredentialToJSON,
  passkeysSupported,
  requestOptionsFromJSON,
} from "../auth/webauthn";

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
  const s = useStrings();
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secondFactorRequired, setSecondFactorRequired] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [secondFactor, setSecondFactor] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const methodsQuery = useQuery({ ...getAuthMethodsOptions(), staleTime: 30_000, retry: false });

  const mutation = useMutation({
    ...loginMutation(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      // redirect came off the wire (a URL search param) — never navigate to
      // it raw, see auth/safeRedirect.ts.
      await router.navigate({ href: safeRedirectTarget(redirect) });
    },
    onError: (err: LoginError) => {
      if (err?.code === "totp_required") {
        setSecondFactorRequired(true);
        setSecondFactor("");
        setFormError(null);
        return;
      }
      if (secondFactorRequired && err?.code === "invalid_credentials") {
        setFormError(s.auth.secondFactorInvalid);
        return;
      }
      setFormError(loginErrorMessage(err, s));
    },
  });

  const passkeyMutation = useMutation({
    mutationFn: async () => {
      const { data: begin } = await webauthnLoginBegin({ throwOnError: true });
      const credential = await navigator.credentials.get({
        publicKey: requestOptionsFromJSON(begin.public_key),
      });
      if (!(credential instanceof PublicKeyCredential)) throw new Error("passkey_cancelled");
      await webauthnLoginFinish({
        body: {
          flow_id: begin.flow_id,
          credential: loginCredentialToJSON(credential),
        },
        throwOnError: true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: getMeQueryKey() });
      await router.navigate({ href: safeRedirectTarget(redirect) });
    },
    onError: (error) => {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        setFormError(s.auth.passkeyCancelled);
        return;
      }
      setFormError(s.auth.passkeyFailed);
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    mutation.mutate({
      body: {
        username,
        password,
        ...(secondFactorRequired ? { totp: secondFactor.trim() } : {}),
      },
    });
  }

  const canSubmit =
    username.length > 0 &&
    password.length > 0 &&
    (!secondFactorRequired || secondFactor.trim().length > 0) &&
    !mutation.isPending;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[360px] flex-col justify-center gap-3.5 px-4 py-10">
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <span
          className="brand-gradient inline-flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold text-brand-text"
          aria-hidden="true"
        >
          T
        </span>
        <h1 className="mt-1 text-xl font-extrabold tracking-tight text-text">{s.app.title}</h1>
        <p className="text-meta text-text-muted">{s.auth.tagline}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2.5 rounded-2xl bg-surface p-4"
        noValidate
      >
        {formError && (
          <p
            role="alert"
            className="rounded-lg border border-error/30 bg-error/10 px-3 py-2.5 text-meta text-error"
          >
            {formError}
          </p>
        )}
        {secondFactorRequired ? (
          <>
            <div className="pb-1 text-center">
              <h2 className="text-[16px] font-bold text-text">{s.auth.secondFactorTitle}</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                {recoveryMode ? s.auth.recoveryCodeNote : s.auth.secondFactorNote}
              </p>
            </div>
            <label className="contents">
              <span className="sr-only">
                {recoveryMode ? s.auth.recoveryCode : s.auth.authenticatorCode}
              </span>
              <Input
                autoFocus
                name="totp"
                placeholder={recoveryMode ? s.auth.recoveryCode : s.auth.authenticatorCode}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                inputMode={recoveryMode ? "text" : "numeric"}
                maxLength={recoveryMode ? 64 : 6}
                value={secondFactor}
                onChange={(e) =>
                  setSecondFactor(
                    recoveryMode
                      ? e.target.value.toUpperCase()
                      : e.target.value.replace(/\D/g, "").slice(0, 6),
                  )
                }
                required
              />
            </label>
            <button
              type="button"
              className="min-h-10 self-center px-2 text-[12px] font-semibold text-accent hover:text-accent-strong"
              onClick={() => {
                setRecoveryMode((value) => !value);
                setSecondFactor("");
                setFormError(null);
              }}
            >
              {recoveryMode ? s.auth.useAuthenticatorCode : s.auth.useRecoveryCode}
            </button>
          </>
        ) : (
          <>
            <label className="contents">
              <span className="sr-only">{s.auth.username}</span>
              <Input
                name="username"
                placeholder={s.auth.username}
                autoComplete="username"
                autoCapitalize="off"
                autoCorrect="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="contents">
              <span className="sr-only">{s.auth.password}</span>
              <Input
                type="password"
                name="password"
                placeholder={s.auth.password}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
          </>
        )}
        <Button type="submit" disabled={!canSubmit} className="mt-1 w-full">
          {mutation.isPending ? s.auth.signingIn : s.auth.signIn}
        </Button>
        {!secondFactorRequired && methodsQuery.data?.passkey_available && passkeysSupported() && (
          <>
            <div className="flex items-center gap-3 py-0.5" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-faint">
                {s.auth.or}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              disabled={passkeyMutation.isPending || mutation.isPending}
              onClick={() => {
                setFormError(null);
                passkeyMutation.mutate();
              }}
            >
              {passkeyMutation.isPending ? s.auth.passkeySigningIn : s.auth.signInWithPasskey}
            </Button>
          </>
        )}
        {secondFactorRequired && (
          <Button
            type="button"
            variant="ghost"
            className="w-full text-[12px]"
            onClick={() => {
              mutation.reset();
              setSecondFactorRequired(false);
              setRecoveryMode(false);
              setSecondFactor("");
              setFormError(null);
            }}
          >
            {s.auth.changeAccount}
          </Button>
        )}
      </form>
    </main>
  );
}

function loginErrorMessage(err: LoginError | undefined, s: Dict): string {
  // A well-formed envelope error always has a non-empty `code` (openapi.yaml's
  // Error schema requires it); no `err` at all — or one that isn't shaped
  // like the envelope — means fetch itself never got a response (offline,
  // DNS, CORS), not a documented error code.
  if (!err || typeof err.code !== "string") return errorMessage(s, "network");
  return errorMessage(s, err.code);
}
