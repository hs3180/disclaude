import { join, resolve } from 'node:path';
import { SkillsRegistry } from '../../../skills/index.js';
/** Shared Codex source layout; transports must not implement their own scan. */
export function codexSkillsRegistry(workspaceRoot, builtinRoot) {
    const workspace = resolve(workspaceRoot);
    return new SkillsRegistry([
        { kind: 'project', root: workspace },
        { kind: 'project', root: join(workspace, '.disclaude') },
        { kind: 'builtin', root: builtinRoot },
    ]);
}
