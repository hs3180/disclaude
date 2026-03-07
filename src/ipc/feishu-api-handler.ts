/**
 * Feishu API IPC Handler for cross-process Feishu API requests.
 *
 * Issue #1035: Allows MCP tools to send Feishu API requests via IPC
 * to the PrimaryNode, which uses the unified LarkClientService.
 *
 * @module ipc/feishu-api-handler
 */

import { createLogger } from '../utils/logger.js';
import { getLarkClientService, isLarkClientServiceInitialized } from '../services/index.js';
import type { IpcRequest, IpcResponse } from './protocol.js';

const logger = createLogger('FeishuApiHandler');

/**
 * Handle a Feishu API IPC request.
 * Routes the request to the appropriate LarkClientService method.
 */
export async function handleFeishuApiRequest(
  request: IpcRequest<'feishuApi'>
): Promise<IpcResponse<'feishuApi'>> {
  const { action, params } = request.payload;

  // Check if LarkClientService is initialized
  if (!isLarkClientServiceInitialized()) {
    logger.error('LarkClientService not initialized');
    return {
      id: request.id,
      success: false,
      error: 'LarkClientService not initialized in PrimaryNode',
    };
  }

  const service = getLarkClientService();

  try {
    switch (action) {
      case 'sendMessage': {
        const { chatId, content, threadId } = params;
        if (!chatId || !content) {
          return {
            id: request.id,
            success: false,
            payload: { success: false, error: 'chatId and content are required' },
          };
        }
        await service.sendMessage(chatId, content, { threadId });
        logger.debug({ chatId, threadId }, 'sendMessage via IPC completed');
        return {
          id: request.id,
          success: true,
          payload: { success: true },
        };
      }

      case 'sendCard': {
        const { chatId, card, threadId, description } = params;
        if (!chatId || !card) {
          return {
            id: request.id,
            success: false,
            payload: { success: false, error: 'chatId and card are required' },
          };
        }
        await service.sendCard(chatId, card, { threadId, description });
        logger.debug({ chatId, threadId, description }, 'sendCard via IPC completed');
        return {
          id: request.id,
          success: true,
          payload: { success: true },
        };
      }

      case 'uploadFile': {
        const { chatId, filePath, threadId } = params;
        if (!chatId || !filePath) {
          return {
            id: request.id,
            success: false,
            payload: { success: false, error: 'chatId and filePath are required' },
          };
        }
        const result = await service.uploadFile(chatId, filePath, { threadId });
        logger.debug({ chatId, filePath, fileSize: result.fileSize }, 'uploadFile via IPC completed');
        return {
          id: request.id,
          success: true,
          payload: {
            success: true,
            fileName: result.fileName,
            fileSize: result.fileSize,
          },
        };
      }

      default: {
        const unknownAction = action as string;
        logger.error({ action: unknownAction }, 'Unknown Feishu API action');
        return {
          id: request.id,
          success: false,
          payload: { success: false, error: `Unknown action: ${unknownAction}` },
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, action, params }, 'Feishu API request failed');
    return {
      id: request.id,
      success: false,
      payload: { success: false, error: errorMessage },
    };
  }
}

/**
 * Create an IPC request handler that combines Feishu API handling
 * with existing interactive message handling.
 */
export function createCombinedHandler(
  existingHandler: (request: IpcRequest) => Promise<IpcResponse>
): (request: IpcRequest) => Promise<IpcResponse> {
  return async (request: IpcRequest): Promise<IpcResponse> => {
    if (request.type === 'feishuApi') {
      return handleFeishuApiRequest(request as IpcRequest<'feishuApi'>);
    }
    return existingHandler(request);
  };
}
