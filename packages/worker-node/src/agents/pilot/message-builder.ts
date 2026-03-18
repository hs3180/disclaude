/**
 * Message builder for Pilot agent.
 *
 * Extracted from pilot.ts for better separation of concerns (Issue #697).
 * Handles building enhanced content with Feishu context.
 *
 * Issue #893: Added in-prompt next-step guidance.
 * Issue #962: Added output format guidance to prevent raw JSON in responses.
 * Issue #1198: Added location awareness guidance - agent should not infer user location.
 */

import { Config, type ChannelCapabilities } from '@disclaude/core';
import type { MessageData } from './types.js';

/**
 * Message builder for Pilot.
 *
 * Builds enhanced content with Feishu context, including:
 * - Chat ID and message ID context
 * - @ mention support
 * - Capability-aware tools section
 * - Attachments info
 * - Chat history context
 * - Next-step guidance (Issue #893)
 * - Output format guidance (Issue #962)
 * - Location awareness guidance (Issue #1198)
 */
export class MessageBuilder {
  /**
   * Build enhanced content with Feishu context.
   *
   * @param msg - Message data
   * @param chatId - Chat ID for context
   * @param capabilities - Channel capabilities for tool filtering
   */
  buildEnhancedContent(
    msg: MessageData,
    chatId: string,
    capabilities?: ChannelCapabilities
  ): string {
    // Check if this is a skill command (starts with /)
    const isSkillCommand = msg.text.trimStart().startsWith('/');

    // Build chat history section if available (Issue #517)
    const chatHistorySection = msg.chatHistoryContext
      ? `

---

## Recent Chat History

You were @mentioned in a group chat. Here's the recent conversation context:

${msg.chatHistoryContext}

---
`
      : '';

    // Build persisted history section for session restoration (Issue #955)
    const persistedHistorySection = msg.persistedHistoryContext
      ? `

---

## Previous Session Context

The service was recently restarted. Here's the conversation history from your previous session:

${msg.persistedHistoryContext}

---
`
      : '';

    if (isSkillCommand) {
      // For skill commands: command first, then minimal context for skill to use
      const contextInfo = msg.senderOpenId
        ? `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}${this.buildAttachmentsInfo(msg.attachments)}`
        : `

---
**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}${this.buildAttachmentsInfo(msg.attachments)}`;

      return `${msg.text}${contextInfo}`;
    }

    // Build capability-aware tools section (Issue #582)
    const toolsSection = this.buildToolsSection(chatId, msg.messageId || '', capabilities, msg.senderOpenId);

    // Build next-step guidance section (Issue #893)
    const nextStepGuidance = this.buildNextStepGuidance(capabilities);

    // Build output format guidance section (Issue #962)
    const outputFormatGuidance = this.buildOutputFormatGuidance();

    // Build location awareness guidance section (Issue #1198)
    const locationAwarenessGuidance = this.buildLocationAwarenessGuidance();

    // For regular messages: context FIRST, then user message
    if (msg.senderOpenId) {
      const mentionSection = capabilities?.supportsMention !== false
        ? `

## @ Mention the User

To notify the user in your FINAL response, use:
\`\`\`
<at user_id="${msg.senderOpenId}">@用户</at>
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- This triggers a Feishu notification to the user`
        : '';

      return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
**Sender Open ID:** ${msg.senderOpenId}
${persistedHistorySection}${chatHistorySection}${mentionSection}

---

## Tools
${toolsSection}
${nextStepGuidance}
${outputFormatGuidance}
${locationAwarenessGuidance}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
${persistedHistorySection}${chatHistorySection}
## Tools
${toolsSection}
${nextStepGuidance}
${outputFormatGuidance}
${locationAwarenessGuidance}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
  }

  /**
   * Build capability-aware tools section for the prompt.
   */
  private buildToolsSection(
    chatId: string,
    messageId: string,
    capabilities?: ChannelCapabilities,
    _senderOpenId?: string
  ): string {
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
- parentMessageId: \`${messageId}\` (for thread replies)

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
   * Build attachments info string for the message content.
   *
   * Issue #809: Added image analyzer MCP hint for image attachments.
   */
  private buildAttachmentsInfo(attachments?: MessageData['attachments']): string {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const attachmentList = attachments
      .map((att, index) => {
        const sizeInfo = att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : '';
        return `${index + 1}. **${att.fileName}**${sizeInfo}
   - File ID: \`${att.id}\`
   - Local path: \`${att.localPath}\`
   - MIME type: ${att.mimeType || 'unknown'}`;
      })
      .join('\n');

    // Issue #809: Check if there are image attachments and image analyzer MCP is configured
    // Issue #656: Enhanced prompt for better image analyzer MCP scheduling
    const hasImageAttachment = attachments.some(att =>
      att.mimeType?.startsWith('image/')
    );
    const imageAnalyzerHint = hasImageAttachment && this.hasImageAnalyzerMcp()
      ? `

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

If your model supports native multimodal input, you can also use the Read tool to view images directly. However, for non-native multimodal models, the MCP tool provides better image understanding.`
      : '';

    return `

--- Attachments ---
The user has attached ${attachments.length} file(s). These files have been downloaded to local storage:

${attachmentList}${imageAnalyzerHint}

You can read these files using the Read tool with the local paths above.`;
  }

  /**
   * Check if image analyzer MCP is configured.
   *
   * Issue #809: Detects image analyzer MCP server configuration.
   * Common names: '4_5v_mcp', 'glm-vision', 'image-analyzer', etc.
   */
  private hasImageAnalyzerMcp(): boolean {
    const mcpServers = Config.getMcpServersConfig();
    if (!mcpServers) {
      return false;
    }

    // Check for common image analyzer MCP server names
    const imageAnalyzerNames = ['4_5v_mcp', 'glm-vision', 'image-analyzer', 'vision'];
    return imageAnalyzerNames.some(name => name in mcpServers);
  }

  /**
   * Build next-step guidance section for the prompt.
   *
   * Issue #893: Simplifies next-step recommendation by using in-prompt guidance
   * instead of a separate LLM call. This approach:
   * - Eliminates the need for triggerNextStepRecommendation function
   * - Reduces API calls and latency
   * - Provides more context-aware suggestions
   * - Supports interactive cards when the platform supports them
   *
   * @param capabilities - Channel capabilities to determine card support
   */
  private buildNextStepGuidance(capabilities?: ChannelCapabilities): string {
    const supportsCards = capabilities?.supportsCard !== false;

    if (supportsCards) {
      return `

---

## Next Steps After Response

At the end of your response, proactively suggest 2-3 relevant next steps the user might want to take. Present these suggestions as an **interactive card** with clickable options.

### Card Template for Next Steps

**IMPORTANT**: You MUST include \`actionPrompts\` to make buttons clickable. Without \`actionPrompts\`, buttons are display-only.

\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "接下来您可以...", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "✅ 任务已完成"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "选项1", "tag": "plain_text"}, "value": "action1", "type": "primary"},
        {"tag": "button", "text": {"content": "选项2", "tag": "plain_text"}, "value": "action2"},
        {"tag": "button", "text": {"content": "选项3", "tag": "plain_text"}, "value": "action3"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "action1": "[用户操作] 用户选择了选项1",
    "action2": "[用户操作] 用户选择了选项2",
    "action3": "[用户操作] 用户选择了选项3"
  }
}
\`\`\`

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Use primary button style for the most recommended option
- **CRITICAL**: Always include \`actionPrompts\` that maps each button's \`value\` to a user message
- The action prompt format: \`"[用户操作] 用户选择了..."\` describes what the user did
- Always include a suggestions card, even for simple questions (e.g., "Want to know more about X?", "Try this related feature")`;
    }

    // Fallback for channels without card support
    return `

---

## Next Steps After Response

At the end of your response, proactively suggest 2-3 relevant next steps the user might want to take.

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Format as a simple list
- Always include suggestions, even for simple questions (e.g., "Want to know more about X?", "Try this related feature")`;
  }

  /**
   * Build output format guidance section for the prompt.
   *
   * Issue #962: Prevents raw JSON objects from appearing in model output.
   * Some models (like GLM-5) may output JSON objects directly instead of
   * formatting them as readable Markdown. This guidance ensures structured
   * data is always presented in a human-readable format.
   *
   * @returns Output format guidance string
   */
  private buildOutputFormatGuidance(): string {
    return `

---

## Output Format Requirements

**IMPORTANT: Never output raw JSON objects in your response.**

When you need to present structured data (status, metrics, analysis results, etc.), always format it as **readable Markdown**:

### ✅ Correct Format
\`\`\`markdown
> **储蓄率**: ❌ 入不敷出，储蓄率为负，建议审视支出结构
\`\`\`

### ❌ Wrong Format (Never do this)
\`\`\`markdown
> **储蓄率**: { "status": "bad", "comment": "入不敷出..." }
\`\`\`

### Guidelines

- Convert JSON objects to readable text, tables, or formatted lists
- Use emoji and formatting (bold, italic) to highlight important information
- If you have structured data internally, extract and present the key values
- For complex data, use Markdown tables instead of raw JSON`;
  }

  /**
   * Build location awareness guidance section for the prompt.
   *
   * Issue #1198: The agent runs on a server that is physically separate
   * from the user's terminal. Therefore, the agent should NOT attempt to
   * infer the user's physical location through system information (like
   * timezone, Wi-Fi networks, IP address, etc.) and should honestly state
   * that it doesn't know the user's location when asked.
   *
   * @returns Location awareness guidance string
   */
  private buildLocationAwarenessGuidance(): string {
    return `

---

## Location Awareness

**IMPORTANT: You do NOT know the user's physical location.**

You are running on a remote server that is physically separate from the user's terminal. Therefore:

- You CANNOT infer the user's location from system information (timezone, Wi-Fi networks, IP address, locale settings, etc.)
- When the user asks about location-dependent information (weather, local events, etc.), you should:
  1. Honestly state that you don't know their location
  2. Ask them to provide their location if needed
  3. Do NOT attempt to guess or infer their location from any system data

### Examples

**❌ Wrong Approach:**
> "Based on your timezone (Asia/Shanghai), you're probably in Shanghai..."

**✅ Correct Approach:**
> "I don't know your current location since I'm running on a remote server. Could you tell me which city you're in so I can help you with the weather forecast?"`;
  }
}
