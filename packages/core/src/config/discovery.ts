// Keep this entry free of Config, logger and other runtime initialization.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

export const EXPLICIT_CONFIG_PATH_ENV = 'DISCLAUDE_CONFIG_PATH';
export function discoverConfigFile(): { path: string; exists: boolean } {
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
      if (existsSync(path)) {return { path, exists: true };}
    }
  }
  return { path: '', exists: false };
}

/** Read only configured environment entries without initializing Config or its logger. */
export function loadConfigEnvironment(filePath?: string): Record<string, string> {
  const file = filePath ? resolve(filePath) : discoverConfigFile().path;
  if (!file || !existsSync(file)) {return {};}
  const parsed = yaml.load(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {return {};}
  const environment = (parsed as { env?: unknown }).env;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {return {};}
  return Object.fromEntries(Object.entries(environment)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]));
}
