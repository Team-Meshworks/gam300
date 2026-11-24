import { expect, it, vi } from "vitest";
import { combineAbortSignalsFallback } from "./abort-signals";

it("preserves the reason from the first cancellation without native any", () => {
  const account = new AbortController();
  const deadline = new AbortController();
  const combined = combineAbortSignalsFallback([account.signal, deadline.signal]);
  expect(combined.aborted).toBe(false);
  const timeout = new DOMException("Request timed out", "TimeoutError");
  deadline.abort(timeout);
  account.abort("account changed");
  expect(combined.aborted).toBe(true);
  expect(combined.reason).toBe(timeout);
  expect(combineAbortSignalsFallback([account.signal]).reason).toBe("account changed");
});

it("releases both source listeners after each request while retaining the live session", () => {
  const account = new AbortController();
  const added = vi.spyOn(account.signal, "addEventListener");
  const removed = vi.spyOn(account.signal, "removeEventListener");
  for (let save = 0; save < 50; save += 1) {
    const deadline = new AbortController();
    const removeDeadline = vi.spyOn(deadline.signal, "removeEventListener");
    const combined = combineAbortSignalsFallback([account.signal, deadline.signal]);
    expect(combined.aborted).toBe(false);
    deadline.abort();
    expect(combined.aborted).toBe(true);
    expect(added).toHaveBeenCalledTimes(save + 1);
    expect(removed).toHaveBeenCalledTimes(save + 1);
    expect(removeDeadline).toHaveBeenCalledOnce();
  }
  expect(account.signal.aborted).toBe(false);
});
