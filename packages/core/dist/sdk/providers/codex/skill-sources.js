import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { SkillsRegistry } from '../../../skills/index.js';
import { installedDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';
/** Pass existing directories to the native loader, without copying payloads or
 * writing user/project configuration. Native project discovery remains enabled.
 */
export function codexNativeSkillRoots(projectRoot, builtinRoot) {
    const workspace = projectRoot ? resolve(projectRoot) : undefined;
    const diagnostics = workspace ? installedDiagnosticsPlugin(workspace) : undefined;
    return [...new Set([workspace, workspace ? join(workspace, '.disclaude') : undefined, diagnostics, resolve(builtinRoot)]
            .filter((root) => !!root && existsSync(join(root, 'skills')))
            .map(root => join(root, 'skills')))];
}
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
