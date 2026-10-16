import { join, resolve } from 'node:path';
import { SkillsRegistry } from '../../../skills/index.js';
import { installedDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';
/** Shared Codex source layout; transports must not implement their own scan. */
export function codexSkillsRegistry(workspaceRoot, builtinRoot, executionRoot = workspaceRoot) {
    const workspace = resolve(workspaceRoot);
    return new SkillsRegistry(() => {
        const diagnostics = installedDiagnosticsPlugin(workspace);
        return [
            { kind: 'project', root: workspace },
            { kind: 'project', root: join(workspace, '.disclaude') },
            ...(diagnostics ? [{ kind: 'user', root: diagnostics }] : []),
            { kind: 'builtin', root: builtinRoot },
        ];
    }, executionRoot);
}
