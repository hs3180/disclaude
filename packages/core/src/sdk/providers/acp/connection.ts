/**
 * ACP Connection Manager
 *
 * Manages the lifecycle of an ACP agent subprocess and the
 * ClientSideConnection for protocol communication.
 *
 * Handles:
 * - Subprocess spawning and cleanup
 * - NDJSON transport over stdio
 * - ACP capability negotiation (initialize handshake)
 * - Session creation and management
 * - Streaming update bridging via MessageBridge
 *
 * @module sdk/providers/acp/connection
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Writable, Readable } from 'node:stream';
import { type ACPProviderConfig, type ACPSessionState, MessageBridge } from './types.js';
import type { ACPSessionParams } from './options-adapter.js';
import { adaptACPUpdate } from './message-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ACPConnection');

/**
 * Minimal interface for the ACP ClientSideConnection.
 * Defined locally to avoid tight coupling with the ACP SDK types.
 */
interface ACPClientConnection {
  initialize(params: {
    protocolVersion: number;
    clientCapabilities: Record<string, unknown>;
    clientInfo: { name: string; version: string };
  }): Promise<unknown>;

  newSession(params: ACPSessionParams): Promise<{ sessionId: string }>;

  prompt(params: {
    sessionId: string;
    prompt: Array<{ type: 'text'; text: string }>;
  }): Promise<{ stopReason?: string }>;

  cancel(params: { sessionId: string }): Promise<void>;

  closeSession(params: { sessionId: string }): Promise<void>;
}

/**
 * ACP Client implementation for the ClientSideConnection.
 *
 * Implements the ACP Client interface to handle:
 * - session/update: Agent streaming updates → MessageBridge
 * - request_permission: Auto-approve (bypassPermissions mode)
 */
class ACPClientAdapter {
  private currentBridge: MessageBridge | null = null;

  /**
   * Set the active message bridge for the current session.
   * Called before each prompt to wire up streaming updates.
   */
  setBridge(bridge: MessageBridge): void {
    this.currentBridge = bridge;
  }

  /**
   * Handle agent streaming updates.
   *
   * Called by the ACP SDK whenever the agent sends a session/update notification.
   * Non-blocking — converts the update and pushes to the message bridge.
   */
  sessionUpdate(params: { sessionId: string; update: unknown }): void {
    if (!this.currentBridge) {
      logger.warn('Received sessionUpdate but no bridge is set');
      return;
    }

    adaptACPUpdate(
      params as { sessionId: string; update: Parameters<typeof adaptACPUpdate>[0]['update'] },
      this.currentBridge
    );
  }

  /**
   * Handle permission requests from the agent.
   *
   * In ACP, agents can request user permission before executing
   * sensitive operations (file writes, command execution, etc.).
   * We auto-approve all requests (matching bypassPermissions mode).
   */
  requestPermission(params: {
    sessionId: string;
    toolCall: unknown;
    options: Array<{ kind: string; name: string; optionId: string }>;
  }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    const { options } = params;
    // Find the "allow" option and auto-approve
    const allowOption = options.find(
      (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always'
    );
    if (allowOption) {
      return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
    }
    // Fallback: approve the first option
    if (options.length > 0) {
      return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
    }
    // No options available — cancel
    return { outcome: { outcome: 'cancelled' } };
  }

  /** Clear the active bridge after a prompt completes. */
  clearBridge(): void {
    this.currentBridge = null;
  }
}

/**
 * ACP Connection Manager.
 *
 * Manages the lifecycle of an ACP agent subprocess connection.
 * Each connection can create multiple sessions.
 */
export class ACPConnection {
  private process: ChildProcess | null = null;
  private clientAdapter: ACPClientAdapter;
  private connectionInstance: ACPClientConnection | null = null;
  private initialized = false;
  private disposed = false;

  constructor(private config: ACPProviderConfig) {
    this.clientAdapter = new ACPClientAdapter();
  }

  /**
   * Connect to the ACP agent subprocess.
   *
   * Spawns the agent process, establishes NDJSON transport,
   * and performs the ACP initialize handshake.
   */
  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Connection has been disposed');
    }
    if (this.initialized) {
      return;
    }

    const { agent } = this.config;

    // Spawn the ACP agent subprocess
    logger.info({ command: agent.command, args: agent.args }, 'Spawning ACP agent process');

    this.process = spawn(agent.command, agent.args ?? [], {
      env: { ...process.env, ...agent.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    // Handle process errors
    this.process.on('error', (err) => {
      logger.error({ err }, 'ACP agent process error');
    });

    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'ACP agent process exited');
      this.initialized = false;
      this.connectionInstance = null;
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error('Failed to spawn ACP agent: stdin/stdout not available');
    }

    // Dynamically import the ACP SDK
    const acp = await import('@agentclientprotocol/sdk');

    // Create NDJSON stream over stdio
    const stream = acp.ndJsonStream(
      Writable.toWeb(this.process.stdin),
      Readable.toWeb(this.process.stdout)
    );

    // Create client-side connection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ClientSideConnection = (acp as any).ClientSideConnection as new (
      clientFactory: () => ACPClientAdapter,
      stream: ReturnType<typeof acp.ndJsonStream>
    ) => ACPClientConnection;

    const protocolVersion = acp.PROTOCOL_VERSION;

    this.connectionInstance = new ClientSideConnection(
      () => this.clientAdapter,
      stream
    );

    // Perform ACP initialize handshake
    const clientInfo = this.config.clientInfo ?? {
      name: 'disclaude',
      version: '0.4.0',
    };

    logger.info({ clientInfo, protocolVersion }, 'Initializing ACP connection');

    await this.connectionInstance.initialize({
      protocolVersion,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo,
    });

    this.initialized = true;
    logger.info('ACP connection initialized successfully');
  }

  /**
   * Create a new ACP session.
   *
   * @param params - Session parameters (cwd, MCP servers)
   * @returns Session state with ID and message bridge
   */
  async createSession(params: ACPSessionParams): Promise<ACPSessionState> {
    this.ensureConnected();

    const sessionResponse = await this.connectionInstance!.newSession(params);
    const {sessionId} = sessionResponse;

    logger.info({ sessionId }, 'ACP session created');

    return {
      sessionId,
      bridge: new MessageBridge(),
      closed: false,
    };
  }

  /**
   * Send a prompt to an ACP session.
   *
   * Wires up the message bridge before sending the prompt,
   * so streaming updates are captured during execution.
   *
   * @param sessionId - ACP session ID
   * @param prompt - Prompt content array
   * @param bridge - Message bridge for streaming updates
   * @returns Stop reason from the agent
   */
  async prompt(
    sessionId: string,
    prompt: Array<{ type: 'text'; text: string }>,
    bridge: MessageBridge
  ): Promise<string> {
    this.ensureConnected();

    // Wire up the bridge to receive streaming updates
    this.clientAdapter.setBridge(bridge);

    try {
      const result = await this.connectionInstance!.prompt({ sessionId, prompt });
      return result.stopReason ?? 'end_turn';
    } finally {
      // Always clean up the bridge reference
      this.clientAdapter.clearBridge();
    }
  }

  /**
   * Send a cancel notification to the agent for a session.
   *
   * @param sessionId - ACP session ID
   */
  async cancel(sessionId: string): Promise<void> {
    this.ensureConnected();

    try {
      await this.connectionInstance!.cancel({ sessionId });
      logger.info({ sessionId }, 'ACP session cancelled');
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to cancel ACP session');
    }
  }

  /**
   * Close an ACP session.
   *
   * @param sessionId - ACP session ID
   */
  async closeSession(sessionId: string): Promise<void> {
    this.ensureConnected();

    try {
      await this.connectionInstance!.closeSession({ sessionId });
      logger.info({ sessionId }, 'ACP session closed');
    } catch (err) {
      logger.warn({ err, sessionId }, 'Failed to close ACP session');
    }
  }

  /**
   * Ensure the connection is active.
   * @throws Error if not connected
   */
  private ensureConnected(): void {
    if (this.disposed) {
      throw new Error('Connection has been disposed');
    }
    if (!this.initialized || !this.connectionInstance) {
      throw new Error('ACP connection not initialized. Call connect() first.');
    }
  }

  /**
   * Dispose of the connection and clean up resources.
   *
   * Kills the subprocess and releases all references.
   */
  dispose(): void {
    this.disposed = true;
    this.initialized = false;

    if (this.process && !this.process.killed) {
      logger.info('Killing ACP agent process');
      this.process.kill('SIGTERM');

      // Force kill after timeout
      const {pid} = this.process;
      setTimeout(() => {
        try {
          if (pid) {
            process.kill(pid, 0); // Check if process is still alive
            process.kill(pid, 'SIGKILL');
          }
        } catch {
          // Process already exited
        }
      }, 5000);
    }

    this.process = null;
    this.connectionInstance = null;
  }

  /** Check if the connection is active */
  get isConnected(): boolean {
    return this.initialized && !this.disposed;
  }
}
