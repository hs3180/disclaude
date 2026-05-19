/**
 * Elasticsearch Transport for Pino Logger
 *
 * Provides a custom Writable stream that batches log entries and writes
 * them to Elasticsearch using the bulk API.
 *
 * Features:
 * - Configurable batch size and flush interval
 * - Date-based index rolling (e.g., disclaude-logs-2026.05.19)
 * - Graceful degradation when ES is unavailable
 * - Retry on transient failures
 * - Basic auth and API Key authentication
 *
 * @see Issue #3720
 * @module utils/elasticsearch-transport
 */

import { Writable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import type { ElasticsearchConfig } from '../config/types.js';

/**
 * Internal log entry structure after JSON parsing.
 */
interface LogEntry {
  level: number;
  time: number;
  msg?: string;
  [key: string]: unknown;
}

/**
 * Elasticsearch bulk API response error item.
 */
interface BulkErrorItem {
  index: {
    status: number;
    error?: { type: string; reason: string };
  };
}

/**
 * Status of the Elasticsearch transport for health checks.
 */
export interface ElasticsearchTransportStatus {
  /** Whether the transport is active */
  active: boolean;
  /** Number of pending entries in the buffer */
  pendingCount: number;
  /** Total entries successfully written */
  totalWritten: number;
  /** Total write failures */
  totalFailures: number;
  /** Current index name */
  currentIndex: string;
}

/**
 * Elasticsearch Transport class.
 *
 * Extends Writable to consume pino log entries, batches them, and
 * periodically flushes to Elasticsearch via the bulk API.
 */
export class ElasticsearchTransport extends Writable {
  private readonly config: Required<
    Pick<
      ElasticsearchConfig,
      'node' | 'index' | 'batchSize' | 'flushInterval' | 'retryOnError' | 'maxRetries'
    >
  > & { auth?: { username: string; password: string }; apiKey?: string };
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private totalWritten = 0;
  private totalFailures = 0;
  private isShutDown = false;
  private flushing = false;

  constructor(config: ElasticsearchConfig) {
    super({ objectMode: false, decodeStrings: true });

    this.config = {
      node: config.node,
      index: config.index ?? 'disclaude-logs',
      batchSize: config.batchSize ?? 100,
      flushInterval: config.flushInterval ?? 5000,
      retryOnError: config.retryOnError ?? true,
      maxRetries: config.maxRetries ?? 3,
      auth: config.auth,
      apiKey: config.apiKey,
    };

    this.startFlushTimer();
  }

  /**
   * Get today's index name with date suffix.
   * Format: {indexPrefix}-YYYY.MM.DD
   */
  private getIndexName(): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replace(/-/g, '.');
    return `${this.config.index}-${date}`;
  }

  /**
   * Start the periodic flush timer.
   */
  private startFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        this.emit('error', err);
      });
    }, this.config.flushInterval);

    // Allow the process to exit even if the timer is active
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Build authentication headers.
   */
  private buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-ndjson',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `ApiKey ${this.config.apiKey}`;
    } else if (this.config.auth) {
      const credentials = Buffer.from(
        `${this.config.auth.username}:${this.config.auth.password}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${credentials}`;
    }

    return headers;
  }

  /**
   * Write implementation for the Writable stream.
   * Buffers log entries and flushes when batch size is reached.
   */
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.isShutDown) {
      callback();
      return;
    }

    const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const trimmed = line.trim();
    if (!trimmed) {
      callback();
      return;
    }

    this.buffer.push(trimmed);

    if (this.buffer.length >= this.config.batchSize) {
      this.flush()
        .then(() => callback())
        .catch((err) => callback(err));
    } else {
      callback();
    }
  }

  /**
   * Writev implementation for batch writes from pino.
   */
  override _writev(
    chunks: Array<{ chunk: Buffer | string; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.isShutDown) {
      callback();
      return;
    }

    for (const { chunk } of chunks) {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const trimmed = line.trim();
      if (trimmed) {
        this.buffer.push(trimmed);
      }
    }

    if (this.buffer.length >= this.config.batchSize) {
      this.flush()
        .then(() => callback())
        .catch((err) => callback(err));
    } else {
      callback();
    }
  }

  /**
   * Flush buffered entries to Elasticsearch.
   *
   * Uses the bulk API for efficient batch ingestion.
   * Retries on transient failures when retryOnError is enabled.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0 || this.isShutDown) {
      return;
    }

    this.flushing = true;
    const entries = this.buffer.splice(0);
    const indexName = this.getIndexName();

    // Build NDJSON body for bulk API
    // Each entry needs an action line followed by the document
    const body = `${entries
      .map((entry) => {
        let parsed: LogEntry;
        try {
          parsed = JSON.parse(entry);
        } catch {
          // If not valid JSON, wrap it
          parsed = { level: 30, time: Date.now(), msg: entry };
        }

        // Transform timestamp for ES compatibility
        const doc = {
          ...parsed,
          '@timestamp': parsed.time ? new Date(parsed.time).toISOString() : new Date().toISOString(),
        };
        delete (doc as Record<string, unknown>).time;

        const action = JSON.stringify({ index: { _index: indexName } });
        const document = JSON.stringify(doc);
        return `${action}\n${document}`;
      })
      .join('\n')  }\n`;

    let attempts = 0;
    const maxAttempts = this.config.retryOnError ? this.config.maxRetries : 1;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        await this.sendBulk(body);
        this.totalWritten += entries.length;
        this.flushing = false;
        return;
      } catch (err) {
        if (attempts >= maxAttempts) {
          this.totalFailures += entries.length;
          this.emit('warning', `ES write failed after ${attempts} attempts: ${(err as Error).message}`);
          this.flushing = false;
          return;
        }
        // Wait before retry (exponential backoff)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
      }
    }

    this.flushing = false;
  }

  /**
   * Send bulk data to Elasticsearch via HTTP.
   */
  private sendBulk(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(`/${this.config.index}-*/_bulk`, this.config.node);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      const headers = this.buildAuthHeaders();
      headers['Content-Length'] = Buffer.byteLength(body).toString();

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      };

      const req = httpModule.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const result = JSON.parse(responseBody);
              if (result.errors) {
                const errors = (result.items as BulkErrorItem[]).filter(
                  (item) => item.index?.status >= 400,
                );
                if (errors.length > 0) {
                  reject(new Error(`ES bulk partial failure: ${errors.length} items failed`));
                  return;
                }
              }
            } catch {
              // Response parsing failed, but status was OK
            }
            resolve();
          } else {
            reject(
              new Error(`ES returned status ${res.statusCode}: ${responseBody.slice(0, 200)}`),
            );
          }
        });
      });

      req.on('error', (err) => reject(err));

      // Timeout to prevent hanging connections
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('ES request timed out'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Get transport status for monitoring.
   */
  getStatus(): ElasticsearchTransportStatus {
    return {
      active: !this.isShutDown,
      pendingCount: this.buffer.length,
      totalWritten: this.totalWritten,
      totalFailures: this.totalFailures,
      currentIndex: this.getIndexName(),
    };
  }

  /**
   * Destroy the transport, flushing any remaining entries.
   */
  override async _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): Promise<void> {
    this.isShutDown = true;

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    try {
      await this.flush();
    } catch {
      // Ignore final flush errors during destroy
    }

    callback(error);
  }

  /**
   * Final method called before stream is destroyed.
   * Ensures remaining entries are flushed.
   */
  override _final(callback: (error?: Error | null) => void): void {
    this.flush()
      .then(() => callback())
      .catch((err) => callback(err));
  }
}

/**
 * Create an Elasticsearch transport instance.
 *
 * @param config - Elasticsearch configuration
 * @returns ElasticsearchTransport instance, or null if disabled
 */
export function createElasticsearchTransport(
  config?: ElasticsearchConfig,
): ElasticsearchTransport | null {
  if (!config || !config.enabled) {
    return null;
  }

  return new ElasticsearchTransport(config);
}
