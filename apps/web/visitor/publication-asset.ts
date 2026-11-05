// Retry transient pressure without increasing the server's concurrent byte budget
export async function fetchPublicationAsset(url: string, signal: AbortSignal): Promise<Response> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  for (let attempt = 0; ; attempt++) {
    bounded.throwIfAborted();
    const response = await fetch(url, {
      signal: bounded,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (![429, 503].includes(response.status) || attempt === 4) return response;
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAfter === null
        ? 0
        : Date.parse(retryAfter) - Date.now();
    const delay = Math.min(5000, Math.max(250 * 2 ** attempt, requested || 0));
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
