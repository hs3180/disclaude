/**
 * Execution Node - Handles task execution via Pilot.
 *
 * This module wraps the Pilot and connects it to the Transport layer,
 * allowing it to receive tasks from the Communication Node and send
 * messages back.
 *
 * In single-process mode, this runs alongside the Communication Node.
 * In multi-process mode, this runs in a separate process.
 */

import { Pilot, type PilotCallbacks } from '../agents/pilot.js';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import type { ITransport, TaskRequest, TaskResponse, MessageContent, ControlCommand, ControlResponse } from '../transport/index.js';

/**
 * Configuration for Execution Node.
 */
export interface ExecutionNodeConfig {
  /** Transport layer for communication */
  transport: ITransport;
  /** API key (if not provided, uses Config.getAgentConfig()) */
  apiKey?: string;
  /** Model identifier */
  model?: string;
  /** API base URL */
  apiBaseUrl?: string;
  /** Whether running in CLI mode (blocking execution) */
  isCliMode?: boolean;
}

/**
 * Execution Node - Manages Pilot and connects it to Transport.
 *
 * Responsibilities:
 * - Receives task requests from Transport
 * - Delegates to Pilot for execution
 * - Sends messages back via Transport
 */
export class ExecutionNode {
  private transport: ITransport;
  private pilot: Pilot;
  private isCliMode: boolean;
  private logger = createLogger('ExecutionNode');
  private running = false;

  constructor(config: ExecutionNodeConfig) {
    this.transport = config.transport;
    this.isCliMode = config.isCliMode ?? false;

    // Get API config from Config if not provided
    const agentConfig = Config.getAgentConfig();

    // Create Pilot callbacks that send messages via Transport
    const callbacks: PilotCallbacks = {
      sendMessage: async (chatId: string, text: string) => {
        const content: MessageContent = {
          chatId,
          type: 'text',
          text,
        };
        await this.transport.sendMessage(content);
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, description?: string) => {
        const content: MessageContent = {
          chatId,
          type: 'card',
          card,
          description,
        };
        await this.transport.sendMessage(content);
      },
      sendFile: async (chatId: string, filePath: string) => {
        const content: MessageContent = {
          chatId,
          type: 'file',
          filePath,
        };
        await this.transport.sendMessage(content);
      },
    };

    // Create Pilot instance
    this.pilot = new Pilot({
      apiKey: config.apiKey || agentConfig.apiKey,
      model: config.model || agentConfig.model,
      apiBaseUrl: config.apiBaseUrl || agentConfig.apiBaseUrl,
      isCliMode: this.isCliMode,
      callbacks,
    });

    // Register task handler with Transport
    this.transport.onTask(this.handleTask.bind(this));

    // Register control handler with Transport
    this.transport.onControl(this.handleControl.bind(this));

    this.logger.info({ isCliMode: this.isCliMode }, 'ExecutionNode created');
  }

  /**
   * Handle incoming task request from Transport.
   */
  private async handleTask(request: TaskRequest): Promise<TaskResponse> {
    this.logger.info(
      { taskId: request.taskId, chatId: request.chatId, messageId: request.messageId },
      'Received task request'
    );

    try {
      // Delegate to Pilot
      // For streaming mode (Feishu bot), use processMessage (non-blocking)
      // For CLI mode, use executeOnce (blocking)
      if (this.isCliMode) {
        await this.pilot.executeOnce(
          request.chatId,
          request.message,
          request.messageId,
          request.senderOpenId
        );
      } else {
        this.pilot.processMessage(
          request.chatId,
          request.message,
          request.messageId,
          request.senderOpenId
        );
      }

      return {
        success: true,
        taskId: request.taskId,
      };
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, taskId: request.taskId }, 'Task execution failed');
      return {
        success: false,
        error: err.message,
        taskId: request.taskId,
      };
    }
  }

  /**
   * Start the Execution Node.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('ExecutionNode already running');
      return;
    }

    await this.transport.start();
    this.running = true;
    this.logger.info('ExecutionNode started');
  }

  /**
   * Stop the Execution Node.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    await this.pilot.shutdown();
    await this.transport.stop();
    this.logger.info('ExecutionNode stopped');
  }

  /**
   * Get the underlying Pilot instance.
   * Useful for direct access in CLI mode or testing.
   */
  getPilot(): Pilot {
    return this.pilot;
  }

  /**
   * Check if the node is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Reset all Pilot states (for /reset command).
   */
  resetAll(): void {
    this.pilot.resetAll();
    this.logger.info('ExecutionNode reset');
  }

  /**
   * Handle incoming control command from Transport.
   */
  private async handleControl(command: ControlCommand): Promise<ControlResponse> {
    this.logger.info(
      { type: command.type, chatId: command.chatId },
      'Received control command'
    );

    try {
      switch (command.type) {
        case 'reset':
          this.pilot.resetAll();
          this.logger.info({ chatId: command.chatId }, 'Reset command executed');
          return {
            success: true,
            type: command.type,
          };

        case 'restart':
          // Restart is typically handled at the process level (PM2)
          // Here we just reset and let the caller know
          this.pilot.resetAll();
          this.logger.info({ chatId: command.chatId }, 'Restart command executed (reset performed)');
          return {
            success: true,
            type: command.type,
          };

        default:
          this.logger.warn({ type: command.type }, 'Unknown control command');
          return {
            success: false,
            error: `Unknown control command: ${command.type}`,
            type: command.type,
          };
      }
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, type: command.type }, 'Control command failed');
      return {
        success: false,
        error: err.message,
        type: command.type,
      };
    }
  }
}
