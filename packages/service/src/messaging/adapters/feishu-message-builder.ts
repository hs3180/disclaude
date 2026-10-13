/** Feishu-specific prompt sections. Shared CLI guidance owns the tool contract. */
import { buildChannelCliHelpGuidance, getSupportedChannelSendCommands, type MessageBuilderContext, type MessageBuilderOptions, type MessageBuilderStableContext } from '@disclaude/core';

function buildFeishuMentionSection({ msg, capabilities }: MessageBuilderContext): string {
  if (!msg.senderOpenId || capabilities?.supportsMention === false) { return ''; }
  return `\n## @ Mention the User\n\nDo not add a sender mention to ordinary answers or text previews. If the user explicitly asks to notify the sender, the requested format allows it, and the sender has not already been successfully notified through the channel in this turn, use <at user_id="${msg.senderOpenId}">@用户</at> in the final response. Keep the answer outside </at>; the tag contains only the mention label, which Feishu replaces with the account name.`;
}

/** Capability-scoped instructions contain no chat/message identity and appear once per query. */
function buildFeishuStableToolsSection({ capabilities }: MessageBuilderStableContext): string {
  const sendCommands = getSupportedChannelSendCommands(capabilities);
  const notes = [
    'Answer ordinary questions and present text previews in your final reply; ChatAgent delivers your final reply automatically, including requests to send or post a preview in this chat or topic. Do not call send_text for that preview. Use the channel CLI only for a delivery requested in addition to this reply (such as another chat), or for attachments/cards. For a content-only preview, return it once without an added acknowledgment or mention.',
    buildChannelCliHelpGuidance('disclaude channel', { sendCommands }),
  ];
  if (!sendCommands.includes('send_file')) { notes.push('send_file is NOT supported on this channel.'); }
  if (capabilities?.supportsThread === false) { notes.push('Thread replies are NOT supported on this channel.'); }
  return notes.join('\n');
}

function buildFeishuAttachmentExtra({ msg: { attachments } }: MessageBuilderContext): string {
  return attachments?.some(att => att.mimeType?.startsWith('image/'))
    ? '\nImages listed above can be viewed directly with the Read tool.'
    : '';
}

export function createFeishuMessageBuilderOptions(): MessageBuilderOptions {
  return {
    buildHeader: () => 'You are responding in a Feishu chat.',
    buildStableToolsSection: buildFeishuStableToolsSection,
    buildPostHistory: buildFeishuMentionSection,
    buildAttachmentExtra: buildFeishuAttachmentExtra,
  };
}
