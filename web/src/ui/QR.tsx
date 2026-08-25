import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { cn } from "../lib/cn";
import { Skeleton } from "./Skeleton";

export interface QRProps {
  value: string;
  size?: number;
  className?: string;
}

// QR — local QR code generation (the `qrcode` package: pure JS, no CDN, no
// network — 06-ui.md requires this for the sub-link/Telegram-connect QR
// shown on the user detail screen and the public subscription page).
export function QR({ value, size = 200, className }: QRProps) {
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Deliberately doesn't reset svg to null before the async call: the
    // previous code briefly regenerates the same-looking QR (value/size
    // rarely change on a live screen), and this component isn't the
    // place to decide "regenerating" UI — keeping the last frame visible
    // until the new one is ready reads better than a flash to skeleton.
    QRCode.toString(value, { type: "svg", margin: 1, width: size })
      .then((markup) => {
        if (!cancelled) setSvg(markup);
      })
      .catch(() => {
        if (!cancelled) setSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!svg) {
    return (
      <Skeleton
        className={cn("aspect-square", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      className={cn("inline-block rounded-lg bg-white p-2", className)}
      style={{ width: size + 16, height: size + 16 }}
      // qrcode's SVG output is generated locally from `value` we control —
      // no user-supplied HTML ever flows through this.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
