import { afterEach, expect, it, vi } from "vitest";
import { combineAbortSignals } from "./abort-signals";

afterEach(() => vi.unstubAllGlobals());

it("preserves the first cancellation and releases source listeners without native any", () => {
  class OlderAbortSignal extends AbortSignal {}
  Object.defineProperty(OlderAbortSignal, "any", { value: undefined });
  vi.stubGlobal("AbortSignal", OlderAbortSignal);
  const account = new AbortController();
  const deadline = new AbortController();
  const removed = vi.spyOn(account.signal, "removeEventListener");
  const combined = combineAbortSignals([account.signal, deadline.signal]);
  expect(combined.aborted).toBe(false);
  const timeout = new DOMException("Request timed out", "TimeoutError");
  deadline.abort(timeout);
  account.abort("account changed");
  expect(combined.aborted).toBe(true);
  expect(combined.reason).toBe(timeout);
  expect(removed).toHaveBeenCalled();
  expect(combineAbortSignals([account.signal]).reason).toBe("account changed");
});
