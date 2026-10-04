/**
 * Feishu-specific channel sections for MessageBuilder.
 *
 * Issue #1499: Moved from @disclaude/worker-node to @disclaude/service
 * to decouple Feishu-specific logic from the generic worker-node runtime.
 *
 * Provides Feishu-specific content sections that are injected
 * into the core MessageBuilder via the MessageBuilderOptions callbacks.
 *
 * @module messaging/adapters/feishu-message-builder
 */

import { buildChannelCliHelpGuidance, type MessageBuilderContext, type MessageBuilderOptions, type MessageBuilderStableContext } from '@disclaude/core';

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
<at user_id="${msg.senderOpenId}">@用户</at> Your answer goes here.
\`\`\`

**Rules:**
- Use @ ONLY in your **final/complete response**, NOT in intermediate messages
- Put the answer outside the closing </at> tag. The tag contains only the mention label: Feishu replaces its content with the account name, so answer text inside it is not displayed.
- This triggers a Feishu notification to the user`;
}

/**
 * Build Feishu capability-aware tools section.
 *
 * Issue #582: Dynamically includes available channel operations based on capabilities.
 * Issue #4652: Uses the runtime-agnostic channel CLI Skill after ChatAgent's
 * default MCP injection was removed.
 */
function buildFeishuToolsSection(ctx: MessageBuilderContext): string {
  const { chatId, msg, capabilities } = ctx;
  const channelCli = 'disclaude channel';
  const parts: string[] = [];
  const supportedTools = capabilities?.supportedMcpTools;

  // If supportedMcpTools is defined, use it for dynamic tool filtering
  const hasTool = (toolName: string): boolean => {
    if (supportedTools === undefined) {
      // Legacy behavior: check individual capability flags
      if (toolName === 'send_file') {
        return capabilities?.supportsFile !== false;
      }
      if (toolName === 'send_card') {
        return capabilities?.supportsCard !== false;
      }
      // For backward compatibility with old configs, assume messaging tools are available
      return true;
    }
    return supportedTools.includes(toolName);
  };

  // Build messaging tools section
  const messagingTools: string[] = [];
  if (hasTool('send_text')) {
    messagingTools.push(`- \`${channelCli} send_text\` - Send plain text messages`);
  }
  if (hasTool('send_card')) {
    messagingTools.push(`- \`${channelCli} send_card\` - Send display-only cards (no interactions)`);
  }
  if (hasTool('send_interactive')) {
    messagingTools.push(`- \`${channelCli} send_interactive\` - Send interactive cards with buttons/actions`);
  }

  if (messagingTools.length > 0) {
    parts.push(`Answer ordinary questions directly; ChatAgent delivers your reply automatically. No channel CLI lookup or delivery call is needed for a normal answer.

For an explicit additional delivery, these tools are available:
${messagingTools.join('\n')}

- Chat ID: \`${chatId}\`
- parentMessageId: \`${msg.messageId || ''}\` (for thread replies)

**IMPORTANT**: Use the channel CLI Skill for proactive or additional messages; your normal final response is delivered by ChatAgent automatically.`);
  }

  // send_file tool
  if (hasTool('send_file')) {
    parts.push(`
- **File sending**: Use \`${channelCli} send_file --chat ${chatId} --file <path>\` for sending files to Feishu`);
  } else if (supportedTools !== undefined) {
    parts.push(`
- Note: send_file is NOT supported on this channel. Files will not be sent.`);
  }

  // Include thread support note
  if (capabilities?.supportsThread === false) {
    parts.push(`
- Note: Thread replies are NOT supported on this channel.`);
  }

  if (ctx.agentBackend === 'codex') {
    parts.push(`

## Codex source citations

When your answer relies on one or more cited sources, keep each citation next to the claim it supports using concise numbered markers such as [1] and [2]; do not expose raw provider citation markers.

Map citations from their meaning and source metadata: use each cited source's title, direct URL, and any supplied excerpt, then place its marker beside the sentence or paragraph that source supports. Number distinct sources by their first appearance in the answer, reuse a source's number when it supports another claim, and list sources in that same order. Do not map by tool-return order alone, move a citation to a different claim, or invent missing source details or excerpts.

Only cite a claim when the source content you actually read supports it. When a claim comes from a linked page, read that page and cite its own title and direct URL. If evidence is missing, omit the claim or say it remains unverified. Label your inferences and cite the evidence behind them.

When you cite sources, end the final answer with a \`## Sources\` section listing exactly the sources behind those markers, one entry per source, in this exact format:

\`\`\`markdown
## Sources
1. [Source title](https://example.com)
   > Optional short supporting excerpt
2. [Another source title](https://example.org/another)
\`\`\`

Rules: each entry is a single line \`number. [title](direct URL)\` starting at 1 and incrementing; include an excerpt line only when the source provides one; keep entry numbers aligned with the markers used in the answer; include only sources you actually used. Do not add a \`## Sources\` section when the answer has no citations, and put nothing after it — it must be the last section of the answer.

Where the channel supports citation cards, delivery code renders this section with the final reply. Do not call \`send_card\` or \`send_interactive\` for these citation sources and do not write card JSON; just end with the section in the exact format above.`);
  }

  return parts.join('\n');
}

/** Capability-scoped help with no chat/message identity, safe as a reusable prefix. */
function buildFeishuStableToolsSection(ctx: MessageBuilderStableContext): string {
  const channelCli = 'disclaude channel';
  const supported = ctx.capabilities?.supportedMcpTools;
  const sendCommands = ['send_text', 'send_file', 'send_card', 'send_interactive']
    .filter(command =>
      supported === undefined
        ? command !== 'send_card' || ctx.capabilities?.supportsCard !== false
        : supported.includes(command),
    );
  return `For the current channel feature list and command options, run \`${channelCli} help\`.\n${buildChannelCliHelpGuidance(channelCli, { sendCommands })}`;
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
 * Issue #1499: Moved from worker-node to service. Use this function
 * when creating ChatAgent instances for Feishu channels.
 *
 * @returns MessageBuilderOptions with Feishu-specific callbacks
 */
export function createFeishuMessageBuilderOptions(): MessageBuilderOptions {
  return {
    buildHeader: buildFeishuHeader,
    buildStableToolsSection: buildFeishuStableToolsSection,
    buildPostHistory: buildFeishuMentionSection,
    buildToolsSection: buildFeishuToolsSection,
    buildAttachmentExtra: buildFeishuAttachmentExtra,
  };
}
