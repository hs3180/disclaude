/**
 * Feishu Context MCP Tools - In-process tool implementation.
 *
 * This module provides tool definitions that allow agents to send feedback
 * and files to Feishu chats directly using Feishu API.
 *
 * Tools provided:
 * - send_user_feedback: Send a text message to a Feishu chat
 * - send_user_card: Send an interactive card to a Feishu chat
 * - send_file_to_feishu: Send a file to a Feishu chat
 * - task_done: Signal task completion and end dialogue loop
 *
 * **No global state**: Credentials are read from Config, chatId is passed as parameter.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('FeishuContextMCP');

/**
 * Tool: Send user feedback (text message)
 *
 * This tool allows agents to send text messages directly to Feishu chats.
 * Credentials are read from Config, chatId is required parameter.
 *
 * CLI Mode: When chatId starts with "cli-", the message is logged
 * instead of being sent to Feishu API.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function send_user_feedback(params: {
  message: string;
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
  const { message, chatId } = params;

  try {
    if (!message) {
      throw new Error('message is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Log the message instead of sending to Feishu
    if (chatId.startsWith('cli-')) {
      logger.info({ chatId, message: message.substring(0, 100) }, 'CLI mode: User feedback');
      // Use console.log for direct visibility in CLI mode
      console.log(`\n${message}\n`);
      return {
        success: true,
        message: '✅ Feedback displayed (CLI mode)',
      };
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured in Config');
    }

    // Create Lark client and send message
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: message }),
      },
    });

    logger.debug({
      chatId,
      messageLength: message.length,
      message: message
    }, 'User feedback sent');

    return {
      success: true,
      message: '✅ Feedback sent',
    };

  } catch (error) {
    logger.error({ err: error }, 'Tool: send_user_feedback failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send feedback: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Send user feedback (interactive card)
 *
 * This tool allows agents to send interactive cards to Feishu chats.
 * Use this for rich content like code diffs, formatted output, etc.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function send_user_card(params: {
  card: Record<string, unknown>;
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
  const { card, chatId } = params;

  try {
    if (!card) {
      throw new Error('card is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured in Config');
    }

    // Create Lark client and send card
    const client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });

    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });

    logger.debug({ chatId }, 'User card sent');

    return {
      success: true,
      message: '✅ Card sent',
    };

  } catch (error) {
    logger.error({ err: error }, 'Tool: send_user_card failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send card: ${errorMessage}`,
    };
  }
}

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
}): Promise<{
  success: boolean;
  message: string;
  fileName?: string;
  fileSize?: number;
  sizeMB?: string;
  error?: string;
}> {
  const { filePath, chatId } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // Read credentials from Config
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be configured in Config');
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
    const { uploadAndSendFile } = await import('../feishu/file-uploader.js');

    // Create client with credentials from Config
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
    }, 'File sent successfully');

    return {
      success: true,
      message: `✅ File sent: ${fileName} (${sizeMB} MB)`,
      fileName,
      fileSize,
      sizeMB,
    };

  } catch (error) {
    logger.error({ err: error, filePath }, 'Tool: send_file_to_feishu failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      error: errorMessage,
      message: `❌ Failed to send file: ${errorMessage}`,
    };
  }
}

/**
 * Tool: Signal task completion
 *
 * This tool signals that the task is done and the dialogue loop should end.
 * Use send_user_feedback or send_user_card BEFORE calling this tool to provide
 * a final message to the user.
 *
 * @param params - Tool parameters
 * @returns Result object with completion status
 */
export function task_done(params: {
  chatId: string;
  taskId?: string;
  files?: string[];
}): {
  success: boolean;
  completed: boolean;
  message: string;
} {
  const { chatId, taskId, files } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // The completion signal is detected by the dialogue bridge
    logger.info({
      chatId,
      taskId,
      fileCount: files?.length ?? 0,
    }, 'Task completion signaled');

    return {
      success: true,
      completed: true,
      message: 'Task completed.',
    };

  } catch (error) {
    logger.error({ err: error }, 'Tool: task_done failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      completed: false,
      message: `Failed to signal completion: ${errorMessage}`,
    };
  }
}

/**
 * Task definition details interface.
 */
export interface TaskDefinitionDetails {
  primary_goal: string;
  success_criteria: string[];
  expected_outcome: string;
  deliverables: string[];
  format_requirements: string[];
  constraints: string[];
  quality_criteria: string[];
}

/**
 * Tool: Finalize task definition
 *
 * This tool signals that the task definition phase is complete.
 * It provides structured task details that will be appended to Task.md
 * before the execution phase begins.
 *
 * @param params - Tool parameters
 * @returns Result object with task definition details
 */
export function finalize_task_definition(params: {
  primary_goal: string;
  success_criteria: string[];
  expected_outcome: string;
  deliverables: string[];
  format_requirements?: string[];
  constraints?: string[];
  quality_criteria?: string[];
  chatId: string;
}): {
  success: boolean;
  completed: boolean;
  message: string;
  taskDetails: TaskDefinitionDetails;
} {
  const {
    primary_goal,
    success_criteria,
    expected_outcome,
    deliverables,
    format_requirements = [],
    constraints = [],
    quality_criteria = [],
    chatId,
  } = params;

  try {
    if (!chatId) {
      throw new Error('chatId is required');
    }
    if (!primary_goal) {
      throw new Error('primary_goal is required');
    }

    const taskDetails: TaskDefinitionDetails = {
      primary_goal,
      success_criteria,
      expected_outcome,
      deliverables,
      format_requirements,
      constraints,
      quality_criteria,
    };

    logger.info({
      chatId,
      primaryGoal: primary_goal.substring(0, 50),
      deliverableCount: deliverables.length,
    }, 'Task definition finalized');

    return {
      success: true,
      completed: true,
      message: 'Task definition complete.',
      taskDetails,
    };

  } catch (error) {
    logger.error({ err: error }, 'Tool: finalize_task_definition failed');

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      success: false,
      completed: false,
      message: `Failed to finalize task definition: ${errorMessage}`,
      taskDetails: {
        primary_goal: '',
        success_criteria: [],
        expected_outcome: '',
        deliverables: [],
        format_requirements: [],
        constraints: [],
        quality_criteria: [],
      },
    };
  }
}

/**
 * Tool definitions for Agent SDK integration.
 *
 * Export tools in a format compatible with inline MCP servers.
 *
 * IMPORTANT: These tools should be registered via the `tools` parameter
 * in createSdkOptions(), not listed in `allowedTools`.
 */
export const feishuContextTools = {
  send_user_feedback: {
    description: 'Send a text message to a Feishu chat. Use this to report progress or provide updates to users.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The message text to send',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['message', 'chatId'],
    },
    handler: send_user_feedback,
  },
  send_user_card: {
    description: 'Send an interactive card to a Feishu chat. Use this for rich content like code diffs, formatted output, etc.',
    parameters: {
      type: 'object',
      properties: {
        card: {
          type: 'object',
          description: 'The card JSON structure to send',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['card', 'chatId'],
    },
    handler: send_user_card,
  },
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
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['filePath', 'chatId'],
    },
    handler: send_file_to_feishu,
  },
  task_done: {
    description: 'Signal that the task is done and end the dialogue loop. Use send_user_feedback or send_user_card BEFORE calling this to provide a final message to the user.',
    parameters: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
        taskId: {
          type: 'string',
          description: 'Optional task ID for tracking',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of files created/modified',
        },
      },
      required: ['chatId'],
    },
    handler: task_done,
  },
  finalize_task_definition: {
    description: 'Signal that the task definition phase is complete. Provide structured task details including objectives, deliverables, and quality criteria.',
    parameters: {
      type: 'object',
      properties: {
        primary_goal: {
          type: 'string',
          description: 'The primary goal of the task - what should be achieved',
        },
        success_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific conditions that indicate the task is complete',
        },
        expected_outcome: {
          type: 'string',
          description: 'What the user will receive when the task is complete',
        },
        deliverables: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of specific outputs (files, reports, code, etc.)',
        },
        format_requirements: {
          type: 'array',
          items: { type: 'string' },
          description: 'Required formats or structures for deliverables',
        },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limitations or requirements (time, resources, technology, etc.)',
        },
        quality_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'Standards for quality (performance, readability, maintainability, etc.)',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['primary_goal', 'success_criteria', 'expected_outcome', 'deliverables', 'chatId'],
    },
    handler: finalize_task_definition,
  },
};

/**
 * SDK-compatible tool definitions.
 *
 * Converts feishuContextTools to the format expected by the Agent SDK:
 * - Array format (not object with keys)
 * - Zod schemas for input validation
 * - Proper SdkMcpToolDefinition structure
 */
import { z } from 'zod';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

/**
 * Helper to create a successful tool result.
 * Returns content in MCP CallToolResult format.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Helper to create an error tool result.
 */
function toolError(errorMessage: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: `❌ Error: ${errorMessage}` }],
    isError: true,
  };
}

// SDK-compatible tools array
export const feishuSdkTools = [
  tool(
    'send_user_feedback',
    'Send a text message to a Feishu chat. Use this to report progress or provide updates to users.',
    {
      message: z.string().describe('The message text to send'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ message, chatId }) => {
      try {
        const result = await send_user_feedback({ message, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolError(result.error || 'Unknown error');
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
  tool(
    'send_user_card',
    'Send an interactive card to a Feishu chat. Use this for rich content like code diffs, formatted output, etc.',
    {
      card: z.object({}).passthrough().describe('The card JSON structure to send'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ card, chatId }) => {
      try {
        const result = await send_user_card({ card, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolError(result.error || 'Unknown error');
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
  tool(
    'send_file_to_feishu',
    'Send a file to a Feishu chat. Supports images, audio, video, and documents.',
    {
      filePath: z.string().describe('Path to the file to send (relative to workspace or absolute)'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ filePath, chatId }) => {
      try {
        const result = await send_file_to_feishu({ filePath, chatId });
        if (result.success) {
          return toolSuccess(result.message);
        } else {
          return toolError(result.error || 'Unknown error');
        }
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
  tool(
    'task_done',
    'Signal that the task is done and end the dialogue loop. Use send_user_feedback or send_user_card BEFORE calling this to provide a final message to the user.',
    {
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
      taskId: z.string().optional().describe('Optional task ID for tracking'),
      files: z.array(z.string()).optional().describe('Optional list of files created/modified'),
    },
    async ({ chatId, taskId, files }) => {
      try {
        const result = task_done({ chatId, taskId, files });
        return toolSuccess(result.message);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
  tool(
    'finalize_task_definition',
    'Signal that the task definition phase is complete. Provide structured task details including objectives, deliverables, and quality criteria.',
    {
      primary_goal: z.string().describe('The primary goal of the task - what should be achieved'),
      success_criteria: z.array(z.string()).describe('Specific conditions that indicate the task is complete'),
      expected_outcome: z.string().describe('What the user will receive when the task is complete'),
      deliverables: z.array(z.string()).describe('List of specific outputs (files, reports, code, etc.)'),
      format_requirements: z.array(z.string()).optional().describe('Required formats or structures for deliverables'),
      constraints: z.array(z.string()).optional().describe('Limitations or requirements (time, resources, technology, etc.)'),
      quality_criteria: z.array(z.string()).optional().describe('Standards for quality (performance, readability, maintainability, etc.)'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ primary_goal, success_criteria, expected_outcome, deliverables, format_requirements, constraints, quality_criteria, chatId }) => {
      try {
        const result = finalize_task_definition({
          primary_goal,
          success_criteria,
          expected_outcome,
          deliverables,
          format_requirements,
          constraints,
          quality_criteria,
          chatId,
        });
        return toolSuccess(result.message);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  ),
];

/**
 * SDK MCP Server for Feishu context tools.
 *
 * Creates an in-process MCP server that provides Feishu integration tools
 * to the Agent SDK. Use this by adding it to the `mcpServers` SDK option.
 */
export const feishuSdkMcpServer = createSdkMcpServer({
  name: 'feishu-context',
  version: '1.0.0',
  tools: feishuSdkTools,
});
