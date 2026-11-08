// Combine request cancellation on browsers that predate AbortSignal.any
export function combineAbortSignals(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([...signals]);
  }

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    // Preserve the first cancellation reason and release listeners on every source
    controller.abort(signal.reason);
    for (const [source, listener] of listeners) {
      source.removeEventListener("abort", listener);
    }
  };
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      return controller.signal;
    }
    if (!listeners.has(signal)) {
      const listener = () => abort(signal);
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
  }
  return controller.signal;
}
