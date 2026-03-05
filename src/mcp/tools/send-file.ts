/**
 * send_file_to_feishu tool implementation.
 *
 * This tool allows agents to upload a local file and send it to a Feishu chat.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../../utils/logger.js';
import { Config } from '../../config/index.js';
import { createClient } from '../utils/feishu-api.js';
import type { SendFileResult } from './types.js';

const logger = createLogger('SendFile');

/**
 * Tool: Send a file to Feishu chat
 *
 * This tool allows agents to upload a local file and send it to a Feishu chat.
 * Credentials are read from Config, chatId is required parameter.
 *
 * @param params - Tool parameters
 * @returns Result object with success status and file details
 */
export async function send_file_to_feishu(params: {
  filePath: string;
  chatId: string;
}): Promise<SendFileResult> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    // Graceful degradation: When Feishu credentials are not configured,
    // return a soft error instead of throwing. This allows the agent to
    // continue execution in REST channel and test environments.
    if (!appId || !appSecret) {
      logger.warn({
        filePath,
        chatId,
        reason: 'Feishu credentials not configured'
      }, 'File send skipped (Feishu not configured)');

      return {
        success: false,
        error: 'Feishu credentials not configured',
        message: '⚠️ File cannot be sent: Feishu is not configured. File will be available locally.',
      };
    }

    // Resolve file path
    const workspaceDir = Config.getWorkspaceDir();
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceDir, filePath);

    logger.debug({ filePath, resolvedPath, workspaceDir, chatId }, 'send_file_to_feishu called');

    // Check file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Import Feishu uploader (dynamic import to avoid circular dependencies)
    const { uploadAndSendFile } = await import('../../file-transfer/outbound/feishu-uploader.js');

    // Create client with credentials from Config
    const client = createClient(appId, appSecret);

    // Upload and send file
    const fileSize = await uploadAndSendFile(client, resolvedPath, chatId);

    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    const fileName = path.basename(resolvedPath);

    logger.info({
      fileName,
      fileSize,
      sizeMB,
      filePath: resolvedPath,
      chatId
    }, 'File sent successfully');

    return {
      success: true,
      message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    // Extract detailed Feishu API error information
    let feishuCode: number | undefined;
    let feishuMsg: string | undefined;
    let feishuLogId: string | undefined;
    let troubleshooterUrl: string | undefined;

    // Parse error object for Feishu-specific details
    if (error && typeof error === 'object') {
      const err = error as Error & {
        code?: number | string;
        msg?: string;
        response?: {
          data?: Array<{
            code?: number;
            msg?: string;
            log_id?: string;
            troubleshooter?: string;
          }> | unknown;
        };
      };

      // Try to extract from response data (Feishu API error format)
      if (err.response?.data) {
        const {data} = err.response;
        if (Array.isArray(data) && data[0]) {
          feishuCode = data[0].code;
          feishuMsg = data[0].msg;
          feishuLogId = data[0].log_id;
          troubleshooterUrl = data[0].troubleshooter;
        }
      }

      // Fallback to error properties
      if (!feishuCode && typeof err.code === 'number') {
        feishuCode = err.code;
      }
      if (!feishuMsg) {
        feishuMsg = err.msg || err.message;
      }
    }

    logger.error({
      err: error,
      filePath,
      chatId,
      // Detailed Feishu API error info
      feishuCode,
      feishuMsg,
      feishuLogId,
      troubleshooterUrl,
    }, 'Tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Build detailed error message for user
    let errorDetails = `❌ Failed to send file: ${errorMessage}`;

    if (feishuCode) {
      errorDetails += '\n\n**Feishu API Error Details:**';
      errorDetails += `\n- **Code:** ${feishuCode}`;
      if (feishuMsg) {
        errorDetails += `\n- **Message:** ${feishuMsg}`;
      }
      if (feishuLogId) {
        errorDetails += `\n- **Log ID:** ${feishuLogId}`;
      }
      if (troubleshooterUrl) {
        errorDetails += `\n- **Troubleshoot:** ${troubleshooterUrl}`;
      }
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
