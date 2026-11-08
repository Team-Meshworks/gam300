import { Icon as UiIcon } from "@iconify/react/offline";
import faMagnifyingGlass from "@iconify-icons/lucide/search";
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
    <label className="sp-search">
      <span className="sp-sr-only">{label}</span>
      <input
        type="search"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? label}
      />
      {icon ?? <UiIcon icon={faMagnifyingGlass} aria-hidden="true" />}
    </label>
  );
}
