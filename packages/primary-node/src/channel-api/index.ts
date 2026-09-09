/** Channel API contracts shared with @disclaude/core. */

// Re-export protocol types from @disclaude/core
export {
  type ChannelApiRequestType,
  type ChannelApiRequestPayloads,
  type ChannelApiResponsePayloads,
} from '@disclaude/core';

// Re-export the live channel-handler contracts from @disclaude/core
export {
  type ChannelApiHandlers,
  type ChannelHandlersContainer,
  type FeishuApiHandlers,
  type FeishuHandlersContainer,
} from '@disclaude/core';
