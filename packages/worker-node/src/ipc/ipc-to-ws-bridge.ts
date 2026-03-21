/**
 * IPC-to-WebSocket Bridge - Routes IPC requests to Primary Node via WebSocket.
 *
 * This module creates a request handler that bridges IPC requests from MCP Server
 * processes to the Primary Node via WebSocket connection.
 *
 * Request flow:
 * ```
 * MCP Server → IPC → WorkerIpcServer → Bridge → WebSocket → Primary Node
 * ```
 *
 * @module worker-node/ipc/ipc-to-ws-bridge
 */

import WebSocket from 'ws';
import { createLogger, type IpcRequest, type IpcResponse } from '@disclaude/core';

const logger = createLogger('IpcToWsBridge');

/**
 * Pending request tracker for WebSocket response correlation.
 */
interface PendingRequest {
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Configuration for the IPC-to-WebSocket bridge.
 */
export interface IpcToWsBridgeConfig {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Default configuration.
 */
const DEFAULT_BRIDGE_CONFIG: Required<IpcToWsBridgeConfig> = {
  timeout: 30000,
};

/**
 * Generate a unique request ID.
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Map IPC request type to WebSocket action.
 */
function mapIpcRequestToWsAction(type: string): string | null {
  switch (type) {
    case 'feishuSendMessage':
      return 'sendMessage';
    case 'feishuSendCard':
      return 'sendCard';
    case 'feishuUploadFile':
      return 'uploadFile';
    case 'feishuGetBotInfo':
      return 'getBotInfo';
    default:
      return null;
  }
}

/**
 * Create an IPC request handler that bridges requests to WebSocket.
 *
 * This function returns a request handler suitable for use with WorkerIpcServer.
 * The handler:
 * 1. Receives IPC requests from MCP Server
 * 2. Forwards them to Primary Node via WebSocket
 * 3. Waits for response and returns it
 *
 * @param getWsClient - Function that returns the current WebSocket connection
 * @param config - Bridge configuration
 * @returns Request handler function for WorkerIpcServer
 */
export function createIpcToWsBridge(
  getWsClient: () => WebSocket | undefined,
  config: IpcToWsBridgeConfig = {}
): (request: IpcRequest) => Promise<IpcResponse> {
  const timeout = config.timeout ?? DEFAULT_BRIDGE_CONFIG.timeout;
  const pendingRequests = new Map<string, PendingRequest>();
  let messageHandlerAttached = false;

  // Ensure WebSocket message handler is attached
  const ensureMessageHandler = (): void => {
    const wsClient = getWsClient();
    if (!wsClient || messageHandlerAttached) {
      return;
    }

    // Handle WebSocket responses from Primary Node
    const handleWsMessage = (data: Buffer): void => {
      try {
        const message = JSON.parse(data.toString());

        // Handle Feishu API response from Primary Node
        if (message.type === 'feishu-api-response') {
          const { requestId, success, data: responseData, error } = message;
          const pending = pendingRequests.get(requestId);

          if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(requestId);

            const response: IpcResponse = {
              id: requestId,
              success,
              payload: responseData,
              error,
            };

            pending.resolve(response);
            logger.debug({ requestId, success }, 'WebSocket response received and routed to IPC client');
          } else {
            logger.warn({ requestId }, 'Received response for unknown request');
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Failed to parse WebSocket message');
      }
    };

    wsClient.on('message', handleWsMessage);

    // Clean up on close
    wsClient.on('close', () => {
      for (const [requestId, pending] of pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('WebSocket connection closed'));
        pendingRequests.delete(requestId);
      }
      messageHandlerAttached = false;
    });

    messageHandlerAttached = true;
  };

  // Return request handler
  // eslint-disable-next-line require-await
  return async (request: IpcRequest): Promise<IpcResponse> => {
    // Ensure message handler is attached
    ensureMessageHandler();

    const wsClient = getWsClient();

    // Check WebSocket connection
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) {
      logger.error({ requestId: request.id, type: request.type }, 'WebSocket not connected to Primary Node');
      return {
        id: request.id,
        success: false,
        error: 'WebSocket not connected to Primary Node',
      };
    }

    // Generate unique request ID for WebSocket correlation
    const wsRequestId = generateRequestId();

    // Map IPC request type to WebSocket action
    const action = mapIpcRequestToWsAction(request.type);

    if (!action) {
      logger.error({ requestId: request.id, type: request.type }, 'Unknown IPC request type');
      return {
        id: request.id,
        success: false,
        error: `Unknown request type: ${request.type}`,
      };
    }

    // Create WebSocket request message
    const wsMessage = {
      type: 'feishu-api-request',
      requestId: wsRequestId,
      action,
      params: request.payload,
    };

    logger.debug(
      { ipcRequestId: request.id, wsRequestId, action },
      'Forwarding IPC request to Primary Node via WebSocket'
    );

    // Create promise for response
    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(wsRequestId);
        logger.warn({ requestId: request.id, wsRequestId, timeout }, 'Request to Primary Node timed out');
        reject(new Error(`Request timeout after ${timeout}ms`));
      }, timeout);

      // Store pending request
      pendingRequests.set(wsRequestId, {
        resolve: (response: IpcResponse) => {
          // Map the response back to original request ID
          response.id = request.id;
          resolve(response);
        },
        reject,
        timeout: timeoutId,
      });

      // Send request via WebSocket
      try {
        wsClient.send(JSON.stringify(wsMessage));
      } catch (error) {
        pendingRequests.delete(wsRequestId);
        clearTimeout(timeoutId);
        logger.error({ err: error, requestId: request.id }, 'Failed to send WebSocket message');
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
}
