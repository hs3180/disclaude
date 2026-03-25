/**
 * send_file tool implementation.
 *
 * @module mcp-server/tools/send-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import type { SendFileResult } from './types.js';

const logger = createLogger('SendFile');

/**
 * Upload file via IPC to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 */
async function uploadFileViaIpc(
  chatId: string,
  filePath: string
): Promise<{ fileKey: string; fileType: string; fileName: string; fileSize: number }> {
  const ipcClient = getIpcClient();
  const result = await ipcClient.uploadFile(chatId, filePath);
  if (!result.success) {
    throw new Error('Failed to upload file via IPC');
  }
  return {
    fileKey: result.fileKey ?? '',
    fileType: result.fileType ?? 'file',
    fileName: result.fileName ?? path.basename(filePath),
    fileSize: result.fileSize ?? 0,
  };
}

export async function send_file(params: {
  filePath: string;
  chatId: string;
}): Promise<SendFileResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }

    const { appId, appSecret } = getFeishuCredentials();

    if (!appId || !appSecret) {
      logger.warn({ filePath, chatId }, 'File send skipped (platform not configured)');
      return {
        success: false,
        error: 'Platform credentials not configured',
        message: '⚠️ File cannot be sent: Platform is not configured.',
      };
    }

    const workspaceDir = getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, chatId }, 'send_file called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    // Issue #1035: Try IPC first if available
    // Issue #1042: Removed file-transfer fallback, require IPC
    // Issue #1355: async connection probe
    const useIpc = await isIpcAvailable();

    if (!useIpc) {
      return {
        success: false,
        error: 'IPC not available',
        message: '❌ File upload requires IPC connection. Please ensure Primary Node is running.',
      };
    }

    logger.debug({ chatId, filePath }, 'Using IPC for file upload');
    const { fileSize } = await uploadFileViaIpc(chatId, resolvedPath);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({ fileName, fileSize, chatId }, 'File sent successfully');

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
