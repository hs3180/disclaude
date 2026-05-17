/**
 * Feishu-specific channel sections for MessageBuilder.
 *
 * Issue #1499: Moved from @disclaude/worker-node to @disclaude/primary-node
 * to decouple Feishu-specific logic from the generic worker-node runtime.
 *
 * Provides Feishu-specific content sections that are injected
 * into the core MessageBuilder via the MessageBuilderOptions callbacks.
 *
 * @module messaging/adapters/feishu-message-builder
 */

import { type MessageBuilderContext, type MessageBuilderOptions } from '@disclaude/core';

/**
 * Build Feishu platform header.
 */
function buildFeishuHeader(_ctx: MessageBuilderContext): string {
  return 'You are responding in a Feishu chat.';
}

/**
 * Build Feishu @ mention section.
 *
 * Only included when senderOpenId is present and channel supports mentions.
 */
function buildFeishuMentionSection(ctx: MessageBuilderContext): string {
  const { msg, capabilities } = ctx;

  if (!msg.senderOpenId) {
    return '';
  }

  if (capabilities?.supportsMention === false) {
    return '';
  }

  return `

## @ Mention the User

To notify the user in your FINAL response, use:
\`\`\`
<at user_id="${msg.senderOpenId}">@用户</at>
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- This triggers a Feishu notification to the user`;
}

/**
 * Build Feishu capability-aware tools section.
 *
 * Issue #582: Dynamically includes available MCP tools based on channel capabilities.
 */
function buildFeishuToolsSection(ctx: MessageBuilderContext): string {
  const { chatId, msg, capabilities } = ctx;
  const parts: string[] = [];
  const supportedTools = capabilities?.supportedMcpTools;

  // If supportedMcpTools is defined, use it for dynamic tool filtering
  const hasTool = (toolName: string): boolean => {
    if (supportedTools === undefined) {
      // Legacy behavior: check individual capability flags
      if (toolName === 'send_file') {
        return capabilities?.supportsFile !== false;
      }
      // For backward compatibility with old configs, assume messaging tools are available
      return true;
    }
    return supportedTools.includes(toolName);
  };

  // Build messaging tools section
  const messagingTools: string[] = [];
  if (hasTool('send_text')) {
    messagingTools.push('- `mcp__channel-mcp__send_text` - Send plain text messages');
  }
  if (hasTool('send_card')) {
    messagingTools.push('- `mcp__channel-mcp__send_card` - Send display-only cards (no interactions)');
  }
  if (hasTool('send_interactive')) {
    messagingTools.push('- `mcp__channel-mcp__send_interactive` - Send interactive cards with buttons/actions');
  }

  if (messagingTools.length > 0) {
    parts.push(`To send messages to this chat, use the appropriate tool:
${messagingTools.join('\n')}

- Chat ID: \`${chatId}\`
- parentMessageId: \`${msg.messageId || ''}\` (for thread replies)

**IMPORTANT**: Always use \`mcp__channel-mcp__send_*\` tools for sending messages. Do NOT use any other MCP server's tools for messaging.`);
  }

  // send_file tool
  if (hasTool('send_file')) {
    parts.push(`
- **File sending**: Use \`mcp__channel-mcp__send_file\` for sending files to Feishu`);
  } else if (supportedTools !== undefined) {
    parts.push(`
- Note: send_file is NOT supported on this channel. Files will not be sent.`);
  }

  // Include thread support note
  if (capabilities?.supportsThread === false) {
    parts.push(`
- Note: Thread replies are NOT supported on this channel.`);
  }

  return parts.join('\n');
}

/**
 * Build Feishu-specific extra attachment info.
 *
 * Issue #3679: Removed hardcoded MCP tool usage guidance.
 * Modern models support native multimodal input and can use the Read tool
 * to view images directly. MCP tool discovery is handled by the SDK automatically.
 */
function buildFeishuAttachmentExtra(ctx: MessageBuilderContext): string {
  const { msg: { attachments } } = ctx;

  if (!attachments || attachments.length === 0) {
    return '';
  }

  const imageAttachments = attachments.filter(att =>
    att.mimeType?.startsWith('image/')
  );

  if (imageAttachments.length === 0) {
    return '';
  }

  const imageList = imageAttachments
    .map(att => `- ${att.fileName || 'image'} (${att.localPath || 'no local path'})`)
    .join('\n');

  return `

## 📎 Image Attachments

The user has attached ${imageAttachments.length === 1 ? 'an image' : `${imageAttachments.length} images`}:
${imageList}

Use the Read tool to view image files directly.`;
}

/**
 * Create Feishu-specific MessageBuilderOptions.
 *
 * Returns the options object with all Feishu channel section builders
 * configured for use with the core MessageBuilder.
 *
 * Issue #1499: Moved from worker-node to primary-node. Use this function
 * when creating ChatAgent instances for Feishu channels.
 *
 * @returns MessageBuilderOptions with Feishu-specific callbacks
 */
export function createFeishuMessageBuilderOptions(): MessageBuilderOptions {
  return {
    buildHeader: buildFeishuHeader,
    buildPostHistory: buildFeishuMentionSection,
    buildToolsSection: buildFeishuToolsSection,
    buildAttachmentExtra: buildFeishuAttachmentExtra,
  };
}
