/**
 * Message builder for Pilot agent.
 *
 * Extracted from pilot.ts for better separation of concerns (Issue #697).
 * Handles building enhanced content with Feishu context.
 *
 * Issue #893: Added in-prompt next-step guidance.
 * Issue #962: Added output format guidance to prevent raw JSON in responses.
 * Issue #1198: Added location awareness guidance - agent should not infer user location.
 * Issue #946: Added "御书房" review experience guidance for better user review workflow.
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

    // Build review experience guidance section (Issue #946)
    const reviewExperienceGuidance = this.buildReviewExperienceGuidance(capabilities);

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
${reviewExperienceGuidance}

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
${reviewExperienceGuidance}

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
- parentMessageId: \`${messageId}\` (for thread replies)`);

      // Include card support note if supported
      parts.push(`
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

  /**
   * Build review experience guidance section for the prompt.
   *
   * Issue #946: Provides "御书房" (Imperial Study) experience when AI needs user review.
   *
   * Core principles:
   * - Independent group chat for each review request
   * - Complete context presentation (what was done, what changed, why)
   * - Effective user opinion solicitation via interactive cards
   * - Accurate execution based on user decision
   *
   * @param capabilities - Channel capabilities to determine card support
   * @returns Review experience guidance string
   */
  private buildReviewExperienceGuidance(capabilities?: ChannelCapabilities): string {
    const supportsGroupDiscussion = capabilities?.supportedMcpTools?.includes('start_group_discussion') ?? true;
    const supportsCards = capabilities?.supportsCard !== false;

    if (!supportsGroupDiscussion) {
      // Fallback for channels without group discussion support
      return '';
    }

    const interactiveExample = supportsCards ? `
\`\`\`json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "请审阅", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "## 📋 任务完成摘要\\n\\n[描述你做了什么...]"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 批准", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 需要修改", "tag": "plain_text"}, "value": "revise"},
        {"tag": "button", "text": {"content": "❌ 拒绝", "tag": "plain_text"}, "value": "reject", "type": "danger"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<new_group_chat_id>",
  "actionPrompts": {
    "approve": "[用户] 批准了方案，继续执行后续操作...",
    "revise": "[用户] 要求修改。请询问具体需要修改的内容。",
    "reject": "[用户] 拒绝了方案。请询问原因并记录。"
  }
}
\`\`\`` : 'Use text-based options like "请回复：1. 批准 2. 需要修改 3. 拒绝"';

    return `

---

## Review Experience (御书房体验)

When you complete a task that requires user review/approval, provide a "御书房" (Imperial Study) experience:

### Core Principles

> **御书房体验 = 独立群聊 + 完整陈述 + 流程控制**

### When to Use

Use this workflow when:
- You've made changes that need user approval (code changes, configuration updates, etc.)
- The task outcome has significant impact and requires explicit confirmation
- User review is explicitly requested

### Workflow

1. **Create Independent Group Chat**
   Use \`start_group_discussion\` tool:
   \`\`\`json
   {
     "topic": "📋 Review: [Task Summary]",
     "context": "## 任务背景\\n[What was requested...]\\n\\n## 完成内容\\n[What was done...]",
     "timeout": 60
   }
   \`\`\`

2. **Present Complete Context**
   In the group chat, clearly state:
   - **背景**: What was requested and why
   - **做了什么**: Specific actions taken
   - **改了什么**: Files/code/configurations changed
   - **为什么**: Rationale for decisions made
   - **影响**: Potential impact of changes

3. **Solicit User Decision**
   Send an interactive card with action options:
${interactiveExample}

4. **Execute Based on Decision**
   - **Approve**: Proceed with the action (merge, deploy, etc.)
   - **Revise**: Ask for specific changes needed, then update
   - **Reject**: Record the rejection reason, no further action needed

5. **Confirm Completion**
   After executing the user's decision, ask: "任务已完成，还有其他需要处理的吗？"

### Key Points

- **One thing at a time**: Focus on one review request per group chat
- **Be concise**: Present information efficiently, don't overwhelm
- **Clear actions**: Make options unambiguous
- **Follow through**: Execute exactly what the user decided`;
  }
}
