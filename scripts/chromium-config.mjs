/** Persistent browser configuration, independent of package location and cwd. */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const CHROMIUM_CONFIG_KEYS = [
  'CHROMIUM_CDP_BINARY', 'CHROMIUM_CDP_PROFILE_DIR', 'CHROMIUM_CDP_PORT',
  'CHROMIUM_CDP_ADDRESS', 'CHROMIUM_CDP_HEADED', 'CHROMIUM_CDP_AUTOSTART',
];

export function chromiumConfigPath(env = process.env, home = homedir()) {
  const path = env.DISCLAUDE_CHROMIUM_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'disclaude', 'chromium-cdp.json');
  if (!isAbsolute(path)) throw new Error('Chromium configuration path must be absolute');
  return path;
}

function validate(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 ||
      !config.environment || typeof config.environment !== 'object' || Array.isArray(config.environment)) {
    throw new Error('Invalid Chromium configuration: expected version 1 and environment object');
  }
  for (const [key, value] of Object.entries(config.environment)) {
    if (!CHROMIUM_CONFIG_KEYS.includes(key) || typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error('Invalid Chromium configuration field');
    }
    if (['CHROMIUM_CDP_BINARY', 'CHROMIUM_CDP_PROFILE_DIR'].includes(key) && !isAbsolute(value)) {
      throw new Error(`${key} must be an absolute path`);
    }
    if (key === 'CHROMIUM_CDP_PORT' && (!/^\d+$/.test(value) || +value < 1 || +value > 65535)) {
      throw new Error('CHROMIUM_CDP_PORT must be an integer between 1 and 65535');
    }
    if (['CHROMIUM_CDP_HEADED', 'CHROMIUM_CDP_AUTOSTART'].includes(key) && !['0', '1'].includes(value)) {
      throw new Error(`${key} must be 0 or 1 in saved configuration`);
    }
  }
  return config.environment;
}

export function readChromiumConfig(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let config;
  try { config = JSON.parse(raw); }
  catch { throw new Error('Invalid Chromium configuration JSON'); }
  return validate(config);
}

export function loadChromiumConfig(env = process.env, path = chromiumConfigPath(env)) {
  const saved = readChromiumConfig(path);
  for (const [key, value] of Object.entries(saved)) {
    if (!(key in env)) env[key] = value;
  }
}

export function saveChromiumConfig(environment, path = chromiumConfigPath()) {
  const config = { version: 1, environment };
  validate(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
