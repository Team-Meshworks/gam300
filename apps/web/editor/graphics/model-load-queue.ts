/** Deduplicates model requests and bounds downloads without making failures block other assets. */
export function createModelLoadQueue(load: (id: string) => Promise<void>, changed: () => void) {
  const requests = new Map<string, Promise<boolean>>();
  const errors = new Map<string, unknown>();
  const queue: (() => void)[] = [];
  let active = 0;
  let pending = 0;
  function pump() {
    while (active < 2 && queue.length) queue.shift()!();
  }
  return {
    get pending() {
      return pending;
    },
    errors,
    request(id: string): Promise<boolean> {
      const existing = requests.get(id);
      if (existing) return existing;
      let finish!: (ok: boolean) => void;
      const promise = new Promise<boolean>((resolve) => {
        finish = resolve;
      });
      requests.set(id, promise);
      pending++;
      queue.push(() => {
        active++;
        void Promise.resolve()
          .then(() => load(id))
          .then(
            () => true,
            (error) => {
              errors.set(id, error);
              return false;
            },
          )
          .then((ok) => {
            active--;
            pending--;
            finish(ok);
            changed();
            pump();
          });
      });
      changed();
      pump();
      return promise;
    },
  };
}
