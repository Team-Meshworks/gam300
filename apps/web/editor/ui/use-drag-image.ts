import { useCallback, useEffect, useRef } from "react";
// Keep a decoded image attached outside the hidden picker so Chromium does not fall back to the card.
export function useDragImage() {
  const image = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const element = new Image(1, 1);
    element.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    element.alt = "";
    element.setAttribute("aria-hidden", "true");
    Object.assign(element.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.append(element);
    image.current = element;
    return () => {
      element.remove();
      image.current = null;
    };
  }, []);
  return useCallback((transfer: DataTransfer) => {
    if (image.current) transfer.setDragImage(image.current, 0, 0);
  }, []);
}
