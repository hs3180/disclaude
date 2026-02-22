/**
 * LocalTransport - In-process transport implementation.
 *
 * This transport is used when Communication Node and Execution Node
 * are running in the same process. It uses direct function calls
 * without any network overhead.
 *
 * Usage:
 * ```typescript
 * const transport = new LocalTransport();
 *
 * // Communication Node side
 * transport.onMessage(async (content) => {
 *   // Send to Feishu
 * });
 * const response = await transport.sendTask(request);
 *
 * // Execution Node side
 * transport.onTask(async (request) => {
 *   // Process task
 *   return { success: true, taskId: request.taskId };
 * });
 * await transport.sendMessage({ chatId, type: 'text', text: 'Hello' });
 * ```
 */

import type {
  ITransport,
  TaskRequest,
  TaskResponse,
  TaskHandler,
  MessageContent,
  MessageHandler,
  ControlCommand,
  ControlResponse,
  ControlHandler,
} from './types.js';
import { createLogger } from '../utils/logger.js';

/**
 * LocalTransport implements ITransport for in-process communication.
 *
 * It maintains handlers for both directions:
 * - taskHandler: Called when sendTask() is invoked (Execution Node handler)
 * - messageHandler: Called when sendMessage() is invoked (Communication Node handler)
 * - controlHandler: Called when sendControl() is invoked (Execution Node handler)
 */
export class LocalTransport implements ITransport {
  private taskHandler?: TaskHandler;
  private messageHandler?: MessageHandler;
  private controlHandler?: ControlHandler;
  private running = false;
  private logger = createLogger('LocalTransport');

  /**
   * Send a task request - directly calls the registered task handler.
   */
  async sendTask(request: TaskRequest): Promise<TaskResponse> {
    if (!this.running) {
      this.logger.warn('Transport not started, task may fail');
    }

    if (!this.taskHandler) {
      this.logger.error({ taskId: request.taskId }, 'No task handler registered');
      return {
        success: false,
        error: 'No task handler registered',
        taskId: request.taskId,
      };
    }

    this.logger.debug({ taskId: request.taskId, chatId: request.chatId }, 'Sending task');

    try {
      const response = await this.taskHandler(request);
      this.logger.debug({ taskId: request.taskId, success: response.success }, 'Task completed');
      return response;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, taskId: request.taskId }, 'Task handler error');
      return {
        success: false,
        error: err.message,
        taskId: request.taskId,
      };
    }
  }

  /**
   * Register a task handler - called by Execution Node.
   */
  onTask(handler: TaskHandler): void {
    this.taskHandler = handler;
    this.logger.debug('Task handler registered');
  }

  /**
   * Send a message - directly calls the registered message handler.
   */
  async sendMessage(content: MessageContent): Promise<void> {
    if (!this.running) {
      this.logger.warn('Transport not started, message may fail');
    }

    if (!this.messageHandler) {
      this.logger.error({ chatId: content.chatId, type: content.type }, 'No message handler registered');
      throw new Error('No message handler registered');
    }

    this.logger.debug({ chatId: content.chatId, type: content.type }, 'Sending message');

    try {
      await this.messageHandler(content);
      this.logger.debug({ chatId: content.chatId }, 'Message sent');
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, chatId: content.chatId }, 'Message handler error');
      throw err;
    }
  }

  /**
   * Register a message handler - called by Communication Node.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    this.logger.debug('Message handler registered');
  }

  /**
   * Send a control command - directly calls the registered control handler.
   */
  async sendControl(command: ControlCommand): Promise<ControlResponse> {
    if (!this.running) {
      this.logger.warn('Transport not started, control command may fail');
    }

    if (!this.controlHandler) {
      this.logger.error({ type: command.type }, 'No control handler registered');
      return {
        success: false,
        error: 'No control handler registered',
        type: command.type,
      };
    }

    this.logger.debug({ type: command.type, chatId: command.chatId }, 'Sending control command');

    try {
      const response = await this.controlHandler(command);
      this.logger.debug({ type: command.type, success: response.success }, 'Control command completed');
      return response;
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, type: command.type }, 'Control handler error');
      return {
        success: false,
        error: err.message,
        type: command.type,
      };
    }
  }

  /**
   * Register a control handler - called by Execution Node.
   */
  onControl(handler: ControlHandler): void {
    this.controlHandler = handler;
    this.logger.debug('Control handler registered');
  }

  /**
   * Start the transport.
   * For LocalTransport, this just marks the transport as running.
   */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info('LocalTransport started');
  }

  /**
   * Stop the transport.
   * For LocalTransport, this just marks the transport as stopped.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.logger.info('LocalTransport stopped');
  }

  /**
   * Check if the transport is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
