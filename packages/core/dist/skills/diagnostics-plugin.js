/** The first-party diagnostics plugin is an explicit, project-local install. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SkillsRegistry } from './skills-registry.js';
const FILES = ['.claude-plugin/plugin.json', 'skills/diagnose-logs/SKILL.md'];
const RECEIPT = '.disclaude-install.json';
const PLUGIN_NAME = 'disclaude-diagnostics';
export function diagnosticsPluginRoot(projectRoot) {
    let project = resolve(projectRoot);
    try {
        project = realpathSync(project);
    }
    catch {
        /* An absent Project has no installation. */
    }
    return join(project, '.disclaude', 'plugins', 'diagnostics');
}
/** Missing optional resources never add prompts or prevent normal startup. */
export function installedDiagnosticsPlugin(projectRoot) {
    try {
        const project = realpathSync(resolve(projectRoot));
        const root = diagnosticsPluginRoot(project);
        for (const directory of [project, join(project, '.disclaude'), dirname(root), root]) {
            assertDirectory(directory);
        }
        assertOwned(root);
        return root;
    }
    catch {
        // A missing, edited or redirected optional installation must not grant
        // another Project's instructions or prevent ordinary service startup.
        return undefined;
    }
}
export function diagnosticsPluginManifest(projectRoot, executionRoot = projectRoot) {
    const root = installedDiagnosticsPlugin(projectRoot);
    if (!root) {
        return '';
    }
    return new SkillsRegistry([{ kind: 'user', root }], executionRoot).resolve().manifest;
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
function readBundle(root) {
    const contents = Object.fromEntries(FILES.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
    const manifest = JSON.parse(contents[FILES[0]]);
    if (manifest.name !== PLUGIN_NAME || !manifest.version) {
        throw new Error('Invalid official diagnostics plugin bundle');
    }
    return {
        contents,
        receipt: {
            plugin: PLUGIN_NAME,
            version: manifest.version,
            hashes: Object.fromEntries(FILES.map((file) => [file, sha256(contents[file])])),
        },
    };
}
function assertDirectory(path) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Plugin path must be a real directory: ${path}`);
    }
}
/** Never traverse symlinked project metadata or remove unowned/edited files. */
function assertOwned(root) {
    assertDirectory(root);
    let receipt;
    try {
        receipt = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'));
    }
    catch {
        throw new Error('Diagnostics plugin has no readable installation receipt; preserve it and move it aside manually');
    }
    if (receipt?.plugin !== PLUGIN_NAME ||
        typeof receipt.version !== 'string' ||
        !receipt.version ||
        Object.keys(receipt.hashes ?? {})
            .sort()
            .join() !== [...FILES].sort().join()) {
        throw new Error('Diagnostics plugin has no valid installation receipt; preserve it and move it aside manually');
    }
    const expected = new Set([...FILES, RECEIPT]);
    const visit = (directory, prefix = '') => {
        assertDirectory(directory);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = prefix + entry.name;
            const path = join(directory, entry.name);
            if (entry.isDirectory() && [...expected].some((value) => value.startsWith(`${file}/`))) {
                visit(path, `${file}/`);
            }
            else if (!entry.isFile() || !expected.delete(file)) {
                throw new Error(`Unowned diagnostics plugin content; preserve it and move it aside manually: ${file}`);
            }
            else if (file !== RECEIPT && sha256(readFileSync(path, 'utf8')) !== receipt.hashes[file]) {
                throw new Error(`Modified diagnostics plugin content; preserve it and move it aside manually: ${file}`);
            }
        }
    };
    visit(root);
    if (expected.size) {
        throw new Error('Diagnostics plugin is incomplete; preserve it and move it aside manually');
    }
    return receipt;
}
export function manageDiagnosticsPlugin(command, projectRoot, builtinsRoot) {
    const project = realpathSync(resolve(projectRoot));
    assertDirectory(project);
    const root = diagnosticsPluginRoot(project);
    if (command === 'list') {
        const bundle = readBundle(join(builtinsRoot, 'optional-plugins', 'diagnostics'));
        return {
            plugin: 'diagnostics',
            availableVersion: bundle.receipt.version,
            installed: installedDiagnosticsPlugin(project) !== undefined,
            path: root,
        };
    }
    for (const path of [join(project, '.disclaude'), dirname(root)]) {
        if (!existsSync(path)) {
            mkdirSync(path);
        }
        assertDirectory(path);
    }
    const lock = join(dirname(root), '.diagnostics.lock');
    try {
        mkdirSync(lock);
    }
    catch {
        throw new Error('Diagnostics plugin operation already in progress; inspect .disclaude/plugins/.diagnostics.lock');
    }
    const staging = join(dirname(root), `.diagnostics-${randomUUID()}`);
    const backup = `${staging}-previous`;
    try {
        const existing = existsSync(root) ? assertOwned(root) : undefined;
        if (command === 'remove') {
            if (existing) {
                rmSync(root, { recursive: true });
            }
            return { plugin: 'diagnostics', installed: false, changed: !!existing, path: root };
        }
        if (command === 'update' && !existing) {
            throw new Error('Diagnostics plugin is not installed; run plugins install diagnostics first');
        }
        const bundle = readBundle(join(builtinsRoot, 'optional-plugins', 'diagnostics'));
        if (existing &&
            existing.version === bundle.receipt.version &&
            FILES.every((file) => existing.hashes[file] === bundle.receipt.hashes[file])) {
            return {
                plugin: 'diagnostics',
                installed: true,
                changed: false,
                version: existing.version,
                path: root,
            };
        }
        if (command === 'install' && existing) {
            throw new Error('Diagnostics plugin is already installed; run plugins update diagnostics');
        }
        mkdirSync(staging);
        for (const file of FILES) {
            mkdirSync(dirname(join(staging, file)), { recursive: true });
            writeFileSync(join(staging, file), bundle.contents[file]);
        }
        writeFileSync(join(staging, RECEIPT), `${JSON.stringify(bundle.receipt, null, 2)}\n`);
        if (existing) {
            renameSync(root, backup);
        }
        try {
            renameSync(staging, root);
        }
        catch (error) {
            if (existing) {
                renameSync(backup, root);
            }
            throw error;
        }
        if (existing) {
            rmSync(backup, { recursive: true });
        }
        return {
            plugin: 'diagnostics',
            installed: true,
            changed: true,
            version: bundle.receipt.version,
            path: root,
        };
    }
    finally {
        if (existsSync(staging)) {
            rmSync(staging, { recursive: true });
        }
        rmSync(lock, { recursive: true });
    }
}
