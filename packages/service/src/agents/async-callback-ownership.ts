/** Track callback promises independently from logical turn cancellation.
 * Callers stop the query first, then drain callbacks before releasing ownership.
 */
export function ownAsyncCallbacks<T extends object>(target: T): { callbacks: T; settle(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const wrappers = new WeakMap<object, (...args: unknown[]) => unknown>();
  const callbacks = new Proxy({ ...target }, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== 'function') { return value; }
      const existing = wrappers.get(value);
      if (existing) { return existing; }
      const wrapped = (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, object, args);
        if (!result || (typeof result !== 'object' && typeof result !== 'function') ||
            !('then' in result) || typeof result.then !== 'function') { return result; }
        const operation = Promise.resolve(result as PromiseLike<unknown>);
        pending.add(operation);
        const release = (): void => { pending.delete(operation); };
        void operation.then(release, release);
        return operation;
      };
      wrappers.set(value, wrapped);
      return wrapped;
    },
  });
  return { callbacks, settle: async () => {
    while (pending.size) { await Promise.allSettled([...pending]); }
  } };
}
