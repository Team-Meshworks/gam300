export function isMobileTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const mobileUserAgent =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i.test(
      navigator.userAgent,
    );
  const desktopModeIPad =
    navigator.maxTouchPoints > 1 &&
    /Macintosh/i.test(navigator.userAgent) &&
    /MacIntel/i.test(navigator.platform);
  return mobileUserAgent || desktopModeIPad;
}
