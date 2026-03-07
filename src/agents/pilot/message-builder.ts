/**
 * Message builder for Pilot agent.
 *
 * Extracted from pilot.ts for better separation of concerns (Issue #697).
 * Handles building enhanced content with Feishu context.
 *
 * Issue #893: Added in-prompt next-step guidance.
 * Issue #962: Added output format guidance to prevent raw JSON in responses.
 */

import { Config } from '../../config/index.js';
import type { ChannelCapabilities } from '../../channels/types.js';
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
        return true; // send_message is always available
      }
      return supportedTools.includes(toolName);
    };

    // send_message tool
    if (hasTool('send_message')) {
      parts.push(`When using send_message, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${messageId}\` (for thread replies)

- For rich content, use format: "card" with a valid Feishu card structure`);
    }

    // send_file tool
    if (hasTool('send_file')) {
      parts.push(`
- send_file is available for sending files`);
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
    const hasImageAttachment = attachments.some(att =>
      att.mimeType?.startsWith('image/')
    );
    const imageAnalyzerHint = hasImageAttachment && this.hasImageAnalyzerMcp()
      ? `

**Note:** Image attachment(s) detected. If you need to analyze the image content, prefer using the \`analyze_image\` tool from the image analyzer MCP server for better results. You can also use the Read tool to view images if the model supports native multimodal input.`
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

\`\`\`json
{
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
}
\`\`\`

### Guidelines

- Suggest 2-3 relevant next steps based on the conversation context
- Make suggestions specific and actionable
- Use primary button style for the most recommended option
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
}
