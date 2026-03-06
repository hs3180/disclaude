/**
 * Message builder for Pilot agent.
 *
 * Extracted from pilot.ts for better separation of concerns (Issue #697).
 * Handles building enhanced content with Feishu context.
 *
 * Issue #857: Added task complexity assessment guidance for complex task handling.
 */

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
${chatHistorySection}${mentionSection}

---

## Tools
${toolsSection}

${this.buildComplexityGuidance()}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
    }

    return `You are responding in a Feishu chat.

**Chat ID:** ${chatId}
**Message ID:** ${msg.messageId}
${chatHistorySection}
## Tools
${toolsSection}

${this.buildComplexityGuidance()}

--- User Message ---
${msg.text}${this.buildAttachmentsInfo(msg.attachments)}`;
  }

  /**
   * Build task complexity assessment guidance section.
   *
   * Issue #857: Guides the Agent to self-assess task complexity and handle
   * complex tasks appropriately with progress reporting.
   */
  private buildComplexityGuidance(): string {
    return `## Task Complexity Assessment (Issue #857)

Before processing the user's request, assess its complexity:

### Complexity Levels
- **Simple** (1-3): Quick questions, simple lookups, short explanations
- **Moderate** (4-6): Code review, file analysis, multi-step reasoning
- **Complex** (7-10): Multi-file refactoring, architecture changes, long-running tasks

### For Complex Tasks (Score 7+)
If you determine the task is complex:

1. **Immediate Acknowledgment**: Send a brief confirmation message first:
   \`\`\`
   🔄 **Complex Task Detected**

   I'm working on: [Brief task description]
   Estimated time: [Your best estimate based on task scope]

   I'll provide progress updates as I work through this...
   \`\`\`

2. **Progress Updates**: For tasks taking >2 minutes, send periodic updates:
   \`\`\`
   ⏳ **Progress Update**

   Status: [Current activity]
   Completed: [What's done]
   Remaining: [What's left]
   \`\`\`

3. **Time Estimation Guide**:
   - Simple file reads/edits: ~30 seconds
   - Multi-file analysis: ~2-5 minutes
   - Code refactoring: ~5-15 minutes
   - Architecture changes: ~15-30 minutes

### Self-Improvement
After completing complex tasks, briefly note:
- Actual time taken vs. estimate
- What made the task complex
- This helps improve future estimates`;
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
        if (toolName === 'send_file_to_feishu') {
          return capabilities?.supportsFile !== false;
        }
        if (toolName === 'update_card' || toolName === 'wait_for_interaction') {
          return capabilities?.supportsCard !== false;
        }
        return true; // send_user_feedback is always available
      }
      return supportedTools.includes(toolName);
    };

    // send_user_feedback tool
    if (hasTool('send_user_feedback')) {
      parts.push(`When using send_user_feedback, use:
- Chat ID: \`${chatId}\`
- parentMessageId: \`${messageId}\` (for thread replies)`);

      // Include card support note if supported
      if (hasTool('update_card') || hasTool('wait_for_interaction')) {
        parts.push(`
- For rich content, use format: "card" with a valid Feishu card structure`);
      } else {
        parts.push(`
- Note: This channel does not support interactive cards. Use text format only.`);
      }
    }

    // send_file_to_feishu tool
    if (hasTool('send_file_to_feishu')) {
      parts.push(`
- send_file_to_feishu is available for sending files`);
    } else if (supportedTools !== undefined) {
      parts.push(`
- Note: send_file_to_feishu is NOT supported on this channel. Files will not be sent.`);
    }

    // update_card tool
    if (hasTool('update_card')) {
      parts.push(`
- update_card is available for updating existing cards`);
    }

    // wait_for_interaction tool
    if (hasTool('wait_for_interaction')) {
      parts.push(`
- wait_for_interaction is available for waiting for user card interactions`);
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

    return `

--- Attachments ---
The user has attached ${attachments.length} file(s). These files have been downloaded to local storage:

${attachmentList}

You can read these files using the Read tool with the local paths above.`;
  }
}
