// Deterministic avatar identity (initial + hue) — the prototype's own
// scheme: a 32-bit string hash of the name modulo the hue count, so the
// same person keeps the same color on every device, every reload and every
// screen (list row, inspector header, action sheet) without the server
// ever storing one.

export const AVATAR_HUE_COUNT = 6;

/** A hue index in [0, AVATAR_HUE_COUNT). */
export type AvatarHue = 1 | 2 | 3 | 4 | 5 | 6;

// hashName is the prototype's `h = c + ((h << 5) - h)` (i.e. h*31 + c)
// walk, kept bit-for-bit so an avatar's color doesn't shift between the
// design reference and the app. `|0` keeps it in int32 like the original's
// implicit coercion; Math.abs then folds the sign away.
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (name.charCodeAt(i) + ((h << 5) - h)) | 0;
  }
  return Math.abs(h);
}

export function avatarHue(name: string): AvatarHue {
  return ((hashName(name) % AVATAR_HUE_COUNT) + 1) as AvatarHue;
}

// avatarInitial takes the first *letter or digit* rather than blindly
// name[0]: usernames may legally start with "." "_" or "-"
// (users.helpers.ts's USERNAME_PATTERN), and a tile showing "_" reads as
// broken. Falls back to the raw first character, then to "?" for an empty
// name, so this never returns an empty string.
export function avatarInitial(name: string): string {
  for (const ch of name) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return name.length > 0 ? name[0]! : "?";
}
