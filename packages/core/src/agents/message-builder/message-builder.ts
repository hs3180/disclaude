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
 *   ├── Guidance sections (next-step, output format, location awareness)
 *   └── User message + attachments
 * ```
 *
 * @module agents/message-builder
 */

import type { FileRef } from '../../types/file.js';
import type { ChannelCapabilities } from '../../types/channel.js';
import type { MessageData, MessageBuilderContext, MessageBuilderOptions } from './types.js';
import {
  buildChatHistorySection,
  buildPersistedHistorySection,
  buildNextStepGuidance,
  buildOutputFormatGuidance,
  buildLocationAwarenessGuidance,
  buildResearchModeGuidance,
} from './guidance.js';
import type { ModeState } from '../mode-manager.js';

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
 * - Location awareness guidance (Issue #1198)
 * - Research mode guidance (Issue #1709)
 *
 * Channel-specific content is injected via the options callbacks.
 */
export class MessageBuilder {
  private readonly options: MessageBuilderOptions;

  constructor(options?: MessageBuilderOptions) {
    this.options = options ?? {};
  }

  /**
   * Set the current mode state for context-aware message building.
   * Called externally (e.g., by Pilot) when mode changes.
   *
   * @param modeState - Current mode state, or undefined for normal mode
   */
  setModeState(_modeState?: ModeState): void {
    // Mode state is applied in buildEnhancedContent via the mode parameter.
    // This method exists for future extension (e.g., caching mode-specific content).
  }

  /**
   * Build enhanced content with context.
   *
   * @param msg - Message data
   * @param chatId - Chat ID for context
   * @param capabilities - Channel capabilities for tool filtering
   * @param modeState - Current agent mode state (Issue #1709)
   */
  buildEnhancedContent(
    msg: MessageData,
    chatId: string,
    capabilities?: ChannelCapabilities,
    modeState?: ModeState
  ): string {
    const isSkillCommand = msg.text.trimStart().startsWith('/');
    const ctx: MessageBuilderContext = { msg, chatId, capabilities, isSkillCommand };

    if (isSkillCommand) {
      return this.buildSkillCommandContent(ctx);
    }

    return this.buildRegularContent(ctx, modeState);
  }

  /**
   * Build content for skill commands.
   *
   * Skill commands get minimal context - just metadata and attachments.
   */
  private buildSkillCommandContent(ctx: MessageBuilderContext): string {
    const { msg, chatId } = ctx;

    const metadataParts: string[] = [
      `**Chat ID:** ${chatId}`,
      `**Message ID:** ${msg.messageId}`,
    ];
    if (msg.senderOpenId) {
      metadataParts.push(`**Sender Open ID:** ${msg.senderOpenId}`);
    }

    const contextInfo = metadataParts.join('\n') + this.buildBasicAttachmentsInfo(msg.attachments);
    const skillExtra = this.options.buildSkillCommandExtra?.(ctx);

    return `${msg.text}\n\n---\n${contextInfo}${skillExtra ?? ''}`;
  }

  /**
   * Build content for regular messages.
   *
   * Regular messages get the full context including history,
   * channel-specific sections, and guidance.
   */
  private buildRegularContent(ctx: MessageBuilderContext, modeState?: ModeState): string {
    const { msg, chatId, capabilities } = ctx;

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
    const chatHistorySection = buildChatHistorySection(msg.chatHistoryContext);
    const persistedHistorySection = buildPersistedHistorySection(msg.persistedHistoryContext);

    // Channel-specific content after history (e.g., @ mention section)
    const postHistory = this.options.buildPostHistory?.(ctx);

    // Channel-specific tools section
    const toolsSection = this.options.buildToolsSection?.(ctx);

    // Core guidance sections (framework-agnostic)
    const nextStepGuidance = buildNextStepGuidance(capabilities?.supportsCard !== false);
    const outputFormatGuidance = buildOutputFormatGuidance();
    const locationAwarenessGuidance = buildLocationAwarenessGuidance();

    // Research mode guidance (Issue #1709)
    const researchModeGuidance = modeState?.mode === 'research'
      ? buildResearchModeGuidance({
          topic: modeState.topic,
          cwd: modeState.cwd,
          soulContent: modeState.soulContent,
        })
      : '';

    // Compose all sections
    const sections: string[] = [];

    if (header) {
      sections.push(header);
    }

    sections.push(metadataParts.join('\n'));

    if (persistedHistorySection) {
      sections.push(persistedHistorySection);
    }
    if (chatHistorySection) {
      sections.push(chatHistorySection);
    }
    if (postHistory) {
      sections.push(postHistory);
    }

    if (toolsSection) {
      sections.push(`\n---\n\n## Tools\n${toolsSection}`);
    }

    sections.push(nextStepGuidance);
    sections.push(outputFormatGuidance);
    sections.push(locationAwarenessGuidance);
    if (researchModeGuidance) {
      sections.push(researchModeGuidance);
    }

    const preamble = sections.join('\n');

    // User message + attachments
    const attachmentsInfo = this.buildBasicAttachmentsInfo(msg.attachments);
    const attachmentExtra = this.options.buildAttachmentExtra?.(ctx);

    return `${preamble}\n\n--- User Message ---\n${msg.text}${attachmentsInfo}${attachmentExtra ?? ''}`;
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
