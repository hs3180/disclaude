/** Pure validation and default selection for named agent presets. */

import type { AgentPreset, AgentPresets } from './types.js';

const VALID_BACKENDS = new Set<AgentPreset['agentBackend']>(['claude', 'pi', 'codex']);

export type AgentPresetValidation =
  | { ok: true; name: string; preset: AgentPreset }
  | { ok: false; errors: string[] };

/**
 * Validate the public `agents:` map and resolve its one default preset.
 *
 * The reserved `default` key is the compatibility-friendly default marker.
 * A named preset may instead set `default: true`, but the two forms may not
 * be combined and exactly one default is required whenever `agents` exists.
 */
export function validateAgentPresets(agents: unknown): AgentPresetValidation {
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return { ok: false, errors: ['agents must be a non-empty map of named presets'] };
  }

  const entries = Object.entries(agents as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, errors: ['agents must contain at least one named preset'] };
  }

  const errors: string[] = [];
  const defaults: string[] = [];
  for (const [name, raw] of entries) {
    if (!name.trim()) {
      errors.push('agents preset names must not be empty');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`agents.${name} must be a mapping`);
      continue;
    }
    const preset = raw as Partial<AgentPreset>;
    if (!VALID_BACKENDS.has(preset.agentBackend as AgentPreset['agentBackend'])) {
      errors.push(`agents.${name}.agentBackend must be one of: claude, pi, codex`);
    }
    if (typeof preset.model !== 'string' || !preset.model.trim()) {
      errors.push(`agents.${name}.model must be a non-empty string`);
    }
    if (preset.default !== undefined && typeof preset.default !== 'boolean') {
      errors.push(`agents.${name}.default must be a boolean`);
    }
    if (name === 'default' || preset.default === true) {
      defaults.push(name);
    }
  }

  if (defaults.length !== 1) {
    errors.push(`agents must declare exactly one default preset (found ${defaults.length})`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const [name] = defaults;
  return { ok: true, name, preset: (agents as AgentPresets)[name] };
}
