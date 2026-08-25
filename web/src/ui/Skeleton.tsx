import type { CSSProperties } from "react";
import { cn } from "../lib/cn";

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
}

// Skeleton — loading placeholder block. Every screen's "loading" state
// (06-ui.md's mandatory per-screen states) composes these rather than
// showing a spinner.
export function Skeleton({ className, style }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface-2", className)}
      style={style}
      aria-hidden="true"
    />
  );
}
