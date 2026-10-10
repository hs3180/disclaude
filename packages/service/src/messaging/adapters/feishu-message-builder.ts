/** Feishu-specific prompt sections. Shared CLI guidance owns the tool contract. */
import { buildChannelCliHelpGuidance, type MessageBuilderContext, type MessageBuilderOptions, type MessageBuilderStableContext } from '@disclaude/core';

function buildFeishuMentionSection({ msg, capabilities }: MessageBuilderContext): string {
  if (!msg.senderOpenId || capabilities?.supportsMention === false) { return ''; }
  return `\n## @ Mention the User\n\nWhen compatible with the requested output format and the sender has not already been successfully notified through the channel in this turn, notify the sender in the final response only with <at user_id="${msg.senderOpenId}">@用户</at>. Keep the answer outside </at>; the tag contains only the mention label, which Feishu replaces with the account name.`;
}

/** Capability-scoped instructions contain no chat/message identity and appear once per query. */
function buildFeishuStableToolsSection({ capabilities }: MessageBuilderStableContext): string {
  const supported = capabilities?.supportedMcpTools;
  const sendCommands = ['send_text', 'send_file', 'send_card', 'send_interactive'].filter(command => {
    if (supported !== undefined) { return supported.includes(command); }
    if (command === 'send_file' && capabilities?.supportsFile === false) { return false; }
    if ((command === 'send_card' || command === 'send_interactive') && capabilities?.supportsCard === false) { return false; }
    return true;
  });
  const notes = [
    'Answer ordinary questions directly; ChatAgent delivers your final reply automatically. Use the channel CLI only for explicit additional delivery.',
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
