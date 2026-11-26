import { Icon } from "@iconify/react/offline";
import selectIcon from "@iconify-icons/lucide/list-checks";
import { Button } from "./Button";

export function SelectionToggle({
  selected,
  label,
  title,
  disabled,
  className = "",
  onClick,
}: {
  selected: boolean;
  label: string;
  title: string;
  disabled?: boolean | undefined;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      className={`sp-selection-toggle${className ? ` ${className}` : ""}`}
      aria-pressed={selected}
      aria-label={selected ? "Cancel selection" : label}
      title={selected ? "Cancel selection" : title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon icon={selectIcon} aria-hidden="true" />
    </Button>
  );
}
