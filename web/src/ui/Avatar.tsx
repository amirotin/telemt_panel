import { cn } from "../lib/cn";
import { avatarHue, avatarInitial } from "./avatar.helpers";

export type AvatarTone = "hue" | "idle" | "alert";
export type AvatarSize = "sm" | "md" | "lg";

export interface AvatarProps {
  /** The identity the initial and the hue are derived from (a username). */
  name: string;
  size?: AvatarSize;
  /**
   * "hue" (default) — the deterministic per-name gradient; "idle" — the flat
   * offline chip; "alert" — the red wash the prototype uses for a user who
   * needs attention (quota exhausted / expired).
   */
  tone?: AvatarTone;
  /** Renders the green presence dot on the bottom-right corner. */
  online?: boolean;
  /**
   * Color the presence dot's ring is punched out of — it must match the
   * surface the avatar sits on (page rows: "bg", panel cards: "surface").
   */
  ringOn?: "bg" | "surface";
  className?: string;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  sm: "h-9 w-9 text-[13px]",
  md: "h-[46px] w-[46px] text-[16px]",
  lg: "h-[52px] w-[52px] text-[17px]",
};

const DOT_CLASSES: Record<AvatarSize, string> = {
  sm: "h-2.5 w-2.5 border-2",
  md: "h-3 w-3 border-[2.5px]",
  lg: "h-3.5 w-3.5 border-[2.5px]",
};

// Avatar — the identity chip the People list, inspector and action sheet
// all lead with (prototype §Люди): an initial on a deterministic gradient
// plus an optional presence dot. It is decorative by design — the
// accessible name is always the username text rendered beside it — so the
// element is aria-hidden and carries no title.
export function Avatar({
  name,
  size = "lg",
  tone = "hue",
  online = false,
  ringOn = "bg",
  className,
}: AvatarProps) {
  const hue = avatarHue(name);
  const background =
    tone === "hue"
      ? `linear-gradient(135deg, rgb(var(--avatar-${hue}-from)), rgb(var(--avatar-${hue}-to)))`
      : tone === "alert"
        ? "rgb(var(--avatar-alert-bg))"
        : "rgb(var(--avatar-idle-bg))";
  const color =
    tone === "hue"
      ? "rgb(var(--avatar-text))"
      : tone === "alert"
        ? "rgb(var(--avatar-alert-text))"
        : "rgb(var(--avatar-idle-text))";

  return (
    <span className={cn("relative inline-flex shrink-0", className)} aria-hidden="true">
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full font-bold leading-none",
          SIZE_CLASSES[size],
        )}
        style={{ background, color }}
      >
        {avatarInitial(name)}
      </span>
      {online && (
        <span
          className={cn(
            "absolute bottom-0 right-0 rounded-full bg-ok",
            DOT_CLASSES[size],
            ringOn === "surface" ? "border-surface" : "border-bg",
          )}
        />
      )}
    </span>
  );
}
