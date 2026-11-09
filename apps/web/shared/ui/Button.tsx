import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return (
    <button {...props} type={type} className={`sp-button sp-button--${variant} ${className}`}>
      {typeof children === "string" || typeof children === "number" ? (
        <span className="sp-button-label">{children}</span>
      ) : (
        children
      )}
    </button>
  );
}
