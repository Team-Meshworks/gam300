import { Icon as UiIcon } from "@iconify/react/offline";
import chevronDown from "@iconify-icons/lucide/chevron-down";
import check from "@iconify-icons/lucide/check";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

type Props = {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  showSelectedIcon?: boolean;
  placeholder?: string;
  className?: string;
  menuClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
};

// Keep menus in the top layer so dialog clipping cannot hide their options
// Focus stays on the combobox while arrow keys move its active option
export function Select({
  label,
  value,
  options,
  onChange,
  disabled,
  showSelectedIcon = true,
  placeholder = "Choose",
  className = "asset-admin-select",
  menuClassName = "asset-admin-select-menu",
  leading,
  trailing,
}: Props) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 200 });

  function expand() {
    if (disabled || options.length === 0) {
      return;
    }
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  }

  // Native popovers supply outside-click dismissal without an extra overlay or document listener
  useEffect(() => {
    if (open) {
      menu.current?.showPopover();
    } else if (menu.current?.matches(":popover-open")) {
      menu.current.hidePopover();
    }
  }, [open]);

  // A scroll from bringing the field into view can arrive just after its menu opens.
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const bounds = button.current!.getBoundingClientRect();
      if (bounds.bottom <= 0 || bounds.top >= innerHeight) {
        setOpen(false);
        return;
      }
      const height = Math.min(options.length * 36 + 18, 200);
      const below = innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const upwards = below < height && above > below;
      const maxHeight = Math.min(height, upwards ? above : below);
      setPosition({
        top: upwards ? bounds.top - maxHeight : bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        maxHeight,
      });
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) {
        reposition();
      }
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, options.length]);

  // Commit only a real option, then return keyboard focus to the field that opened the menu
  function choose(index: number) {
    const option = options[index];
    if (option) {
      onChange(option.value);
    }
    setOpen(false);
    button.current?.focus();
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape" && open) {
      // Close this menu before allowing Escape to reach the enclosing dialog
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    // Keep keyboard navigation on the combobox while the active descendant identifies its option
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        expand();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        choose(active);
        return;
      }
      setActive((current) =>
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (current + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length,
      );
    } else if (open && event.key.length === 1) {
      // Jump by the typed initial without turning the selector into an editable text field
      const next = options.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()),
      );
      if (next >= 0) {
        setActive(next);
      }
    }
  }

  return (
    <div className={className}>
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-labelledby={`${id}-label`}
        aria-controls={`${id}-menu`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled || options.length === 0}
        onKeyDown={keyDown}
        onClick={() => (open ? setOpen(false) : expand())}
      >
        {leading}
        <span>{options.find((option) => option.value === value)?.label ?? placeholder}</span>
        <UiIcon icon={chevronDown} width={16} height={16} aria-hidden="true" />
      </button>
      {trailing}
      <div
        ref={menu}
        id={`${id}-menu`}
        popover="auto"
        role="listbox"
        aria-labelledby={`${id}-label`}
        className={menuClassName}
        style={position}
        onToggle={(event) => {
          if (event.newState === "closed") {
            setOpen(false);
          }
        }}
      >
        {options.map((option, index) => (
          <button
            id={`${id}-${index}`}
            key={option.value}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={value === option.value}
            data-active={active === index}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(index)}
          >
            {option.label}
            {showSelectedIcon && value === option.value && (
              <UiIcon icon={check} width={16} height={16} aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
