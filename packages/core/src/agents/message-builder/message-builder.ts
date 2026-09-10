/**
 * MessageBuilder - Framework-agnostic message content builder.
 *
 * Issue #1492: Moved from worker-node to core package.
 * Builds enhanced content with context for agent prompts.
 *
 * Design principles:
 * - Framework-agnostic: No dependency on Feishu-specific or channel-specific types
 * - Composable: Guidance sections as independent, testable functions
 * - Extensible: Channel-specific content provided via MessageBuilderOptions callbacks
 *
 * Architecture:
 * ```
 * MessageBuilder (core)
 *   ├── Metadata (chatId, messageId, senderId)
 *   ├── History sections (chat history, persisted history)
 *   ├── Channel sections (via options callbacks)
 *   │   ├── buildHeader() - Platform label
 *   │   ├── buildPostHistory() - @ mention section
 *   │   ├── buildToolsSection() - MCP tools
 *   │   └── buildAttachmentExtra() - Image analyzer hints
 *   ├── Guidance sections (next-step, output format, task record, location awareness)
 *   └── User message + attachments
 * ```
 *
 * @module agents/message-builder
 */

import type { FileRef } from '../../types/file.js';
import type { ChannelCapabilities } from '../../types/channel.js';
import type { MessageData, MessageBuilderContext, MessageBuilderOptions, MessageBuilderSection } from './types.js';
import {
  buildChatHistorySection,
  buildPersistedHistorySection,
  buildThreadContextSection,
  buildThreadSelfServiceGuidance,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildTaskRecordGuidance,
  buildLocationAwarenessGuidance,
} from './guidance.js';

/**
 * Message builder for agent prompts.
 *
 * Builds enhanced content with context, including:
 * - Chat ID and message ID context
 * - Capability-aware tools section (via channel extensions)
 * - Attachments info
 * - Chat history context
 * - Next-step guidance (Issue #893)
 * - Output format guidance (Issue #962)
 * - Task record guidance (Issue #1234)
 * - Location awareness guidance (Issue #1198)
 *
 * Channel-specific content is injected via the options callbacks.
 */
export class MessageBuilder {
  private readonly options: MessageBuilderOptions;

  constructor(options?: MessageBuilderOptions) {
    this.options = options ?? {};
  }

  /**
   * Build enhanced content with context.
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
    const isSkillCommand = msg.text.trimStart().startsWith('/');
    const ctx: MessageBuilderContext = { msg, chatId, capabilities, isSkillCommand };

    return this.renderSections(this.buildSectionsForContext(ctx));
  }

  /** Build an inspectable stable-to-dynamic representation of one prompt. */
  buildSections(msg: MessageData, chatId: string, capabilities?: ChannelCapabilities): MessageBuilderSection[] {
    const isSkillCommand = msg.text.trimStart().startsWith('/');
    return this.buildSectionsForContext({ msg, chatId, capabilities, isSkillCommand });
  }

  renderSections(sections: readonly MessageBuilderSection[]): string {
    return sections.map(section => section.content).join('\n');
  }

  private buildSectionsForContext(ctx: MessageBuilderContext): MessageBuilderSection[] {
    return ctx.isSkillCommand ? this.buildSkillCommandSections(ctx) : this.buildRegularSections(ctx);
  }

  /**
   * Build content for skill commands.
   *
   * Skill commands get minimal context - just metadata and attachments.
   */
  private buildSkillCommandSections(ctx: MessageBuilderContext): MessageBuilderSection[] {
    const { msg, chatId } = ctx;

    const metadataParts: string[] = [
      `**Chat ID:** ${chatId}`,
      `**Message ID:** ${msg.messageId}`,
    ];
    if (msg.senderOpenId) {
      metadataParts.push(`**Sender Open ID:** ${msg.senderOpenId}`);
    }

    const skillExtra = this.options.buildSkillCommandExtra?.(ctx);
    const sections: MessageBuilderSection[] = [
      { kind: 'user-message', stability: 'dynamic', content: msg.text },
      { kind: 'metadata', stability: 'dynamic', content: `\n---\n${metadataParts.join('\n')}` },
    ];
    const attachments = this.buildBasicAttachmentsInfo(msg.attachments);
    if (attachments) {
      sections.push({ kind: 'attachments', stability: 'dynamic', content: attachments });
    }
    if (skillExtra) {
      sections.push({ kind: 'skill-context', stability: 'dynamic', content: skillExtra });
    }
    return sections;
  }

  /**
   * Build content for regular messages.
   *
   * Regular messages get the full context including history,
   * channel-specific sections, and guidance.
   */
  private buildRegularSections(ctx: MessageBuilderContext): MessageBuilderSection[] {
    const { msg, chatId, capabilities } = ctx;

    // Issue #3641: Detect topic thread to skip next-step guidance
    const isTopicThread = msg.chatType === 'topic';

    // Channel-specific header (e.g., "You are responding in a Feishu chat.")
    const header = this.options.buildHeader?.(ctx);

    // Metadata
    const metadataParts: string[] = [
      `**Chat ID:** ${chatId}`,
      `**Message ID:** ${msg.messageId}`,
    ];
    if (msg.senderOpenId) {
      metadataParts.push(`**Sender Open ID:** ${msg.senderOpenId}`);
    }

    // History sections (framework-agnostic)
    // Issue #3989: For topic threads, skip flat chat history — use thread context only
    // to avoid mixing messages from different threads into the agent's context.
    const chatHistorySection = isTopicThread ? '' : buildChatHistorySection(msg.chatHistoryContext);
    const persistedHistorySection = buildPersistedHistorySection(msg.persistedHistoryContext, msg.chatLogFilePaths);
    const threadContextSection = buildThreadContextSection(msg.threadContext);
    // Issue #4402: lark-cli self-service guidance, decoupled from threadContext.
    // Injected for topic threads even when threadContext wasn't pre-built.
    const threadSelfServiceGuidance = isTopicThread ? buildThreadSelfServiceGuidance() : '';

    // Channel-specific content after history (e.g., @ mention section)
    const postHistory = this.options.buildPostHistory?.(ctx);

    // Channel-specific tools section
    const toolsSection = this.options.buildToolsSection?.(ctx);
    const stableToolsSection = this.options.buildStableToolsSection?.({ capabilities });

    // Core guidance sections (framework-agnostic)
    // Issue #3641: Skip next-step guidance in topic threads to reduce noise
    const supportsInteractiveCards = capabilities?.supportsCard !== false &&
      (capabilities?.supportedMcpTools === undefined || capabilities.supportedMcpTools.includes('send_interactive'));
    const nextStepGuidance = isTopicThread ? '' : buildNextStepGuidance(supportsInteractiveCards);
    const outputFormatGuidance = buildOutputFormatGuidance();
    const taskRecordGuidance = buildTaskRecordGuidance();
    const locationAwarenessGuidance = buildLocationAwarenessGuidance();

    // Compose all sections
    const sections: MessageBuilderSection[] = [];

    if (header) {
      sections.push({ kind: 'channel-header', stability: 'stable', content: header });
    }

    if (stableToolsSection) {
      sections.push({ kind: 'tools', stability: 'stable', content: `\n---\n\n## Tools\n${stableToolsSection}` });
    }
    for (const guidance of [nextStepGuidance, outputFormatGuidance, taskRecordGuidance, locationAwarenessGuidance]) {
      if (guidance) {
        sections.push({ kind: 'guidance', stability: 'stable', content: guidance });
      }
    }

    sections.push({ kind: 'metadata', stability: 'dynamic', content: metadataParts.join('\n') });
    if (toolsSection) {
      sections.push({ kind: 'tools', stability: 'dynamic', content: `\n---\n\n## Tools\n${toolsSection}` });
    }

    if (persistedHistorySection) {
      sections.push({ kind: 'persisted-history', stability: 'dynamic', content: persistedHistorySection });
    }
    if (chatHistorySection) {
      sections.push({ kind: 'chat-history', stability: 'dynamic', content: chatHistorySection });
    }
    if (threadContextSection) {
      sections.push({ kind: 'thread-context', stability: 'dynamic', content: threadContextSection });
    }
    if (threadSelfServiceGuidance) {
      sections.push({ kind: 'channel-context', stability: 'dynamic', content: threadSelfServiceGuidance });
    }
    if (postHistory) {
      sections.push({ kind: 'channel-context', stability: 'dynamic', content: postHistory });
    }

    // User message + attachments
    const attachmentsInfo = this.buildBasicAttachmentsInfo(msg.attachments);
    const attachmentExtra = this.options.buildAttachmentExtra?.(ctx);

    sections.push({ kind: 'user-message', stability: 'dynamic', content: `\n--- User Message ---\n${msg.text}` });
    const attachments = `${attachmentsInfo}${attachmentExtra ?? ''}`;
    if (attachments) {
      sections.push({ kind: 'attachments', stability: 'dynamic', content: attachments });
    }
    return sections;
  }

  /**
   * Build basic attachment information (framework-agnostic).
   *
   * Lists files with their metadata (name, ID, path, MIME type).
   * Channel-specific attachment hints (e.g., image analyzer) are added
   * via the `buildAttachmentExtra` option.
   */
  private buildBasicAttachmentsInfo(attachments?: FileRef[]): string {
    if (!attachments || attachments.length === 0) {
      return '';
    }

    const attachmentList = attachments
      .map((att, index) => {
        const sizeInfo = att.size ? ` (${(att.size / 1024).toFixed(1)} KB)` : '';
        return `${index + 1}. **${att.fileName}**${sizeInfo}\n   - File ID: \`${att.id}\`\n   - Local path: \`${att.localPath}\`\n   - MIME type: ${att.mimeType || 'unknown'}`;
      })
      .join('\n');

    return `

--- Attachments ---
The user has attached ${attachments.length} file(s). These files have been downloaded to local storage:

${attachmentList}

You can read these files using the Read tool with the local paths above.`;
  }
}
