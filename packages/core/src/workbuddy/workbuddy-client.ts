/**
 * HTTP client for communicating with WorkBuddy instances.
 *
 * Sends commands to WorkBuddy's local HTTP API and returns results.
 *
 * @module core/workbuddy/workbuddy-client
 */

import type {
  WorkBuddyCommand,
  WorkBuddyResponse,
  WorkBuddyHealth,
  WorkBuddyProjectConfig,
} from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WorkBuddyClient');

/**
 * Default timeout for HTTP requests (30 seconds).
 */
const DEFAULT_TIMEOUT = 30_000;

/**
 * Raw JSON response from WorkBuddy API.
 */
interface ApiResponse {
  [key: string]: unknown;
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
  data?: Record<string, unknown>;
  version?: string;
  cwd?: string;
  tools?: string[];
  uptime?: number;
}

/**
 * HTTP client for a single WorkBuddy instance.
 */
export class WorkBuddyClient {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly timeout: number;

  constructor(config: WorkBuddyProjectConfig, timeout?: number) {
    // Strip trailing slash from URL
    this.url = config.url.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeout = timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Send a command to the WorkBuddy instance.
   */
  async execute(command: WorkBuddyCommand): Promise<WorkBuddyResponse> {
    const startTime = Date.now();
    try {
      const res = await this.request('POST', '/api/command', {
        command: command.command,
        args: command.args ?? [],
        cwd: command.cwd,
        env: command.env,
      });

      const durationMs = Date.now() - startTime;
      return {
        success: res.success ?? false,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        error: res.error,
        data: res.data,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, command: command.command }, 'WorkBuddy request failed');
      return {
        success: false,
        error: `WorkBuddy request failed: ${message}`,
        durationMs,
      };
    }
  }

  /**
   * Check health of the WorkBuddy instance.
   */
  async healthCheck(): Promise<WorkBuddyHealth> {
    try {
      const res = await this.request('GET', '/api/health');
      return {
        healthy: true,
        version: res.version,
        cwd: res.cwd,
        tools: res.tools,
        uptime: res.uptime,
      };
    } catch {
      return { healthy: false };
    }
  }

  /**
   * Make an HTTP request to the WorkBuddy instance.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResponse> {
    const url = `${this.url}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as ApiResponse;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
