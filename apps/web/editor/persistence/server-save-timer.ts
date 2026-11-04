// Group nearby edits into one save attempt
// Callback decides whether the session is ready to send or only back up locally
export function createServerSaveTimer(onReady: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstEditAt: number | undefined;

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    firstEditAt = undefined;
  }

  return {
    schedule() {
      clearTimeout(timer);
      // Give editing two quiet seconds, capped at five seconds from the first edit
      // Repeated edits keep the original deadline
      firstEditAt ??= Date.now();
      timer = setTimeout(
        () => {
          cancel();
          onReady();
        },
        Math.min(2_000, Math.max(0, 5_000 - (Date.now() - firstEditAt))),
      );
    },
    // Manual save or leaving the project ends this batch of edits
    cancel,
  };
}
