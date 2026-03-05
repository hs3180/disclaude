/**
 * send_file_to_feishu tool implementation.
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

const logger = createLogger('SendFile');

export async function send_file_to_feishu(params: {
  filePath: string;
  chatId: string;
}): Promise<SendFileResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) { throw new Error('chatId is required'); }

    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      logger.warn({ filePath, chatId }, 'File send skipped (Feishu not configured)');
      return {
        success: false,
        error: 'Feishu credentials not configured',
        message: '⚠️ File cannot be sent: Feishu is not configured.',
      };
    }

    const workspaceDir = Config.getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, chatId }, 'send_file_to_feishu called');

    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) { throw new Error(`Path is not a file: ${filePath}`); }

    const { uploadAndSendFile } = await import('../../file-transfer/outbound/feishu-uploader.js');
    const client = createFeishuClient(appId, appSecret, { domain: lark.Domain.Feishu });
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
    let feishuCode: number | undefined;
    let feishuMsg: string | undefined;
    let feishuLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: { data?: Array<{ code?: number; msg?: string; log_id?: string; troubleshooter?: string }> | unknown };
      };

      if (err.response?.data && Array.isArray(err.response.data) && err.response.data[0]) {
        feishuCode = err.response.data[0].code;
        feishuMsg = err.response.data[0].msg;
        feishuLogId = err.response.data[0].log_id;
        troubleshooterUrl = err.response.data[0].troubleshooter;
      }
      if (!feishuCode && typeof err.code === 'number') { feishuCode = err.code; }
      if (!feishuMsg) { feishuMsg = err.msg || err.message; }
    }

    logger.error({ err: error, filePath, chatId, feishuCode, feishuMsg }, 'send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let errorDetails = `❌ Failed to send file: ${errorMessage}`;
    if (feishuCode) {
      errorDetails += `\n\n**Feishu API Error:** Code: ${feishuCode}`;
      if (feishuMsg) { errorDetails += `, Message: ${feishuMsg}`; }
    }

    return {
      success: false,
      error: errorMessage,
      message: errorDetails,
      feishuCode,
      feishuMsg,
      feishuLogId,
      troubleshooterUrl,
    };
  }
}
