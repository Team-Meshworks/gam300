import type { ReactNode } from "react";

// Keep selected bands continuous beneath the native scrollbar
function connectSelectionBar(bar: HTMLDivElement | null) {
  const panel = bar?.parentElement;
  const list = panel?.querySelector<HTMLElement>(
    ":scope > .admin-progress-list, :scope > .sp-account-rows, :scope > .sp-teacher-student-list",
  );
  if (!bar || !panel || !list) return;
  let frame = 0;
  const paint = () => {
    frame = 0;
    panel.style.setProperty("--sp-selection-bar-height", bar.getBoundingClientRect().height + "px");
    if (bar.hidden) {
      list.style.removeProperty("background-image");
      return;
    }
    const bounds = list.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll<HTMLElement>(":scope > article"));
    const stops = ["transparent 0px"];
    for (const row of rows) {
      if (!row.querySelector(".sp-row-select-input:is(:checked, :hover:enabled)")) continue;
      const rect = row.getBoundingClientRect();
      const top = Math.max(0, rect.top - bounds.top);
      const bottom = Math.min(bounds.height, rect.bottom - bounds.top);
      if (bottom <= top) continue;
      stops.push(
        "transparent " + top + "px",
        "var(--sp-selection-row-active) " + top + "px",
        "var(--sp-selection-row-active) " + bottom + "px",
        "transparent " + bottom + "px",
      );
    }
    stops.push("transparent 100%");
    list.style.backgroundImage = "linear-gradient(to bottom, " + stops.join(", ") + ")";
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(bar);
  resize.observe(list);
  const mutation = new MutationObserver(schedule);
  mutation.observe(list, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "checked"],
  });
  mutation.observe(bar, { attributes: true, attributeFilter: ["hidden"] });
  const events = ["scroll", "pointerover", "pointerout", "change"];
  for (const event of events) list.addEventListener(event, schedule);
  paint();
  return () => {
    cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    for (const event of events) list.removeEventListener(event, schedule);
    list.style.removeProperty("background-image");
    panel.style.removeProperty("--sp-selection-bar-height");
  };
}

export function SelectionBar({
  className,
  label,
  hidden,
  children,
}: {
  className: string;
  label: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={"sp-admin-selection-bar " + className}
      ref={connectSelectionBar}
      hidden={hidden}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
