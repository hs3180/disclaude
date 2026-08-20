/**
 * pi.dev Provider 模块导出 (Issue #4385)
 */

export { PiAgentProvider } from './provider.js';

// Issue #4387 (S4): disclaude InlineToolDefinition → pi AgentHarnessTool.
export {
  adaptInlineTool,
  type PiAgentHarnessTool,
  type PiAgentToolResult,
  type PiToolParameters,
} from './inline-tool-adapter.js';
// Issue #4386 (S3, part 1): pi AgentEvent → AgentMessage adapter.
export { adaptPiEvent, type PiAgentEvent, type PiAssistantMessageEvent } from './event-adapter.js';
// Issue #4386 (S3, part 2): disclaude AgentQueryOptions → pi run-options adapter.
export {
  adaptPiOptions,
  type PiAdaptedOptions,
  type PiAgentContextInput,
} from './options-adapter.js';
// Issue #4389 (S6): disclaude-owned permission gate for pi-path tool calls.
// Exported so the wiring layer can stack policies (composeGates) and install
// alternatives on the provider's gate seam.
export {
  ALLOW_ALL_GATE,
  composeGates,
  createDenylistGate,
  type PiPermissionDecision,
  type PiPermissionGate,
  type PiToolCallRequest,
} from './permission-gate.js';
