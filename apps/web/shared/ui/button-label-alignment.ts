import { textBounds } from "./plain-control-hover";

export function observeButtonLabelAlignment(root: HTMLElement) {
  if (
    root.classList.contains("sp-shell--facilitator") ||
    root.classList.contains("sp-shell--creator")
  )
    return;
  const admin = root.dataset.accountRole === "Administrator";
  const labelSelector = admin
    ? ".sp-button-label, button .sp-plain-label, .sp-tab-content > span:first-child, [data-control-label]"
    : ".sp-button-label";
  let active = true;
  let frame: number | undefined;
  const adjusted = new WeakSet<HTMLElement>();
  const measured = new WeakMap<HTMLElement, string>();
  const watchedLabels = new Set<HTMLElement>();
  let fontsVersion = 0;
  const options = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-selected", "aria-pressed", "disabled"],
  };
  const schedule = () => {
    if (!active || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      refresh();
    });
  };
  const mutations = new MutationObserver(schedule);
  function refresh() {
    if (!active) return;
    mutations.disconnect();
    for (const label of watchedLabels) {
      if (!root.contains(label)) {
        resize.unobserve(label);
        watchedLabels.delete(label);
      }
    }
    for (const label of root.querySelectorAll<HTMLElement>(labelSelector)) {
      const control = label.closest<HTMLElement>("button, a");
      if (
        !control ||
        (!admin && (control.matches(".sp-button--quiet") || control.closest(".sp-tabs")))
      )
        continue;
      if (!watchedLabels.has(label)) {
        resize.observe(label);
        watchedLabels.add(label);
      }
      const box = control.getBoundingClientRect();
      if (!box.height || !label.textContent?.trim()) continue;
      const style = getComputedStyle(label);
      const parentStyle = getComputedStyle(control);
      const signature = [
        fontsVersion,
        window.devicePixelRatio,
        label.textContent,
        style.font,
        style.letterSpacing,
        style.textBoxEdge,
        style.textBoxTrim,
        style.top,
        style.position,
        style.marginTop,
        style.marginBottom,
        parentStyle.paddingTop,
        parentStyle.paddingBottom,
        parentStyle.alignItems,
        box.height,
        label.getBoundingClientRect().height,
        (label as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1,
      ].join("|");
      if (measured.get(label) === signature) continue;
      label.style.translate = "none";
      const centreOnCapital = admin && control.matches("button, a.sp-button, a[role=button]");
      const bounds = textBounds(
        label,
        !centreOnCapital,
        true,
        window.devicePixelRatio || 1,
        centreOnCapital ? "C" : undefined,
      );
      const zoom = (label as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
      const offset = (box.top + box.bottom - bounds.top - bounds.bottom) / (2 * zoom);
      if (Number.isFinite(offset)) {
        label.style.translate = "0 " + offset.toFixed(3) + "px";
        adjusted.add(label);
        measured.set(label, signature);
      }
    }
    mutations.observe(root, options);
  }
  const resize = new ResizeObserver(schedule);
  resize.observe(root);
  let densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const densityChanged = () => {
    densityQuery.removeEventListener("change", densityChanged);
    densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    densityQuery.addEventListener("change", densityChanged);
    schedule();
  };
  densityQuery.addEventListener("change", densityChanged);
  window.addEventListener("resize", schedule);
  const fontsChanged = () => {
    fontsVersion++;
    schedule();
  };
  document.fonts.addEventListener("loadingdone", fontsChanged);
  refresh();
  void document.fonts.ready.then(fontsChanged);
  return () => {
    active = false;
    mutations.disconnect();
    resize.disconnect();
    watchedLabels.clear();
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    densityQuery.removeEventListener("change", densityChanged);
    document.fonts.removeEventListener("loadingdone", fontsChanged);
    for (const label of root.querySelectorAll<HTMLElement>(labelSelector)) {
      if (adjusted.has(label)) label.style.removeProperty("translate");
    }
  };
}
