// Keep this entry free of Config, logger and other runtime initialization.
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
export const EXPLICIT_CONFIG_PATH_ENV = 'DISCLAUDE_CONFIG_PATH';
export function discoverConfigFile() {
    const explicit = process.env[EXPLICIT_CONFIG_PATH_ENV];
    if (explicit) {
        const path = resolve(explicit);
        return { path, exists: existsSync(path) };
    }
    const roots = [
        process.env.HOME ? resolve(process.env.HOME, '.disclaude') : '',
        process.cwd(),
        process.env.WORKSPACE_DIR ? resolve(process.env.WORKSPACE_DIR, '..') : '',
        resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    ].filter(Boolean);
    for (const root of roots) {
        for (const name of ['disclaude.config.yaml', 'disclaude.config.yml']) {
            const path = resolve(root, name);
            if (existsSync(path)) {
                return { path, exists: true };
            }
        }
    }
    return { path: '', exists: false };
}
