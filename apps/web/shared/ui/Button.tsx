import { updatePlainHover } from "./plain-control-hover";
import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  children,
  onPointerOver,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "quiet" }) {
  return (
    <button
      {...props}
      type={type}
      className={`sp-button sp-button--${variant} ${className}`}
      onPointerOver={
        variant === "quiet"
          ? (event) => {
              onPointerOver?.(event);
              updatePlainHover(event.target);
            }
          : onPointerOver
      }
    >
      {typeof children === "string" || typeof children === "number" ? (
        <span className="sp-button-label">{children}</span>
      ) : (
        children
      )}
    </button>
  );
}
