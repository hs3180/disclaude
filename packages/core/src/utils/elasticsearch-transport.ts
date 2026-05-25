/**
 * Elasticsearch Transport for Pino Logger
 *
 * A Writable stream that batches log entries and bulk-indexes them into
 * Elasticsearch. Designed to be non-blocking — failures fall back to
 * console.warn without affecting the main logging pipeline.
 *
 * Features:
 * - Bulk indexing for performance
 * - Date-based index rolling (e.g., `disclaude-logs-2026.05.19`)
 * - Configurable batch size and flush interval
 * - Automatic retry on transient errors
 * - Graceful degradation when ES is unavailable
 *
 * @see Issue #3720
 */

import { Writable } from 'node:stream';
import type { ElasticsearchConfig } from '../config/types.js';

/**
 * Internal representation of a buffered log entry.
 */
interface BufferedEntry {
  /** Elasticsearch index name (includes date suffix) */
  index: string;
  /** JSON-serialisable log payload */
  body: Record<string, unknown>;
}

/**
 * Result of a bulk indexing operation.
 */
interface BulkResult {
  /** HTTP status code from ES */
  status: number;
  /** Whether all items were successfully indexed */
  ok: boolean;
  /** Number of items that failed */
  errors?: number;
}

/**
 * Create a date-suffixed index name.
 *
 * @param prefix - Index prefix (e.g., "disclaude-logs")
 * @param date - Date to use for the suffix
 * @returns Index name like "disclaude-logs-2026.05.19"
 */
export function buildIndexName(prefix: string, date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${prefix}-${yyyy}.${mm}.${dd}`;
}

/**
 * Build HTTP headers for ES requests based on auth config.
 */
function buildHeaders(config: ElasticsearchConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-ndjson',
    'Accept': 'application/json',
  };

  if (config.auth?.apiKey) {
    headers['Authorization'] = `ApiKey ${config.auth.apiKey}`;
  } else if (config.auth?.basic?.username && config.auth?.basic?.password) {
    const encoded = Buffer.from(`${config.auth.basic.username}:${config.auth.basic.password}`).toString('base64');
    headers['Authorization'] = `Basic ${encoded}`;
  }

  return headers;
}

/**
 * Send a bulk request to Elasticsearch.
 *
 * Uses the native `fetch` API (Node 18+).
 *
 * @param node - ES node URL
 * @param headers - HTTP headers including auth
 * @param entries - Buffered log entries to send
 * @returns Bulk result with status information
 */
async function sendBulk(
  node: string,
  headers: Record<string, string>,
  entries: BufferedEntry[],
): Promise<BulkResult> {
  // Build NDJSON body: action line + source line per entry
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(JSON.stringify({ index: { _index: entry.index } }));
    lines.push(JSON.stringify(entry.body));
  }
  const body = `${lines.join('\n')  }\n`;

  const url = `${node.replace(/\/+$/, '')}/_bulk`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      return { status: response.status, ok: false, errors: entries.length };
    }

    const result = await response.json() as {
      errors?: boolean;
      items?: Array<{ index?: { status?: number } }>;
    };
    const errorCount = result.errors
      ? result.items?.filter(i => (i.index?.status ?? 200) >= 400).length ?? entries.length
      : 0;

    return {
      status: response.status,
      ok: !result.errors,
      errors: errorCount,
    };
  } catch {
    return {
      status: 0,
      ok: false,
      errors: entries.length,
    };
  }
}

/**
 * Elasticsearch Transport — a Node.js Writable stream for Pino.
 *
 * Usage with pino.multistream:
 * ```typescript
 * import pino from 'pino';
 * import { ElasticsearchTransport } from './elasticsearch-transport.js';
 *
 * const esTransport = new ElasticsearchTransport({ enabled: true, node: 'http://localhost:9200' });
 * const streams = [
 *   { level: 'info', stream: process.stdout },
 *   { level: 'info', stream: esTransport },
 * ];
 * const logger = pino({}, pino.multistream(streams));
 * ```
 */
export class ElasticsearchTransport extends Writable {
  private readonly esConfig: Required<
    Pick<ElasticsearchConfig, 'node' | 'batchSize' | 'flushInterval' | 'retryOnError' | 'maxRetries' | 'maxBufferSize'>
  > & { index: string; enabled: boolean; auth?: ElasticsearchConfig['auth'] };

  private buffer: BufferedEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private esHeaders: Record<string, string>;
  private isShutDown = false;
  private flushing = false;

  constructor(config: ElasticsearchConfig) {
    super({ objectMode: true });

    this.esConfig = {
      enabled: config.enabled,
      node: config.node,
      index: config.index ?? 'disclaude-logs',
      auth: config.auth,
      batchSize: config.batchSize ?? 100,
      flushInterval: config.flushInterval ?? 5000,
      retryOnError: config.retryOnError ?? true,
      maxRetries: config.maxRetries ?? 3,
      maxBufferSize: config.maxBufferSize ?? 10000,
    };

    this.esHeaders = buildHeaders(config);

    // Warn if using HTTP with auth credentials (Fix #5)
    if (config.auth && config.node.startsWith('http://')) {
      console.warn(
        '[ES Transport] Warning: Using HTTP with authentication credentials. ' +
        'Consider using HTTPS to protect credentials in transit.',
      );
    }

    // Start periodic flush
    if (this.esConfig.enabled && this.esConfig.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {
          // Prevent unhandled rejection — errors are logged inside flush()
        });
      }, this.esConfig.flushInterval);
      // Fix #3: Allow process to exit when only this timer is active
      this.flushTimer.unref();
    }
  }

  /**
   * Get the current buffer size (useful for testing).
   */
  get bufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Get the configured index prefix.
   */
  get indexPrefix(): string {
    return this.esConfig.index;
  }

  /**
   * Pino Writable interface — called for every log entry.
   */
  _write(
    chunk: Buffer | string | Record<string, unknown>,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.esConfig.enabled || this.isShutDown) {
      callback();
      return;
    }

    try {
      const payload = typeof chunk === 'string'
        ? JSON.parse(chunk)
        : Buffer.isBuffer(chunk)
          ? JSON.parse(chunk.toString('utf-8'))
          : chunk;

      // Use log timestamp if available, otherwise current time
      const timestamp = payload.time ?? payload['@timestamp'] ?? Date.now();
      const logDate = new Date(typeof timestamp === 'number' ? timestamp : timestamp);
      const indexName = buildIndexName(this.esConfig.index, logDate);

      // Ensure @timestamp field is present for ES
      const body: Record<string, unknown> = {
        ...payload,
        '@timestamp': logDate.toISOString(),
      };

      this.buffer.push({ index: indexName, body });

      // Fix #1: Enforce max buffer size to prevent unbounded memory growth
      if (this.buffer.length > this.esConfig.maxBufferSize) {
        const dropped = this.buffer.splice(0, this.buffer.length - this.esConfig.maxBufferSize);
        console.warn(
          `[ES Transport] Buffer exceeded maxBufferSize (${this.esConfig.maxBufferSize}). ` +
          `Dropped ${dropped.length} oldest log entries.`,
        );
      }

      // Auto-flush when buffer reaches batch size
      if (this.buffer.length >= this.esConfig.batchSize) {
        this.flush().catch(() => {});
      }
    } catch {
      // Silently ignore malformed log entries to prevent logging loops
    }

    callback();
  }

  /**
   * Flush buffered log entries to Elasticsearch.
   *
   * Retries on transient failures if `retryOnError` is enabled.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0 || this.isShutDown) {
      return;
    }

    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);

    try {
      let attempts = 0;
      const maxAttempts = this.esConfig.retryOnError ? this.esConfig.maxRetries + 1 : 1;

      while (attempts < maxAttempts) {
        attempts++;
        const result = await sendBulk(this.esConfig.node, this.esHeaders, batch);

        if (result.ok) {
          return;
        }

        if (result.status === 0) {
          // Network-level failure — retryable
          if (attempts < maxAttempts) {
            // Exponential backoff: 100ms, 200ms, 400ms...
            await new Promise(r => setTimeout(r, 100 * (2 ** (attempts - 1))));
            continue;
          }
        } else if (result.status >= 400 && result.status < 500) {
          // Client error (auth, bad request) — not retryable
          console.warn(
            `[ES Transport] Bulk indexing failed with status ${result.status}. ` +
            `Dropped ${batch.length} log entries.`,
          );
          return;
        } else if (result.status >= 500) {
          // Server error — retryable
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 100 * (2 ** (attempts - 1))));
            continue;
          }
        }

        // Non-retryable or exhausted retries
        console.warn(
          `[ES Transport] Bulk indexing failed after ${attempts} attempts. ` +
          `Dropped ${batch.length} log entries.`,
        );
        return;
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Clean up resources. Flushes remaining entries before destroying.
   */
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.isShutDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Attempt final flush, then call callback
    void this.flush()
      .catch(() => {
        // Best-effort flush on destroy
      })
      .then(() => callback(error));
  }

  /**
   * Graceful shutdown: flush remaining entries then destroy.
   * Use in production code (e.g., logger.ts resetLogger).
   */
  async shutdown(): Promise<void> {
    // Stop timer first to prevent concurrent flushes
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Flush BEFORE setting isShutDown so flush() doesn't bail out
    try {
      await this.flush();
    } catch {
      // Best-effort flush
    }
    this.isShutDown = true;
    this.destroy();
  }

  /**
   * Force-destroy without flushing. For testing only.
   */
  forceDestroy(): void {
    this.isShutDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.buffer = [];
    this.destroy();
  }
}
