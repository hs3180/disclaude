/**
 * REST channel control/push route handlers (Issue #4127 part 2).
 *
 * Extracted from rest-channel.ts. Owns:
 *   - POST /api/control → RouteHandlers.handleControl
 *   - POST /api/push    → RouteHandlers.handlePush
 *
 * Dependencies (input message router, body reading, error responses, control
 * emission) are injected via RouteHandlerDeps, mirroring the channels/rest/
 * file-routes.ts and session-manager.ts patterns.
 *
 * @module primary-node/channels/rest/route-handlers
 */

import crypto from 'node:crypto';
import type http from 'node:http';
import {
  createLogger,
  type ControlCommand,
  type SystemMessage,
  type MessageRouter as InputMessageRouter,
} from '@disclaude/core';

const logger = createLogger('RestRouteHandlers');

/** Dependencies injected from RestChannel. */
export interface RouteHandlerDeps {
  /** Accessor for the (optionally-configured) input message router. */
  getInputMessageRouter(): InputMessageRouter | undefined;
  /** Reads and returns the request body. */
  readBody(req: http.IncomingMessage): Promise<string>;
  /** Writes a JSON error response with the given status. */
  sendError(res: http.ServerResponse, status: number, message: string): void;
  /** Emits a control command and returns the JSON-serializable response. */
  emitControl(command: ControlCommand): Promise<unknown>;
}

/** Handles the /api/control and /api/push routes for the REST channel. */
export class RouteHandlers {
  constructor(private readonly deps: RouteHandlerDeps) {}

  /**
   * POST /api/control — dispatch a control command.
   */
  async handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.deps.readBody(req);
    if (!body) {
      this.deps.sendError(res, 400, 'Empty request body');
      return;
    }

    let command: ControlCommand;
    try {
      command = JSON.parse(body) as ControlCommand;
    } catch {
      this.deps.sendError(res, 400, 'Invalid JSON');
      return;
    }

    if (!command.type || !command.chatId) {
      this.deps.sendError(res, 400, 'type and chatId are required');
      return;
    }

    logger.info({ type: command.type, chatId: command.chatId }, 'Received control command');

    const response = await this.deps.emitControl(command);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  /**
   * POST /api/push — send a system message to an agent.
   *
   * Body: { chatId: string, message: string }
   * Response: { success: boolean, chatId: string, error?: string }
   *
   * @see Issue #3808 - External push_to_agent access via REST API
   */
  async handlePush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const inputMessageRouter = this.deps.getInputMessageRouter();
    if (!inputMessageRouter) {
      this.deps.sendError(res, 503, 'Push API not available — InputMessageRouter not configured');
      return;
    }

    const body = await this.deps.readBody(req);
    if (!body) {
      this.deps.sendError(res, 400, 'Empty request body');
      return;
    }

    let pushRequest: { chatId?: string; message?: string };
    try {
      pushRequest = JSON.parse(body) as typeof pushRequest;
    } catch {
      this.deps.sendError(res, 400, 'Invalid JSON');
      return;
    }

    if (!pushRequest.chatId || typeof pushRequest.chatId !== 'string') {
      this.deps.sendError(res, 400, 'chatId is required');
      return;
    }
    if (!pushRequest.message || typeof pushRequest.message !== 'string') {
      this.deps.sendError(res, 400, 'message is required');
      return;
    }

    const { chatId, message } = pushRequest;
    logger.info({ chatId, messageLength: message.length }, 'Received push request');

    try {
      const systemMessage: SystemMessage = {
        id: `push_${crypto.randomUUID()}`,
        source: 'system',
        trigger: 'command',
        payload: message,
        chatId,
        createdAt: new Date().toISOString(),
      };

      await inputMessageRouter.route(systemMessage);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, chatId }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId }, 'Push request failed');
      this.deps.sendError(res, 500, `Failed to push: ${errorMessage}`);
    }
  }
}
