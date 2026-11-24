// Paint a compact highlight within the control's existing hit area. Labels can
// reserve extra width for other tab states, and SVGs can contain empty margins.
const controls = [
  ".sp-tabs button",
  ".sp-selection-toggle",
  ".sp-select-all-action",
  ".sp-csv-action",
  ".sp-view-details",
  ".admin-project-metadata a",
  ".sp-teacher-organisation-link",
  ".asset-admin-text-link",
  ".asset-admin-metadata > summary",
  ".sp-button--quiet",
  ".sp-published-qr",
  ".sp-cover-remove",
  ".sp-publication a[href]:not([class])",
  ".sp-description-more",
  ".sp-teacher-review-history",
  ".sp-teacher-select-projects",
].join(",");

let watchedControl: HTMLElement | null = null;
let labelResize: ResizeObserver | null = null;
let fontRefreshPending = false;
let watchingViewport = false;
const textMeasure = document.createElement("canvas").getContext("2d")!;
export function textBounds(
  label: Element,
  includeUnderline = true,
  includeDescenders = true,
  measurementScale = 1,
) {
  const style = getComputedStyle(label);
  const zoom = (label as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  const range = document.createRange();
  range.selectNodeContents(label);
  const text = range.getBoundingClientRect();
  textMeasure.font = `${style.fontWeight} ${parseFloat(style.fontSize) * measurementScale}px ${style.fontFamily}`;
  textMeasure.fontKerning = style.fontKerning as CanvasFontKerning;
  textMeasure.letterSpacing =
    measurementScale === 1
      ? style.letterSpacing
      : `${(parseFloat(style.letterSpacing) || 0) * measurementScale}px`;
  const ink = textMeasure.measureText(label.textContent ?? "");
  const parentStyle = label.parentElement && getComputedStyle(label.parentElement);
  const decoration = style.textDecorationLine.includes("underline") ? style : parentStyle;
  const underlined = includeUnderline && decoration?.textDecorationLine.includes("underline");
  const marker = document.createElement("span");
  marker.style.cssText =
    "display:inline-block;width:0;height:0;font-size:0;line-height:0;vertical-align:baseline";
  label.append(marker);
  const baseline = marker.getBoundingClientRect().top;
  marker.remove();
  return {
    left: underlined
      ? text.left
      : text.left - (ink.actualBoundingBoxLeft / measurementScale) * zoom,
    right: underlined
      ? text.right
      : text.left + (ink.actualBoundingBoxRight / measurementScale) * zoom,
    top: baseline - (ink.actualBoundingBoxAscent / measurementScale) * zoom,
    bottom: Math.max(
      baseline + ((includeDescenders ? ink.actualBoundingBoxDescent : 0) / measurementScale) * zoom,
      underlined
        ? baseline +
            (parseFloat(decoration?.textUnderlineOffset ?? "") || 1) * zoom +
            (parseFloat(decoration?.textDecorationThickness ?? "") || 1) * zoom
        : -Infinity,
    ),
  };
}

// Iconify icons may combine several paths or leave a margin inside the viewBox.
function iconBounds(svg: SVGSVGElement) {
  const box = svg.getBBox();
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const shape = svg.querySelector("path, rect, circle, polyline");
  const style = shape && getComputedStyle(shape);
  const stroke = style && style.stroke !== "none" ? parseFloat(style.strokeWidth) / 2 : 0;
  const first = new DOMPoint(box.x - stroke, box.y - stroke).matrixTransform(matrix);
  const last = new DOMPoint(
    box.x + box.width + stroke,
    box.y + box.height + stroke,
  ).matrixTransform(matrix);
  return { left: first.x, top: first.y, right: last.x, bottom: last.y };
}

export function updatePlainHover(target: EventTarget | null) {
  const control = target instanceof Element ? target.closest<HTMLElement>(controls) : null;
  if (!control || !control.matches(":hover:not(:disabled, [aria-disabled=true])")) return;
  control.dataset.plainHover ??=
    getComputedStyle(control).position === "static" ? "anchor" : "positioned";
  const svg = control.querySelector<SVGSVGElement>("svg");
  const label = control.querySelector(
    ".sp-tab-content > span, .sp-description-more-label, .sp-csv-action > span, .sp-button-label",
  );
  if (watchedControl !== control) {
    labelResize?.disconnect();
    watchedControl = control;
    // Counts and late-loading fonts can change while the pointer stays over the tab
    labelResize = new ResizeObserver(() => updatePlainHover(control));
    labelResize.observe(label ?? control);
    control.addEventListener(
      "pointerleave",
      () => {
        if (watchedControl === control) {
          labelResize?.disconnect();
          labelResize = null;
          watchedControl = null;
        }
      },
      { once: true },
    );
  }
  const measuredLabel = control.querySelector(".sp-plain-label");
  const text = measuredLabel
    ? textBounds(measuredLabel)
    : label || !svg
      ? textBounds(label ?? control)
      : undefined;
  const icon = svg && iconBounds(svg);
  const bounds =
    text && icon
      ? {
          left: Math.min(text.left, icon.left),
          top: Math.min(text.top, icon.top),
          right: Math.max(text.right, icon.right),
          bottom: Math.max(text.bottom, icon.bottom),
        }
      : text || icon;
  if (!bounds || bounds.right <= bounds.left) {
    delete control.dataset.plainHover;
    return;
  }
  const scale = window.devicePixelRatio;
  const zoom = (control as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
  const style = getComputedStyle(control);
  const padding = parseFloat(style.getPropertyValue("--sp-plain-hover-pad")) * scale * zoom;
  const leftEdge =
    control.tagName === "SUMMARY" ? control.getBoundingClientRect().left : bounds.left;
  const left = leftEdge * scale - padding;
  const top = bounds.top * scale - padding;
  const width = bounds.right * scale + padding - left;
  const height = bounds.bottom * scale + padding - top;
  const frame = control.getBoundingClientRect();
  control.style.setProperty(
    "--hover-offset-x",
    `${(left / scale - frame.left) / zoom - parseFloat(style.borderLeftWidth)}px`,
  );
  control.style.setProperty(
    "--hover-offset-y",
    `${(top / scale - frame.top) / zoom - parseFloat(style.borderTopWidth)}px`,
  );
  control.style.setProperty("--hover-paint-width", `${width / scale / zoom}px`);
  control.style.setProperty("--hover-paint-height", `${height / scale / zoom}px`);
  if (!watchingViewport) {
    window.addEventListener("resize", () => {
      if (watchedControl) updatePlainHover(watchedControl);
    });
    watchingViewport = true;
  }
  if (document.fonts.status === "loading" && !fontRefreshPending) {
    fontRefreshPending = true;
    void document.fonts.ready.then(() => {
      fontRefreshPending = false;
      if (watchedControl) updatePlainHover(watchedControl);
    });
  }
}
