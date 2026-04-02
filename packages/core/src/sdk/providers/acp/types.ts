/**
 * ACP Provider Types
 *
 * Type definitions for the ACP (Agent Client Protocol) provider.
 * ACP is a standardized protocol for communication between agent clients
 * and AI coding agents, using JSON-RPC 2.0 over stdio/SSE.
 *
 * @see https://agentclientprotocol.com/
 * @see https://github.com/agentclientprotocol/typescript-sdk
 * @module sdk/providers/acp/types
 */

import type { AgentMessage } from '../../types.js';

// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * ACP agent subprocess configuration.
 *
 * Specifies how to launch an ACP-compatible agent process.
 * The agent must implement the ACP server protocol.
 */
export interface ACPAgentConfig {
  /** Command to spawn the ACP-compatible agent (e.g., 'claude', 'npx', 'codex') */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Additional environment variables for the agent process */
  env?: Record<string, string>;
}

/**
 * ACP provider configuration.
 *
 * Passed via environment variable `ACP_PROVIDER_CONFIG` (JSON)
 * or constructed programmatically.
 *
 * @example
 * ```typescript
 * const config: ACPProviderConfig = {
 *   agent: {
 *     command: 'claude',
 *     args: ['--dangerously-skip-permissions'],
 *   },
 * };
 * ```
 */
export interface ACPProviderConfig {
  /** Agent subprocess configuration */
  agent: ACPAgentConfig;
  /** Client info for ACP capability negotiation */
  clientInfo?: {
    name: string;
    version: string;
  };
}

// ============================================================================
// Message Bridge (Callback → AsyncGenerator)
// ============================================================================

/**
 * Bridge between ACP callback-based updates and AsyncGenerator-based consumption.
 *
 * The ACP SDK calls `sessionUpdate()` on the Client interface when the agent
 * sends streaming updates. This bridge converts those callbacks into an
 * async iterator that `queryOnce`/`queryStream` can yield from.
 */
export class MessageBridge {
  private buffer: AgentMessage[] = [];
  private waiters: Array<(message: AgentMessage | null) => void> = [];
  private finished = false;

  /**
   * Push a message from the ACP sessionUpdate callback.
   * Non-blocking — immediately returns after buffering.
   */
  push(message: AgentMessage): void {
    if (this.finished) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.buffer.push(message);
    }
  }

  /**
   * Signal that no more messages will be pushed.
   * Resolves all pending waiters with null.
   */
  finish(): void {
    this.finished = true;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  /**
   * Wait for and return the next message.
   * Returns null when the bridge is finished.
   */
  next(): Promise<AgentMessage | null> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }
    if (this.finished) {
      return null;
    }
    return new Promise<AgentMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Check if the bridge has been finished */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Clear all buffered messages and waiters */
  reset(): void {
    this.buffer = [];
    this.finished = false;
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }
}

// ============================================================================
// ACP Session State
// ============================================================================

/**
 * Internal state tracking for an ACP session.
 */
export interface ACPSessionState {
  /** ACP session ID (from session/new response) */
  sessionId: string;
  /** Message bridge for streaming updates */
  bridge: MessageBridge;
  /** Whether the session has been closed */
  closed: boolean;
}
