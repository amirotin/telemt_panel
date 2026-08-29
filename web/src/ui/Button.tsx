import type { ButtonHTMLAttributes, ReactNode } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonStyles";

export type { ButtonSize, ButtonVariant };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** "sm" is the 38-40px compact row the inspector/panel action rows use. */
  size?: ButtonSize;
  children: ReactNode;
}

// Button is the single interactive-button primitive — min 44x44 touch
// target (tap-target utility, styles/index.css) is enforced here, not left
// to callers, per 06-ui.md. `size="sm"` opts a control out of that floor
// only inside a dense panel row where the prototype itself uses 38-40px
// (Инспектор's Копировать/QR/Перевыпуск triple).
//
// The classes themselves live in ./buttonStyles, so a router <Link> that has
// to look like a button wears exactly the same recipe (buttonClasses).
export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
