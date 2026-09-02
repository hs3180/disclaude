/** Public channel operation surface used by the CLI and CLI Skill shim. */

export type {
  ActionPromptMap,
  InteractiveOption,
  MessageSentCallback,
  SendFileResult,
  SendInteractiveResult,
  SendMessageResult,
} from './tools/types.js';

export {
  getFeishuCredentials,
  getWorkspaceDir,
  getIpcErrorMessage,
  buildIpcFallbackHint,
  isIpcAvailable,
  setMessageSentCallback,
  getMessageSentCallback,
  invokeMessageSentCallback,
} from './tools/index.js';

export { send_text } from './tools/send-message.js';
export { send_card } from './tools/send-card.js';
export { send_file } from './tools/send-file.js';
export { push_to_agent } from './tools/push-to-agent.js';
export { send_interactive, send_interactive_message } from './tools/interactive-message.js';

export { isValidFeishuCard, getCardValidationError, detectMarkdownTableWarnings } from './utils/card-validator.js';
export { transformCardTables } from './utils/table-converter.js';
export { resolveCardImages } from './utils/card-image-resolver.js';
export { getChatIdValidationError } from './utils/chat-id-validator.js';
