/** Explicit sensitivity declarations from a harness or credential consumer.
 * No field names, token formats or content patterns are classified here.
 * Callers retain the declaration until all associated diagnostics are drained.
 */
const declarations = new Map<string, number>();
const MASK = '[REDACTED]';

export function protectSensitiveValues(values: readonly string[]): () => void {
  const unique = [...new Set(values)];
  if (unique.some(value => !value || value.length > 8192) ||
      new Set([...declarations.keys(), ...unique]).size > 1024) {
    throw new Error('Sensitive value declaration exceeds resource limits');
  }
  for (const value of unique) {declarations.set(value, (declarations.get(value) ?? 0) + 1);}
  let disposed = false;
  return () => {
    if (disposed) {return;}
    disposed = true;
    for (const value of unique) {
      const remaining = (declarations.get(value) ?? 1) - 1;
      if (remaining) {declarations.set(value, remaining);} else {declarations.delete(value);}
    }
    unique.length = 0;
  };
}

function replaceDeclared(text: string, values: readonly string[]): string {
  const output: string[] = [];
  const filter = new SensitiveOutputFilter(values, chunk => output.push(chunk));
  filter.write(text);
  filter.finish();
  return output.join('');
}

/** Protect only values that a harness explicitly declared, including in keys. */
export function redactDeclaredSensitive(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {return replaceDeclared(value, [...declarations.keys()]);}
  if (value === null || typeof value !== 'object') {return value;}
  if (ancestors.has(value)) {return '[Circular]';}
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {return value.map(item => redactDeclaredSensitive(item, ancestors));}
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable && !(value instanceof Error)) {continue;}
      output[replaceDeclared(key, [...declarations.keys()])] = 'value' in descriptor
        ? redactDeclaredSensitive(descriptor.value, ancestors) : '[Accessor]';
    }
    return output;
  } finally {ancestors.delete(value);}
}

/** A bounded streaming filter for explicitly declared values. Hold enough
 * suffix to recognize a value split over chunks, including multiline values.
 * Inputs are decoded strings; byte-stream callers should use StringDecoder.
 */
export class SensitiveOutputFilter {
  private pending = '';
  private readonly values: string[];
  private readonly retain: number;
  constructor(values: readonly string[], private readonly emit: (text: string) => void) {
    if (values.some(value => !value || value.length > 8192) || values.length > 1024) {
      throw new Error('Sensitive output declaration exceeds resource limits');
    }
    this.values = [...new Set(values)].sort((a, b) => b.length - a.length);
    this.retain = Math.max(0, ...this.values.map(value => value.length - 1));
  }
  write(chunk: string): void {this.pending += chunk; this.drain(false);}
  finish(): void {this.drain(true);}
  private drain(final: boolean): void {
    while (this.pending) {
      const safeEnd = final ? this.pending.length : Math.max(0, this.pending.length - this.retain);
      if (!safeEnd) {return;}
      let offset = -1;
      let match = '';
      for (const value of this.values) {
        const index = this.pending.indexOf(value);
        if (index >= 0 && index < safeEnd && (offset < 0 || index < offset)) {offset = index; match = value;}
      }
      if (offset >= 0) {
        this.emit(this.pending.slice(0, offset) + MASK);
        this.pending = this.pending.slice(offset + match.length);
      } else {
        this.emit(this.pending.slice(0, safeEnd));
        this.pending = this.pending.slice(safeEnd);
      }
    }
  }
}
