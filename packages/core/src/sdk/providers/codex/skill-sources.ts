import { join, resolve } from 'node:path';
import { SkillsRegistry } from '../../../skills/index.js';

/** Shared Codex source layout; transports must not implement their own scan. */
export function codexSkillsRegistry(workspaceRoot: string, builtinRoot: string, executionRoot = workspaceRoot): SkillsRegistry {
  const workspace = resolve(workspaceRoot);
  return new SkillsRegistry([
    { kind: 'project', root: workspace },
    { kind: 'project', root: join(workspace, '.disclaude') },
    { kind: 'builtin', root: builtinRoot },
  ], executionRoot);
}
