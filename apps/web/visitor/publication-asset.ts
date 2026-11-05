// Give waiting visitors time behind 20 MB transfers without increasing the two-permit server budget.
// The deadline also bounds the accepted response's body download; disposal cancels immediately.
export async function fetchPublicationAsset(url: string, signal: AbortSignal): Promise<Response> {
  const budget = 5 * 60 * 1000;
  const deadline = Date.now() + budget;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
  for (let attempt = 0; ; attempt++) {
    bounded.throwIfAborted();
    if (Date.now() >= deadline)
      throw new DOMException(
        "Exhibition loading timed out. Retry loading the exhibition.",
        "TimeoutError",
      );
    const response = await fetch(url, {
      signal: bounded,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (![429, 503].includes(response.status)) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAfter === null
        ? 0
        : Date.parse(retryAfter) - Date.now();
    const backoff = Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
    // Do not retry earlier than Retry-After; a value beyond our budget expires the attempt.
    const delay = Math.max(0, Math.min(deadline - Date.now(), Math.max(backoff, requested || 0)));
    await response.body?.cancel();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(bounded.reason);
      };
      const timer = setTimeout(() => {
        bounded.removeEventListener("abort", cancel);
        resolve();
      }, delay);
      bounded.addEventListener("abort", cancel, { once: true });
      if (bounded.aborted) cancel();
    });
  }
}
