import type { ReactNode } from "react";
import { Sheet } from "../../../ui/Sheet";
import { placementFor, useLayoutModeStub } from "./useLayoutModeStub";

export interface AdaptiveDetailSurfaceProps {
  open: boolean;
  onClose: () => void;
  /** Entity identity — the surface's accessible name. */
  title: string;
  /** Status / context line under the title. */
  subtitle?: ReactNode;
  children: ReactNode;
}

// AdaptiveDetailSurface is the ONE surface an EntityList/Ranking row opens
// (§17). It is a thin adapter over ui/Sheet rather than a second dialog
// implementation, so it inherits the focus trap, `aria-modal`, the close
// button, backdrop dismissal, the background-scroll lock and — the part
// §17 calls out explicitly — the return of focus to the row that opened it
// when the surface closes.
//
// Escape closes it, and the visible close button is the non-gesture
// equivalent §16.1 requires.
export function AdaptiveDetailSurface({
  open,
  onClose,
  title,
  subtitle,
  children,
}: AdaptiveDetailSurfaceProps) {
  const layout = useLayoutModeStub();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      placement={placementFor(layout)}
      {...(subtitle !== undefined ? { subtitle } : {})}
    >
      {children}
    </Sheet>
  );
}
