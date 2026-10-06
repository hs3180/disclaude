import { createHash } from 'node:crypto';

/** Content identity independent of object-key order in Contents/RTC serializers. */
export function notebookSnapshotHash(notebook: unknown): string {
  const serialized = JSON.stringify(notebook, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]])
        )
      : value
  );
  if (serialized === undefined) {
    throw new Error('Notebook snapshot must be JSON content');
  }
  return createHash('sha256').update(serialized).digest('hex');
}
