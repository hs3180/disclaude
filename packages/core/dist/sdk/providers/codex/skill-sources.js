import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { installedDiagnosticsPlugin } from '../../../skills/diagnostics-plugin.js';
/**
 * Skill-directory roots passed to Codex's native loader, without copying
 * payloads or writing user/project configuration. Native project discovery
 * remains enabled. Shared by both transports: app-server registers these
 * roots with `skills/extraRoots/set`; the exec transport has no registration
 * mechanism and fails fast when any root exists (#5520).
 */
export function codexNativeSkillRoots(projectRoot, builtinRoot) {
    const workspace = projectRoot ? resolve(projectRoot) : undefined;
    const diagnostics = workspace ? installedDiagnosticsPlugin(workspace) : undefined;
    return [...new Set([workspace, workspace ? join(workspace, '.disclaude') : undefined, diagnostics, resolve(builtinRoot)]
            .filter((root) => !!root && existsSync(join(root, 'skills')))
            .map(root => join(root, 'skills')))];
}
