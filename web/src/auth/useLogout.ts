import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { logoutMutation } from "../lib/api/generated/@tanstack/react-query.gen";
import { resetSSEClient } from "../realtime";

// useLogout is the one place POST /api/auth/logout is called from: clears
// every cached query (session-scoped data must not survive into the next
// login), resets the SSE client (deliverable A: "logout action clears
// client state and SSE"), and returns to /login — via onSettled, not
// onSuccess, so a network failure still leaves the client in a clean local
// state rather than stuck mid-logout.
export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    ...logoutMutation(),
    onSettled: async () => {
      resetSSEClient();
      queryClient.clear();
      await router.navigate({ to: "/login" });
    },
  });
}
