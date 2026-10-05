import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { logoutMutation } from "../lib/api/generated/@tanstack/react-query.gen";
import { resetSSEClient } from "../realtime";
import { useStrings } from "../i18n";
import { apiErrorMessage } from "../people/apiError";
import { pushToast } from "../ui/Toast";

// useLogout is the one place POST /api/auth/logout is called from: clears
// every cached query (session-scoped data must not survive into the next
// login), resets the SSE client and returns to /login after durable revoke.
// A failure retains the authenticated state so logout can be retried.
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const strings = useStrings();

  return useMutation({
    ...logoutMutation(),
    onSuccess: async () => {
      resetSSEClient();
      queryClient.clear();
      await router.navigate({ to: "/login" });
    },
    onError: (error) => pushToast(apiErrorMessage(error, strings), "error"),
  });
}
