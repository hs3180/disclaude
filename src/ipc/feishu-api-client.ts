/**
 * Feishu API IPC Client for MCP tools.
 *
 * Issue #1035: Provides a client for MCP tools to send Feishu API requests
 * to the PrimaryNode via IPC.
 *
 * @module ipc/feishu-api-client
 */

import { createLogger } from '../utils/logger.js';
import { UnixSocketIpcClient } from './unix-socket-client.js';
import { FEISHU_API_IPC_CONFIG, type FeishuApiAction, type IpcResponsePayloads } from './protocol.js';

const logger = createLogger('FeishuApiIpcClient');

let feishuApiClient: UnixSocketIpcClient | null = null;

/**
 * Get or create the Feishu API IPC client.
 */
export function getFeishuApiClient(): UnixSocketIpcClient {
  if (!feishuApiClient) {
    feishuApiClient = new UnixSocketIpcClient(FEISHU_API_IPC_CONFIG);
  }
  return feishuApiClient;
}

/**
 * Reset the Feishu API IPC client (for testing).
 */
export function resetFeishuApiClient(): void {
  if (feishuApiClient) {
    feishuApiClient.disconnect().catch(() => {});
  }
  feishuApiClient = null;
}

/**
 * Check if the Feishu API IPC server is available.
 * Returns true if the socket file exists and the server responds to ping.
 */
export async function isFeishuApiIpcAvailable(): Promise<boolean> {
  try {
    const client = getFeishuApiClient();
    await client.connect();
    const result = await client.ping();
    return result;
  } catch {
    return false;
  }
}

/**
 * Feishu API request parameters.
 */
export interface FeishuApiParams {
  chatId: string;
  content?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  threadId?: string;
  description?: string;
}

/**
 * Send a Feishu API request via IPC.
 *
 * @param action - The Feishu API action to perform
 * @param params - The parameters for the action
 * @returns The response payload
 */
export async function sendFeishuApiRequest(
  action: FeishuApiAction,
  params: FeishuApiParams
): Promise<IpcResponsePayloads['feishuApi']> {
  const client = getFeishuApiClient();

  try {
    const response = await client.request('feishuApi', {
      action,
      params: {
        chatId: params.chatId,
        content: params.content,
        card: params.card,
        filePath: params.filePath,
        threadId: params.threadId,
        description: params.description,
      },
    });

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, action }, 'Feishu API IPC request failed');
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Send a text message via IPC.
 */
export async function sendMessageViaIpc(
  chatId: string,
  content: string,
  threadId?: string
): Promise<IpcResponsePayloads['feishuApi']> {
  return sendFeishuApiRequest('sendMessage', { chatId, content, threadId });
}

/**
 * Send a card message via IPC.
 */
export async function sendCardViaIpc(
  chatId: string,
  card: Record<string, unknown>,
  threadId?: string,
  description?: string
): Promise<IpcResponsePayloads['feishuApi']> {
  return sendFeishuApiRequest('sendCard', { chatId, card, threadId, description });
}

/**
 * Upload a file via IPC.
 */
export async function uploadFileViaIpc(
  chatId: string,
  filePath: string,
  threadId?: string
): Promise<IpcResponsePayloads['feishuApi']> {
  return sendFeishuApiRequest('uploadFile', { chatId, filePath, threadId });
}
