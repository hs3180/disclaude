/** Track callback promises independently from logical turn cancellation.
 * Callers stop the query first, then drain callbacks before releasing ownership.
 */
export function ownAsyncCallbacks(target) {
    const pending = new Set();
    const wrappers = new WeakMap();
    const callbacks = new Proxy({ ...target }, {
        get(object, key, receiver) {
            const value = Reflect.get(object, key, receiver);
            if (typeof value !== 'function') {
                return value;
            }
            const existing = wrappers.get(value);
            if (existing) {
                return existing;
            }
            const wrapped = (...args) => {
                const result = Reflect.apply(value, object, args);
                if (!result || (typeof result !== 'object' && typeof result !== 'function') ||
                    !('then' in result) || typeof result.then !== 'function') {
                    return result;
                }
                const operation = Promise.resolve(result);
                pending.add(operation);
                const release = () => { pending.delete(operation); };
                void operation.then(release, release);
                return operation;
            };
            wrappers.set(value, wrapped);
            return wrapped;
        },
    });
    return { callbacks, settle: async () => {
            while (pending.size) {
                await Promise.allSettled([...pending]);
            }
        } };
}
