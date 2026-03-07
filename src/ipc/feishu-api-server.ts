/**
 * Feishu API IPC Server for PrimaryNode.
 *
 * Issue #1035: Provides a dedicated IPC server for Feishu API requests
 * from MCP tools running in separate processes.
 *
 * @module ipc/feishu-api-server
 */

import { createLogger } from '../utils/logger.js';
import { UnixSocketIpcServer, type IpcRequestHandler } from './unix-socket-server.js';
import { FEISHU_API_IPC_CONFIG, type IpcRequest, type IpcResponse } from './protocol.js';
import { handleFeishuApiRequest } from './feishu-api-handler.js';

const logger = createLogger('FeishuApiIpcServer');

let feishuApiServer: UnixSocketIpcServer | null = null;

/**
 * Handler for Feishu API IPC requests.
 */
const feishuApiHandler: IpcRequestHandler = async (request: IpcRequest): Promise<IpcResponse> => {
  if (request.type === 'feishuApi') {
    return handleFeishuApiRequest(request as IpcRequest<'feishuApi'>);
  }

  // Handle ping for health check
  if (request.type === 'ping') {
    return { id: request.id, success: true, payload: { pong: true } };
  }

  return {
    id: request.id,
    success: false,
    error: `Unsupported request type: ${request.type}. This server only handles feishuApi requests.`,
  };
};

/**
 * Start the Feishu API IPC server.
 * Should be called during PrimaryNode startup.
 */
export async function startFeishuApiIpcServer(): Promise<void> {
  if (feishuApiServer) {
    logger.warn('Feishu API IPC server already running');
    return;
  }

  feishuApiServer = new UnixSocketIpcServer(feishuApiHandler, FEISHU_API_IPC_CONFIG);

  try {
    await feishuApiServer.start();
    logger.info(
      { path: feishuApiServer.getSocketPath() },
      'Feishu API IPC server started'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Feishu API IPC server');
    feishuApiServer = null;
    throw error;
  }
}

/**
 * Stop the Feishu API IPC server.
 * Should be called during PrimaryNode shutdown.
 */
export async function stopFeishuApiIpcServer(): Promise<void> {
  if (feishuApiServer) {
    await feishuApiServer.stop();
    feishuApiServer = null;
    logger.info('Feishu API IPC server stopped');
  }
}

/**
 * Check if the Feishu API IPC server is running.
 */
export function isFeishuApiIpcServerRunning(): boolean {
  return feishuApiServer?.isRunning() ?? false;
}

/**
 * Get the Feishu API IPC server socket path.
 */
export function getFeishuApiIpcSocketPath(): string | null {
  return feishuApiServer?.getSocketPath() ?? null;
}
