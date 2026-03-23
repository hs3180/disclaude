/**
 * Feishu-specific channel sections for MessageBuilder.
 *
 * Issue #1492: Extracted from worker-node MessageBuilder.
 * Provides Feishu-specific content sections that are injected
 * into the core MessageBuilder via the MessageBuilderOptions callbacks.
 *
 * @module pilot/feishu-sections
 */

import { Config } from '@disclaude/core';
import type { MessageBuilderContext, MessageBuilderOptions } from '@disclaude/core';

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
 * Issue #809: Adds image analyzer MCP hint for image attachments.
 * Issue #656: Enhanced prompt for better image analyzer MCP scheduling.
 */
function buildFeishuAttachmentExtra(ctx: MessageBuilderContext): string {
  const { msg } = ctx;
  const attachments = msg.attachments;

  if (!attachments || attachments.length === 0) {
    return '';
  }

  const hasImageAttachment = attachments.some(att =>
    att.mimeType?.startsWith('image/')
  );

  if (!hasImageAttachment || !hasImageAnalyzerMcp()) {
    return '';
  }

  return `

## 🖼️ Image Analysis Required

The user has attached image(s). **You MUST analyze the image content before responding** to provide accurate assistance.

### How to Analyze Images

Use the \`mcp__4_5v_mcp__analyze_image\` tool (or \`analyze_image\` if available):

\`\`\`
mcp__4_5v_mcp__analyze_image(
  imageSource: "local file path from attachment",
  prompt: "Describe what you see in this image in detail"
)
\`\`\`

### Analysis Workflow

1. **First**: Call the image analysis tool with the image's local path
2. **Then**: Based on the analysis result, respond to the user's request
3. **Important**: Do NOT guess or make assumptions about image content without analysis

### Alternative: Native Multimodal

If your model supports native multimodal input, you can also use the Read tool to view images directly. However, for non-native multimodal models, the MCP tool provides better image understanding.`;
}

/**
 * Check if image analyzer MCP is configured.
 *
 * Issue #809: Detects image analyzer MCP server configuration.
 * Common names: '4_5v_mcp', 'glm-vision', 'image-analyzer', etc.
 */
function hasImageAnalyzerMcp(): boolean {
  const mcpServers = Config.getMcpServersConfig();
  if (!mcpServers) {
    return false;
  }

  // Check for common image analyzer MCP server names
  const imageAnalyzerNames = ['4_5v_mcp', 'glm-vision', 'image-analyzer', 'vision'];
  return imageAnalyzerNames.some(name => name in mcpServers);
}

/**
 * Create Feishu-specific MessageBuilderOptions.
 *
 * Returns the options object with all Feishu channel section builders
 * configured for use with the core MessageBuilder.
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
