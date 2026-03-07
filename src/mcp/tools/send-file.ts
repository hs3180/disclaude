/**
 * send_file tool implementation.
 *
 * @module mcp/tools/send-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { getLarkClientService, isLarkClientServiceInitialized } from '../../services/index.js';
import type { SendFileResult } from './types.js';

const logger = createLogger('SendFile');

export async function send_file(params: {
  filePath: string;
  chatId: string;
}): Promise<SendFileResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }

    // Issue #1030: Use unified LarkClientService instead of creating own client
    if (!isLarkClientServiceInitialized()) {
      const errorMsg = 'LarkClientService not initialized. Cannot send file.';
      logger.warn({ filePath, chatId }, errorMsg);
      return {
        success: false,
        error: errorMsg,
        message: `⚠️ ${errorMsg}`,
      };
    }

    const workspaceDir = Config.getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, chatId }, 'send_file called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    const { uploadAndSendFile } = await import('../../file-transfer/outbound/feishu-uploader.js');
    const client = getLarkClientService().getClient();
    const fileSize = await uploadAndSendFile(client, resolvedPath, chatId);

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
