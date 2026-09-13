/** Bounded best-effort feedback. A timeout has an unknown outcome: do not retry it. */
export async function addCompletionReaction(
  add: () => Promise<boolean>,
  isCurrent: () => boolean,
  timeoutMs = 1000,
): Promise<'added' | 'failed' | 'timeout' | 'cancelled'> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) { return 'cancelled'; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(add).then((ok) => ok ? 'added' as const : 'failed' as const, () => 'failed' as const),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
      ]);
      if (outcome !== 'failed') { return outcome; }
    } finally {
      clearTimeout(timer);
    }
  }
  return 'failed';
}
