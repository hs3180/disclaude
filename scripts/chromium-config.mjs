/** Persistent browser configuration, independent of package location and cwd. */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync, existsSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';

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

/** Read explicitly selected legacy configuration as data, never as shell code. */
export function readChromiumConfigImport(path, destination = chromiumConfigPath()) {
  if (!isAbsolute(path || '')) throw new Error('Imported configuration path must be absolute');
  const source = realpathSync(path);
  if (source === (existsSync(destination) ? realpathSync(destination) : resolve(destination))) {
    throw new Error('Import source is the active configuration destination; use normal setup instead');
  }
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Import requires a regular configuration file no larger than 64 KiB');
    const buffer = Buffer.alloc(65537);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > 65536) throw new Error('Imported configuration exceeded 64 KiB while reading');
    bytes = buffer.subarray(0, size);
  } finally { closeSync(fd); }
  const raw = bytes.toString('utf8');
  let environment;
  if (raw.trimStart().startsWith('{')) {
    let config;
    try { config = JSON.parse(raw); } catch { throw new Error('Invalid imported configuration JSON'); }
    environment = validate(config);
  } else {
    environment = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(CHROMIUM_CDP_[A-Z_]+)\s*=(.*)$/);
      if (!match) {
        if (/^\s*(?:export\s+)?CHROMIUM_CDP_/.test(line)) throw new Error('Invalid browser assignment in imported configuration');
        continue;
      }
      const [, key, text] = match;
      if (!CHROMIUM_CONFIG_KEYS.includes(key)) throw new Error(`Unsupported imported browser field: ${key}`);
      if (key in environment) throw new Error(`Repeated imported browser field: ${key}`);
      let value = text.trim();
      const quote = value[0];
      if (quote === '"' || quote === "'") {
        if (value.length < 2 || !value.endsWith(quote)) throw new Error(`Unterminated imported browser value: ${key}`);
        value = value.slice(1, -1);
      }
      if (quote !== "'" && /[$`\\]/.test(value)) throw new Error(`Use a literal value without shell expansion for ${key}`);
      environment[key] = value;
    }
    validate({ version: 1, environment });
  }
  if (!Object.keys(environment).length) throw new Error('Imported configuration contains no browser settings');
  if (environment.CHROMIUM_CDP_ADDRESS && environment.CHROMIUM_CDP_ADDRESS !== '127.0.0.1') {
    throw new Error('Imported browser address must be 127.0.0.1; reconcile the old network configuration explicitly');
  }
  return { source, sha256: createHash('sha256').update(bytes).digest('hex'), environment };
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
