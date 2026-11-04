import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon } from "./Icon";

type Option = { value: string; label: string; disabled?: boolean };

// Use the browser's top layer so rounded options are never clipped by the picker or scene panels
export function AssetFilterSelect({
  value,
  options,
  onChange,
  icon,
}: {
  value: string;
  options: readonly Option[];
  onChange: (value: string) => void;
  icon?: ReactNode;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Return keyboard focus to the field after a choice or cancellation
  function close() {
    menu.current?.hidePopover();
    trigger.current?.focus();
  }

  function expand() {
    const bounds = trigger.current!.getBoundingClientRect();
    const width = Math.min(Math.max(bounds.width, 220), innerWidth - 24);
    const below = innerHeight - bounds.bottom - 12;
    const above = bounds.top - 12;
    const upwards = below < 300 && above > below;
    const height = Math.min(300, upwards ? above : below);

    // Attach directly to the field and flip upwards only when the viewport needs it
    Object.assign(menu.current!.style, {
      left: `${Math.min(bounds.left, innerWidth - width - 12)}px`,
      top: `${upwards ? bounds.top - height : bounds.bottom}px`,
      width: `${width}px`,
      maxHeight: `${height}px`,
    });
    menu.current?.showPopover();

    // Focus immediately so fast arrow-key navigation never waits for a delayed toggle event
    const selected = menu.current?.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]:not(:disabled)',
    );
    (selected ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    // Allow scrolling inside the options while closing on movement of the surrounding picker
    const dismiss = () => menu.current?.hidePopover();
    const scroll = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) {
        dismiss();
      }
    };
    addEventListener("resize", dismiss);
    addEventListener("scroll", scroll, true);
    return () => {
      removeEventListener("resize", dismiss);
      removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  function keyboard(event: KeyboardEvent) {
    // Escape belongs to this menu first; a second Escape can dismiss the asset library
    if (event.key === "Escape" && menu.current?.matches(":popover-open")) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!menu.current?.matches(":popover-open")) {
        expand();
        return;
      }

      // Skip unavailable categories and wrap focus without changing the active filter until selection
      const choices = [
        ...menu.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      ];
      const current = choices.findIndex((choice) => choice === document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? choices.length - 1
            : (current + (event.key === "ArrowUp" ? -1 : 1) + choices.length) % choices.length;
      choices[next]?.focus();
    } else if (event.key === "Tab") {
      // Let normal Tab navigation continue after dismissing the top-layer menu
      menu.current?.hidePopover();
    }
  }

  return (
    <span className="asset-filter" onKeyDownCapture={keyboard}>
      <button
        ref={trigger}
        className="asset-filter-trigger"
        type="button"
        role="combobox"
        aria-label="Filter assets"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="listbox"
        onClick={() => (menu.current?.matches(":popover-open") ? close() : expand())}
      >
        {options.find((option) => option.value === value)?.label}
        {icon ?? <Icon name="caretSolid" />}
      </button>
      <div
        ref={menu}
        id={id}
        className="asset-filter-menu"
        popover="auto"
        role="listbox"
        aria-label="Filter assets"
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            disabled={option.disabled}
            tabIndex={-1}
            onClick={() => {
              onChange(option.value);
              close();
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </span>
  );
}
