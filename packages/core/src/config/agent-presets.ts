/**
 * Compatibility shim for the retired named agent presets module.
 *
 * The selection surface, the LLM compatibility matrix, the `agents:` map
 * validation and the default/named resolution now live in agent-runtime.ts
 * (Issue #5255 r4: the preset concept is being removed from the project per
 * review 5948908832). This re-export keeps the module path alive while the
 * remaining preset-domain surfaces migrate; it is removed with them.
 */

export {
  SWITCHABLE_BACKENDS,
  backendLlmCompatibility,
  switchableBackendsFor,
  isValidModelForBackend,
  composeSessionRuntime,
  resolveDefaultAgentRuntime,
  resolveSessionAgentRuntime,
  validateAgentRuntimes,
} from './agent-runtime.js';
export type {
  SessionAgentOverride,
  AgentBackend,
  AgentRuntimeResolution,
  AgentRuntimeValidation,
} from './agent-runtime.js';
