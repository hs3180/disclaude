/**
 * Feishu Context MCP Tools - In-process tool implementation.
 *
 * This module provides tool definitions that allow agents to send feedback
 * and files to Feishu chats directly using Feishu API.
 *
 * Tools provided:
 * - send_user_feedback: Send a message to a Feishu chat (supports text or card format)
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
 * Message sent callback type.
 * Called when a message is successfully sent to track user communication.
 */
export type MessageSentCallback = (chatId: string) => void;

/**
 * Global callback for tracking when messages are sent.
 * Set by FeishuBot to bridge MCP tool calls with message tracking.
 */
let messageSentCallback: MessageSentCallback | null = null;

/**
 * Set the callback to be invoked when messages are successfully sent.
 * This allows MCP tools to notify the dialogue bridge when user messages are sent.
 *
 * @param callback - Function to call on successful message send
 */
export function setMessageSentCallback(callback: MessageSentCallback | null): void {
  messageSentCallback = callback;
}

/**
 * Internal helper: Send a message to Feishu chat.
 *
 * Handles the common logic for sending messages to Feishu API.
 *
 * @param client - Lark client instance
 * @param chatId - Feishu chat ID
 * @param msgType - Message type ('text' or 'interactive')
 * @param content - Message content (JSON stringified)
 * @throws Error if sending fails
 */
async function sendMessageToFeishu(
  client: lark.Client,
  chatId: string,
  msgType: 'text' | 'interactive',
  content: string
): Promise<void> {
  await client.im.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content,
    },
  });
}

/**
 * Tool: Send user feedback (unified text/card message)
 *
 * This tool allows agents to send messages directly to Feishu chats.
 * Supports both text messages and interactive cards via the format parameter.
 * Credentials are read from Config, chatId is required parameter.
 *
 * CLI Mode: When chatId starts with "cli-", the message is logged
 * instead of being sent to Feishu API.
 *
 * @param params - Tool parameters
 * @returns Result object with success status
 */
export async function send_user_feedback(params: {
  content: string | Record<string, unknown>;
  format?: 'text' | 'card';
  chatId: string;
}): Promise<{
  success: boolean;
  message: string;
  error?: string;
}> {
  const { content, format, chatId } = params;

  try {
    // Auto-detect format if not specified
    let detectedFormat: 'text' | 'card';
    if (format) {
      // Explicit format takes precedence
      detectedFormat = format;
    } else {
      // Auto-detect: string → text, object → card
      detectedFormat = typeof content === 'string' ? 'text' : 'card';
    }

    if (!content) {
      throw new Error('content is required');
    }
    if (!chatId) {
      throw new Error('chatId is required');
    }

    // CLI mode: Log the message instead of sending to Feishu
    if (chatId.startsWith('cli-')) {
      const displayContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      logger.info({ chatId, format: detectedFormat, contentPreview: displayContent.substring(0, 100) }, 'CLI mode: User feedback');
      // Use console.log for direct visibility in CLI mode
      console.log(`\n${displayContent}\n`);

      // Notify callback that a message was sent (for dialogue bridge tracking)
      if (messageSentCallback) {
        try {
          messageSentCallback(chatId);
        } catch (error) {
          logger.error({ err: error }, 'Failed to invoke message sent callback');
        }
      }

      return {
        success: true,
        message: `✅ Feedback displayed (CLI mode, format: ${detectedFormat})`,
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

    if (detectedFormat === 'text') {
      // Send as text message
      const textContent = typeof content === 'string' ? content : JSON.stringify(content);
      await sendMessageToFeishu(client, chatId, 'text', JSON.stringify({ text: textContent }));

      logger.debug({
        chatId,
        messageLength: textContent.length,
        message: textContent
      }, 'User feedback sent (text)');
    } else {
      // Send as interactive card
      const cardContent = typeof content === 'object' ? content : { text: content };
      await sendMessageToFeishu(client, chatId, 'interactive', JSON.stringify(cardContent));

      logger.debug({ chatId }, 'User card sent (interactive)');
    }

    // Notify callback that a message was sent (for dialogue bridge tracking)
    if (messageSentCallback) {
      try {
        messageSentCallback(chatId);
      } catch (error) {
        logger.error({ err: error }, 'Failed to invoke message sent callback');
      }
    }

    return {
      success: true,
      message: `✅ Feedback sent (format: ${detectedFormat})`,
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
 * Tool: Send user card (deprecated wrapper)
 *
 * @deprecated Use send_user_feedback with format='card' instead.
 * This function is kept for backward compatibility.
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

  // Delegate to the unified send_user_feedback function
  const result = await send_user_feedback({
    content: card,
    format: 'card',
    chatId,
  });

  return result;
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
 * Use send_user_feedback BEFORE calling this tool to provide a final message to the user.
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
    description: 'Send a message to a Feishu chat. Supports both text and interactive card format. Use this to report progress, provide updates, or send rich content like code diffs to users.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          oneOf: [
            { type: 'string' },
            { type: 'object' }
          ],
          description: 'The content to send. Use a string for text messages, or an object for interactive cards.',
        },
        format: {
          type: 'string',
          enum: ['text', 'card'],
          description: 'Optional format specifier. If not provided, auto-detects based on content type (string→text, object→card).',
        },
        chatId: {
          type: 'string',
          description: 'Feishu chat ID (get this from the task context/metadata)',
        },
      },
      required: ['content', 'chatId'],
    },
    handler: send_user_feedback,
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
    description: 'Signal that the task is done and end the dialogue loop. Use send_user_feedback BEFORE calling this to provide a final message to the user.',
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
    'Send a message to a Feishu chat. Supports both text and interactive card format. Use this to report progress, provide updates, or send rich content like code diffs to users.',
    {
      content: z.union([z.string(), z.object({}).passthrough()]).describe('The content to send. Use a string for text messages, or an object for interactive cards.'),
      format: z.enum(['text', 'card']).optional().describe('Optional format specifier. If not provided, auto-detects based on content type (string→text, object→card).'),
      chatId: z.string().describe('Feishu chat ID (get this from the task context/metadata)'),
    },
    async ({ content, format, chatId }) => {
      try {
        const result = await send_user_feedback({ content, format, chatId });
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
    'Signal that the task is done and end the dialogue loop. Use send_user_feedback BEFORE calling this to provide a final message to the user.',
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
 * **Lifecycle:**
 * - This is a module-level singleton created once at process startup
 * - Persists for the lifetime of the application
 * - Shared across all Manager agent instances
 * - Does NOT need to be cleaned up between dialogues
 *
 * **Usage:**
 * Add this to the `mcpServers` SDK option when creating queries:
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'feishu-context': feishuSdkMcpServer,
 *     },
 *   },
 * })
 * ```
 *
 * **Memory Management:**
 * - The SDK creates per-query instances of this MCP server
 * - SDK automatically cleans up these instances when queries complete
 * - No manual cleanup required for the singleton itself
 * - Agent cleanup() methods clear session IDs, allowing SDK to release resources
 *
 * Creates an in-process MCP server that provides Feishu integration tools
 * to the Agent SDK.
 */
export const feishuSdkMcpServer = createSdkMcpServer({
  name: 'feishu-context',
  version: '1.0.0',
  tools: feishuSdkTools,
});
