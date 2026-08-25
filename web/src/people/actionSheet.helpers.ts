import type { UsersTopicUser } from "../realtime/topics";

// actionSheet.helpers.ts — the action sheet's step model, kept out of the
// component file so the freezing rule below is unit-testable on its own
// (and so the module stays a pure component export for fast refresh).

// ActionSheetIntent lets a caller open the sheet straight at one step
// instead of at the menu — the `lg:` Инспектор's Сброс квоты / Отключить /
// Удалить buttons route through here so they run the exact same
// confirmation and mutation as the menu, with no second copy of either.
export type ActionSheetIntent =
  | "menu"
  | "share"
  | "qr"
  | "reset-quota"
  | "toggle-enabled"
  | "delete";

export type ActionSheetView =
  | { kind: "menu" }
  | { kind: "share" }
  | { kind: "qr" }
  | { kind: "confirm-delete" }
  | { kind: "confirm-reset-quota" }
  // nextEnabled is FROZEN at the moment the admin asked for the toggle,
  // never re-derived from the live user: the "users" topic pushes a new
  // snapshot every few seconds, and re-reading `user.enabled` during the
  // confirmation would let a push that lands mid-decision silently invert
  // the label, the danger styling AND the request payload under the
  // admin's finger.
  | { kind: "confirm-toggle-enabled"; nextEnabled: boolean }
  | { kind: "confirm-rotate-secret" }
  | { kind: "new-secret"; secret: string };

// intentToView resolves the caller's opening step. It takes `user` so the
// toggle intent can freeze nextEnabled the same way the in-sheet menu
// button does — the Инспектор's Отключить/Включить button remounts the
// sheet with a new `key`, so this runs exactly once per opening, at click
// time.
export function intentToView(
  intent: ActionSheetIntent,
  user: Pick<UsersTopicUser, "enabled"> | null,
): ActionSheetView {
  switch (intent) {
    case "share":
      return { kind: "share" };
    case "qr":
      return { kind: "qr" };
    case "reset-quota":
      return { kind: "confirm-reset-quota" };
    case "toggle-enabled":
      return { kind: "confirm-toggle-enabled", nextEnabled: !(user?.enabled ?? true) };
    case "delete":
      return { kind: "confirm-delete" };
    case "menu":
      return { kind: "menu" };
  }
}
