/**
 * LLM access catalog on the unified extension registry (Issue #5745 Part 3).
 *
 * `llms.<name>.via` and `llms.<name>.api.protocol` were hardcoded literal
 * unions in resolved-agents validation — a new access method or wire protocol
 * needed a core-code change plus a release. Both dimensions now read the
 * registry below: builtin values are preregistered as ordinary entries, and a
 * runtime registration extends what configuration accepts with zero core
 * edits. Section semantics (error isolation, stable order, override rules)
 * come from extensions/registry.ts.
 */
import { ExtensionSection } from '../extensions/registry.js';

/** Descriptor for a registered `llms.<name>.via` access method. */
export interface LlmViaDescriptor {
  /** Human-readable summary for config diagnostics and listing surfaces. */
  readonly description: string;
}

/** Descriptor for a registered `llms.<name>.api.protocol` wire format. */
export interface LlmProtocolDescriptor {
  /** Human-readable summary for config diagnostics and listing surfaces. */
  readonly description: string;
}

export const llmViaRegistry = new ExtensionSection<LlmViaDescriptor>('llms.via');

export const llmProtocolRegistry = new ExtensionSection<LlmProtocolDescriptor>('llms.api.protocol');

llmViaRegistry.register(
  'chatgpt',
  {
    description:
      'the Codex-managed ChatGPT login and subscription quota; no api block, codex runtime only',
  },
  { source: 'builtin' }
);

llmViaRegistry.register(
  'api',
  {
    description: 'a compatible API connection described by the api block (protocol, endpoint, credential reference)',
  },
  { source: 'builtin' }
);

llmProtocolRegistry.register(
  'anthropic',
  { description: 'Anthropic Messages API wire format' },
  { source: 'builtin' }
);

llmProtocolRegistry.register(
  'openai',
  { description: 'OpenAI Chat Completions wire format' },
  { source: 'builtin' }
);
