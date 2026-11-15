// Keep the picture moving if the browser requires a gesture before allowing sound.
const attempts = new WeakMap<HTMLVideoElement, AbortController>();

export function cancelStandPlaybackAttempt(video: HTMLVideoElement) {
  attempts.get(video)?.abort();
  attempts.delete(video);
}

export function playStandVideo(video: HTMLVideoElement) {
  cancelStandPlaybackAttempt(video);
  if (document.hidden) return;
  const attempt = new AbortController();
  attempts.set(video, attempt);
  const { signal } = attempt;
  function tryWithSound() {
    if (document.hidden || signal.aborted) return;
    video.muted = false;
    void video.play().then(
      () => {
        if (!signal.aborted) cancelStandPlaybackAttempt(video);
      },
      (error: unknown) => {
        if (signal.aborted || !(error instanceof DOMException) || error.name !== "NotAllowedError")
          return;
        video.muted = true;
        void video.play().catch(() => {});
        document.addEventListener("click", tryWithSound, { capture: true, signal });
        document.addEventListener("keydown", tryWithSound, { capture: true, signal });
      },
    );
  }
  tryWithSound();
}
