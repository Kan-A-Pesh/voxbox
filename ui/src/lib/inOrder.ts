// Two requests in flight can reach the app, and answer, in any order. `inOrder` runs
// the requests of one queue one at a time: each starts once the previous one ended,
// so the last answer always reflects the last request.
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

export function inOrder<T>(owner: object, queue: string, run: () => Promise<T>): Promise<T> {
  let byName = queues.get(owner);
  if (!byName) {
    byName = new Map();
    queues.set(owner, byName);
  }
  const previous = byName.get(queue) ?? Promise.resolve();
  const next = previous.then(run);
  byName.set(
    queue,
    next.catch(() => undefined),
  );
  return next;
}
