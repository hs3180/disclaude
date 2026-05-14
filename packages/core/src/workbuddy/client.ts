/**
 * WorkBuddyClient - HTTP client for A2A communication with remote WorkBuddy agents.
 *
 * Sends commands to WorkBuddy instances and receives responses.
 * Uses fetch() for HTTP communication, following the project's pattern
 * of using nock for HTTP mocking in tests.
 *
 * @see Issue #3442
 * @module @disclaude/core/workbuddy
 */

import { createLogger } from '../utils/logger.js';
import type { A2ACommand, A2AResponse, WorkBuddyHealth, WorkBuddyStatus } from './types.js';

const logger = createLogger('WorkBuddyClient');

/** Default timeout for A2A commands (60 seconds) */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/** Default timeout for health check requests (5 seconds) */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * WorkBuddyClient options.
 */
export interface WorkBuddyClientOptions {
  /** Base URL of the WorkBuddy HTTP endpoint */
  endpoint: string;
  /** Authentication token (sent as Bearer token) */
  authToken?: string;
  /** Default timeout for commands in milliseconds */
  timeoutMs?: number;
}

/**
 * HTTP client for communicating with a remote WorkBuddy agent.
 *
 * WorkBuddy exposes a simple REST API that this client calls:
 * - POST /command  — send an A2A command, receive a response
 * - GET  /health   — check WorkBuddy health status
 *
 * @example
 * ```typescript
 * const client = new WorkBuddyClient({
 *   endpoint: 'http://localhost:8080',
 *   authToken: 'secret',
 * });
 *
 * const response = await client.sendCommand({
 *   id: 'cmd-1',
 *   type: 'execute',
 *   payload: 'echo hello',
 *   projectKey: 'my-project',
 *   createdAt: new Date().toISOString(),
 * });
 * ```
 */
export class WorkBuddyClient {
  private readonly endpoint: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;

  constructor(options: WorkBuddyClientOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  /**
   * Send an A2A command to the WorkBuddy and wait for the response.
   *
   * @param command - A2A command to send
   * @returns Response from WorkBuddy
   * @throws Error if the request fails or times out
   */
  async sendCommand(command: A2ACommand): Promise<A2AResponse> {
    const url = `${this.endpoint}/command`;
    const timeoutMs = command.timeoutMs ?? this.timeoutMs;

    logger.debug({ commandId: command.id, type: command.type, projectKey: command.projectKey }, 'Sending A2A command');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify(command),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`WorkBuddy returned HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json() as A2AResponse;
      logger.debug(
        { commandId: command.id, success: result.success },
        'Received A2A response',
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, commandId: command.id }, 'A2A command failed');
      throw new Error(`WorkBuddy command failed: ${message}`);
    }
  }

  /**
   * Check the health of the WorkBuddy agent.
   *
   * @param projectKey - Project key to check health for
   * @returns Health status information
   */
  async checkHealth(projectKey: string): Promise<WorkBuddyHealth> {
    const url = `${this.endpoint}/health?projectKey=${encodeURIComponent(projectKey)}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(this.authToken ? { 'Authorization': `Bearer ${this.authToken}` } : {}),
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          projectKey,
          status: 'error',
          lastCheckedAt: new Date().toISOString(),
        };
      }

      const health = await response.json() as WorkBuddyHealth;
      logger.debug({ projectKey, status: health.status }, 'WorkBuddy health check');
      return health;
    } catch {
      logger.debug({ projectKey }, 'WorkBuddy health check failed — marking offline');
      return {
        projectKey,
        status: 'offline' as WorkBuddyStatus,
        lastCheckedAt: new Date().toISOString(),
      };
    }
  }
}
