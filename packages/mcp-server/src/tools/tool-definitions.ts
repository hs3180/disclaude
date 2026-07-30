/**
 * MCP tool definitions (schemas) for tools/list.
 *
 * Issue #4128: Extracted from cli.ts handleRequest() to separate
 * tool schemas from request dispatch logic.
 *
 * @module mcp-server/tools/tool-definitions
 */

/**
 * MCP tool definition used in tools/list responses.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * All MCP tool definitions for tools/list.
 */
export const toolDefinitions: McpToolDefinition[] = [
  {
    name: 'send_text',
    description: 'Send a plain text message to a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text message content.',
        },
        chatId: {
          type: 'string',
          description: 'Target chat ID',
        },
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies',
        },
      },
      required: ['text', 'chatId'],
    },
  },
  {
    name: 'send_card',
    description: `Send a display-only card to a chat. No button interactions.

## Card Structure
A Feishu card object with config, header, and elements.

## Type Constraints (IMPORTANT)
- **card**: MUST be an object with config/header/elements, NOT an array or string
- **chatId**: MUST be a non-empty string

Example:
\`\`\`json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "Title", "tag": "plain_text"}},
  "elements": [{"tag": "markdown", "content": "Content"}]
}
\`\`\`

**Reference:** https://open.feishu.cn/document/common-capabilities/message-card`,
    inputSchema: {
      type: 'object',
      properties: {
        card: {
          type: 'object',
          description: 'The card content object. MUST be an object, NOT an array or string.',
        },
        chatId: {
          type: 'string',
          description: 'Target chat ID',
        },
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies',
        },
      },
      required: ['card', 'chatId'],
    },
  },
  {
    name: 'send_interactive',
    description: `Send an interactive card with buttons/actions to a chat.

Primary Node builds the card from raw parameters (question, options).

## Parameters
- **question**: The question or main content to display (string)
- **options**: Array of button options with text, value, and optional type
- **chatId**: Target chat ID
- **title**: Optional card title
- **context**: Optional context shown above the question
- **actionPrompts**: Optional custom action prompts

## Type Constraints (IMPORTANT)
- **question**: MUST be a non-empty string
- **options**: MUST be a non-empty array of objects with text and value
- **chatId**: MUST be a non-empty string

Example:
\`\`\`json
{
  "question": "Which option do you prefer?",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Reject", "value": "reject", "type": "danger" }
  ],
  "chatId": "oc_xxx"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question or main content to display.',
        },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Button display text' },
              value: { type: 'string', description: 'Button action value' },
              type: { type: 'string', enum: ['primary', 'default', 'danger'], description: 'Button style' },
            },
            required: ['text', 'value'],
          },
          description: 'Button options for user interaction.',
        },
        title: {
          type: 'string',
          description: 'Optional card title.',
        },
        context: {
          type: 'string',
          description: 'Optional context shown above the question.',
        },
        actionPrompts: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional custom action prompts that override auto-generated defaults.',
        },
        chatId: {
          type: 'string',
          description: 'Target chat ID',
        },
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies',
        },
      },
      required: ['question', 'options', 'chatId'],
    },
  },
  {
    name: 'send_file',
    description: 'Send a file to a chat. Supports images, audio, video, and documents.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to send (absolute or relative to workspace).',
        },
        chatId: {
          type: 'string',
          description: 'Target chat ID',
        },
        parentMessageId: {
          type: 'string',
          description: 'Optional parent message ID for thread replies.',
        },
      },
      required: ['filePath', 'chatId'],
    },
  },
  {
    name: 'push_to_agent',
    description: `Push an instruction to a chat agent, triggering agent creation if needed.

Use this to send an instruction to the agent handling a specific chat.
The agent will be lazily created if it doesn't exist yet, and the instruction will be processed as a system message.

## Parameters
- **chatId**: Target chat ID (string)
- **message**: The instruction text to push (string)

## Type Constraints (IMPORTANT)
- **chatId**: MUST be a non-empty string
- **message**: MUST be a non-empty string`,
    inputSchema: {
      type: 'object',
      properties: {
        chatId: {
          type: 'string',
          description: 'Target chat ID',
        },
        message: {
          type: 'string',
          description: 'The instruction text to push to the agent.',
        },
      },
      required: ['chatId', 'message'],
    },
  },
  {
    // Issue #4419 (3a): expose loop lifecycle tools in the common agent
    // toolset so a business agent can stop a runaway loop itself — previously
    // loop_stop/loop_status existed as implementations but were NOT wired into
    // tools/list, so the agent had no way to halt a misconfigured loop and had
    // to wait for maxDuration timeout.
    name: 'loop_stop',
    description: `Stop a running loop execution by its loopId.

A loop repeatedly pushes instructions to a chat agent on a schedule. Use this to halt a loop that is no longer needed or was misconfigured (e.g. wrong execution chat). The loopId is announced once in the execution chat when the loop starts.

## Parameters
- **loopId**: The loop identifier (string)

## Important
Deleting the loop's LOOP.md definition file does NOT stop a running loop — only loop_stop does.`,
    inputSchema: {
      type: 'object',
      properties: {
        loopId: {
          type: 'string',
          description: 'The loop identifier to stop (shown at loop start).',
        },
      },
      required: ['loopId'],
    },
  },
  {
    // Issue #4419 (3a): expose loop_status alongside loop_stop.
    name: 'loop_status',
    description: `Get the current status of a running loop execution by its loopId.

Returns the loop's state, current/total step count, and start time so you can decide whether a loop is still running or should be stopped.

## Parameters
- **loopId**: The loop identifier (string)`,
    inputSchema: {
      type: 'object',
      properties: {
        loopId: {
          type: 'string',
          description: 'The loop identifier to query (shown at loop start).',
        },
      },
      required: ['loopId'],
    },
  },
];
