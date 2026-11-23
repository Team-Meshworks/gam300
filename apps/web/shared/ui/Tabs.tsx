export function Tabs<T extends string>({
  id,
  label,
  items,
  value,
  onChange,
}: {
  id: string;
  label: string;
  items: readonly { value: T; label: string; measureLabel?: string | undefined }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="sp-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          id={`${id}-${item.value}`}
          aria-controls={`${id}-panel`}
          aria-selected={item.value === value}
          tabIndex={item.value === value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + items.length) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : undefined;
            const selected = next === undefined ? undefined : items[next];
            if (!selected) return;
            event.preventDefault();
            onChange(selected.value);
            const target = document.getElementById(`${id}-${selected.value}`);
            target?.focus();
            const strip = event.currentTarget.parentElement;
            if (target && strip) {
              const tab = target.getBoundingClientRect();
              const bounds = strip.getBoundingClientRect();
              if (tab.left < bounds.left) strip.scrollLeft += tab.left - bounds.left;
              else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right;
            }
          }}
        >
          <span className="sp-tab-content">
            <span>{item.label}</span>
            <span className="sp-tab-measure" aria-hidden="true">
              {item.measureLabel ?? item.label}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
