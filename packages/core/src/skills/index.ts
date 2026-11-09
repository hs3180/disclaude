/** Shared skill discovery contract for all harness adapters. */
export { SkillsRegistry, formatSkillManifest } from './skills-registry.js';
export type {
  SkillSourceKind,
  SkillSource,
  ResolvedSkill,
  SkillDiagnostic,
  SkillsRegistryResolution,
} from './skills-registry.js';
export { assertNoUndeliverableSkillSources, undeliverableSkillSourceError } from './native-skill-channel.js';
export type { NativeSkillChannel } from './native-skill-channel.js';
