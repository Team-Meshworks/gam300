import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return (
    <button {...props} type={type} className={`sp-button sp-button--${variant} ${className}`} />
  );
}
