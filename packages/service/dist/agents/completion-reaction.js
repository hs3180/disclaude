/** Bounded best-effort feedback. A timeout has an unknown outcome: do not retry it. */
export async function addCompletionReaction(add, isCurrent, timeoutMs = 1000) {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!isCurrent()) {
            return 'cancelled';
        }
        let timer;
        try {
            const outcome = await Promise.race([
                Promise.resolve().then(add).then((ok) => ok ? 'added' : 'failed', () => 'failed'),
                new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
            ]);
            if (outcome !== 'failed') {
                return outcome;
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    return 'failed';
}
