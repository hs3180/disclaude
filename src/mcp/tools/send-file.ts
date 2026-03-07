/**
 * send_file tool implementation.
 *
 * Issue #1035: Now supports IPC routing to PrimaryNode for unified LarkClientService.
 * Falls back to direct client creation if IPC is not available.
 *
 * @module mcp/tools/send-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import type { SendFileResult } from './types.js';
// Issue #1035: IPC routing for unified LarkClientService
import {
  isFeishuApiIpcAvailable,
  uploadFileViaIpc,
} from '../../ipc/feishu-api-client.js';

const logger = createLogger('SendFile');

// Cache for IPC availability check
let ipcAvailable: boolean | null = null;
let ipcCheckTime = 0;
const IPC_CHECK_INTERVAL = 30000; // Re-check every 30 seconds

/**
 * Check if IPC is available, with caching.
 */
async function checkIpcAvailable(): Promise<boolean> {
  const now = Date.now();
  if (ipcAvailable !== null && now - ipcCheckTime < IPC_CHECK_INTERVAL) {
    return ipcAvailable;
  }

  ipcAvailable = await isFeishuApiIpcAvailable();
  ipcCheckTime = now;
  if (ipcAvailable) {
    logger.debug('IPC available for Feishu API requests');
  }
  return ipcAvailable;
}

export async function send_file(params: {
  filePath: string;
  chatId: string;
}): Promise<SendFileResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      logger.warn({ filePath, chatId }, 'File send skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ File cannot be sent: Platform is not configured.',
      };
    }

    const workspaceDir = Config.getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, chatId }, 'send_file called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Issue #1035: Try IPC first if available
    const useIpc = await checkIpcAvailable();

    if (useIpc) {
      // Use IPC to route through PrimaryNode's LarkClientService
      const result = await uploadFileViaIpc(chatId, resolvedPath);
      if (result.success) {
        const sizeMB = ((result.fileSize || 0) / 1024 / 1024).toFixed(2);
        logger.info({ fileName: result.fileName, fileSize: result.fileSize, chatId, via: 'IPC' }, 'File sent successfully');
        return {
          success: true,
          message: `✅ File sent: ${result.fileName} (${sizeMB} MB)`,
          fileName: result.fileName,
          fileSize: result.fileSize || 0,
          sizeMB,
        };
      }
      logger.warn({ error: result.error }, 'IPC file upload failed, falling back to direct client');
    }

    // Fallback to direct client
    const { uploadAndSendFile } = await import('../../file-transfer/outbound/feishu-uploader.js');
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
    const fileSize = await uploadAndSendFile(client, resolvedPath, chatId);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({ fileName, fileSize, chatId, via: 'direct' }, 'File sent successfully');

    return {
      success: true,
      message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    let platformCode: number | undefined;
    let platformMsg: string | undefined;
    let platformLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string; log_id?: string; troubleshooter?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        platformCode = err.response.data[0].code;
        platformMsg = err.response.data[0].msg;
        platformLogId = err.response.data[0].log_id;
        troubleshooterUrl = err.response.data[0].troubleshooter;
      }
      if (!platformCode && typeof err.code === 'number') { platformCode = err.code; }
      if (!platformMsg) { platformMsg = err.msg || err.message; }
    }

    logger.error({ err: error, filePath, chatId, platformCode, platformMsg }, 'send_file failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to send file: ${errorMessage}`;
    if (platformCode) {
      errorDetails += `\n\n**Platform API Error:** Code: ${platformCode}`;
      if (platformMsg) { errorDetails += `, Message: ${platformMsg}`; }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
      platformCode,
      platformMsg,
      platformLogId,
      troubleshooterUrl,
    };
  }
}
