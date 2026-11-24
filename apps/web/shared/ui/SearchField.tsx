import searchIcon from "./assets/search-field-icon.svg";
import type { ReactNode } from "react";

export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  disabled = false,
  icon,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div
      className="sp-search"
      onPointerDown={(event) => {
        if (event.button === 0 && !(event.target instanceof HTMLInputElement)) {
          event.currentTarget.querySelector("input")?.blur();
          event.preventDefault();
        }
      }}
    >
      <input
        type="search"
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? label}
      />
      {icon ?? (
        <span className="sp-search-icon" aria-hidden="true">
          <img src={searchIcon} alt="" />
        </span>
      )}
    </div>
  );
}
