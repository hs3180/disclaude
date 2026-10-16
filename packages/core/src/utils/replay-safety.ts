const NO_REPLAY = Symbol('noAutomaticReplay');

/** Preserve the upstream error classification; replay admission is independent. */
export function preventAutomaticReplay(error: unknown, reason: string): Error {
  const target = error instanceof Error && Object.isExtensible(error)
    ? error : new Error(error instanceof Error ? error.message : 'Claude execution outcome is uncertain', { cause: error });
  Object.defineProperty(target, NO_REPLAY, { value: reason, configurable: true });
  return target;
}

export function automaticReplayBlock(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) { break; }
    seen.add(current);
    const record = current as { [NO_REPLAY]?: string; cause?: unknown };
    if (record[NO_REPLAY]) { return record[NO_REPLAY]; }
    current = record.cause;
  }
  return undefined;
}
