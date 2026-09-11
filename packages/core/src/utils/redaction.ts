/** Shared value redaction for logs and user-facing diagnostics (#4919).
 * This is deterministic credential-pattern filtering, not general DLP.
 */
const MASK = '[REDACTED]';
const sensitive = /^(?:authorization|proxyauthorization|cookie|setcookie|token|accesstoken|refreshtoken|idtoken|password|passwd|secret|appsecret|clientsecret|apikey|privatekey|credential|credentials)$/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, MASK)
    .replace(/(["'](?:[a-z\d]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, `$1"${MASK}"`)
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, `$1${MASK}@`)
    .replace(/\b(?:gh[pousr]_[a-z\d_]{6,}|github_pat_[a-z\d_]{6,}|sk-[a-z\d_-]{6,}|AKIA[A-Z\d]{16})\b/gi, MASK)
    .replace(/\b(Bearer|Basic)\s+[a-z\d+/_=.-]+/gi, `$1 ${MASK}`)
    .replace(/\b((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, `$1${MASK}`)
    .replace(/\b((?:[a-z\d]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\s,;&}\]]+)/gi, `$1${MASK}`);
}

/** Clone before redacting; do not invoke getters/toJSON on diagnostic objects. */
export function redactSensitive(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {return redactSensitiveText(value);}
  if (value === null || typeof value !== 'object') {return value;}
  if (ancestors.has(value)) {return '[Circular]';}
  if (value instanceof Date) {return value.toISOString();}
  if (Buffer.isBuffer(value)) {return `[Buffer: ${value.length} bytes]`;}
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {return value.map(item => redactSensitive(item, ancestors));}
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (value instanceof Error) {result.type = value.name;}
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable && !(value instanceof Error)) {continue;}
      const normalized = key.replace(/[-_]/g, '');
      result[key] = sensitive.test(normalized) || /(?:apikey|appsecret|clientsecret|accesstoken|refreshtoken|password)$/i.test(normalized)
        ? MASK
        : 'value' in descriptor ? redactSensitive(descriptor.value, ancestors) : '[Accessor]';
    }
    return result;
  } finally {ancestors.delete(value);}
}

/** Buffer complete diagnostic lines so a token split across chunks is never
 * emitted in pieces. Oversized lines are discarded, not truncated before
 * redaction. PEM bodies stay suppressed across lines and process EOF.
 */
export class RedactedDiagnosticStream {
  private pending = '';
  private oversized = false;
  private privateKey = false;
  constructor(private readonly emit: (text: string) => void, private readonly maxLineLength = 16_384) {}

  write(chunk: string): void {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (!this.oversized) {
        if (this.pending.length + part.length > this.maxLineLength) {
          this.pending = '';
          this.oversized = true;
        } else {this.pending += part;}
      }
      if (part.endsWith('\n')) {this.flushLine();}
    }
  }

  finish(): void {
    if (this.pending || this.oversized) {this.flushLine();}
  }

  private flushLine(): void {
    const line = this.pending;
    this.pending = '';
    if (this.oversized) {
      this.oversized = false;
      this.emit('[Diagnostic line omitted: size limit]\n');
      return;
    }
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) {this.privateKey = true;}
    if (this.privateKey) {
      if (/-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) {this.privateKey = false;}
      this.emit('[REDACTED]\n');
    } else {this.emit(redactSensitiveText(line));}
  }
}
