/**
 * pi.dev Provider 模块导出 (Issue #4385)
 */

export { PiAgentProvider } from './provider.js';

// Host tool definitions are adapted only inside the Pi provider.
export {
  adaptPiTools,
  type PiAgentHarnessTool,
  type PiAgentToolResult,
} from './tool-adapter.js';
// Issue #4386 (S3, part 1): pi AgentEvent → AgentMessage adapter.
export { adaptPiEvent, type PiAgentEvent, type PiAssistantMessageEvent } from './event-adapter.js';
// Issue #4386 (S3, part 2): disclaude AgentQueryOptions → pi run-options adapter.
export {
  adaptPiOptions,
  type PiAdaptedOptions,
  type PiAgentContextInput,
} from './options-adapter.js';
