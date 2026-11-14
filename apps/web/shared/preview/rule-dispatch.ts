// A failed rule must not stop later rules; accepted navigation ends the old scene's dispatch
export function dispatchRules<T>(
  rules: readonly T[],
  matches: (rule: T) => boolean,
  execute: (rule: T) => boolean,
): void {
  for (const rule of rules) {
    if (!matches(rule)) continue;
    try {
      if (execute(rule)) break;
    } catch {
      // The next authored rule may still be able to run
    }
  }
}
