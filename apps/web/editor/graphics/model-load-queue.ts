/** Coalesces placement with a selected card's preparation. Authored models take priority. */
export function createModelLoadQueue(load: (id: string) => Promise<void>, changed: () => void) {
  type Request = {
    promise: Promise<boolean>;
    finish: (ok: boolean) => void;
    foreground: boolean;
    settled: boolean;
  };
  const requests = new Map<string, Request>();
  const errors = new Map<string, unknown>();
  const queue = new Map<string, Request>();
  let nextChoice: [string, Request] | undefined;
  let active = 0;
  let pending = 0;

  async function run(id: string, job: Request) {
    let ok = false;
    try {
      await load(id);
      ok = true;
    } catch (error) {
      if (job.foreground) errors.set(id, error);
      else requests.delete(id);
    }
    active--;
    job.settled = true;
    job.finish(ok);
    if (job.foreground) {
      pending--;
      changed();
    }
    pump();
  }

  function pump() {
    while (active < 2) {
      const next = queue.entries().next().value ?? nextChoice;
      if (!next) break;
      const [id, job] = next;
      if (next === nextChoice) nextChoice = undefined;
      else queue.delete(id);
      active++;
      void Promise.resolve().then(() => run(id, job));
    }
  }

  function request(id: string, foreground = true): Promise<boolean> {
    const existing = requests.get(id);
    if (existing) {
      if (foreground && !existing.foreground && !existing.settled) {
        if (nextChoice?.[0] === id) {
          nextChoice = undefined;
          queue.set(id, existing);
        }
        existing.foreground = true;
        pending++;
        changed();
      }
      return existing.promise;
    }
    let finish!: (ok: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const job = { promise, finish, foreground, settled: false };
    requests.set(id, job);
    if (foreground) {
      queue.set(id, job);
      pending++;
      changed();
    } else nextChoice = [id, job];
    pump();
    return promise;
  }

  return {
    get pending() {
      return pending;
    },
    errors,
    request,
    forget(id: string) {
      if (requests.get(id)?.settled) {
        requests.delete(id);
        errors.delete(id);
      }
    },
    preload(id: string | null) {
      // Superseded picks still waiting for a slot need no fetch or GPU work
      if (nextChoice && nextChoice[0] !== id) {
        requests.delete(nextChoice[0]);
        nextChoice[1].finish(false);
        nextChoice = undefined;
      }
      return id === null ? Promise.resolve(false) : request(id, false);
    },
  };
}
