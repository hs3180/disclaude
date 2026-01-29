/**
 * Feishu tools for MCP integration.
 *
 * This module provides tool definitions that can be used with
 * inline MCP servers in the Agent SDK.
 *
 * Tools provided:
 * - send_file_to_feishu: Send a file to a Feishu chat
 *
 * Environment Variables Required:
 * - FEISHU_APP_ID: Feishu app ID
 * - FEISHU_APP_SECRET: Feishu app secret
 * - WORKSPACE_DIR: Workspace directory (optional, defaults to cwd)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FeishuTools');

/**
 * Send a file to Feishu chat.
 *
 * This tool allows the Agent to upload a local file and send it
 * to a Feishu chat.
 *
 * @param params - Tool parameters
 * @param params.filePath - Path to the file to send
 * @param params.chatId - Feishu chat ID to send the file to
 * @returns Result object with success status and message
 */
export async function send_file_to_feishu(params: { filePath: string; chatId: string }): Promise<{
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  filePath?: string;
  error?: string;
}> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required - cannot send file');
    }

    // Get Feishu credentials
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in environment variables');
    }

    // Resolve file path
    const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspaceDir, filePath);

    logger.info({ filePath, resolvedPath, workspaceDir, chatId }, 'MCP tool: send_file_to_feishu called');

    // Check file exists
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    // Import Feishu uploader (dynamic import to avoid circular dependencies)
    const { uploadAndSendFile } = await import('../feishu/file-uploader.js');

    // Create client
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

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
    }, 'File sent successfully via MCP tool');

    return {
      success: true,
      message: `✅ File sent to Feishu: ${fileName} (${sizeMB} MB)`,
      fileName,
      fileSize,
      sizeMB,
      filePath: resolvedPath,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'MCP tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send file: ${errorMessage}`,
    };
  }
}

// Note: list_workspace_files tool removed as Agent has built-in Glob and Grep tools
// for file discovery. This tool was redundant and unnecessary.

/**
 * Tool definitions for Agent SDK integration.
 *
 * Export tools in a format compatible with inline MCP servers.
 *
 * IMPORTANT: These tools are automatically registered via the `tools` parameter
 * in createSdkOptions(). They do not need to be listed in `allowedTools`.
 */
export const feishuTools = {
  send_file_to_feishu: {
    description: 'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to send (relative to workspace or absolute)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID to send the file to',
        },
      },
      required: ['filePath', 'chatId'],
    },
    handler: send_file_to_feishu,
  },
};
