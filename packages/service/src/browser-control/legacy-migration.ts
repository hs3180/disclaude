import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync,
  realpathSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { connectBrowser } from './client.mjs';

const ENV_KEYS = [
  'DISCLAUDE_BROWSER_MODE', 'DISCLAUDE_BROWSER_SOCKET', 'DISCLAUDE_BROWSER_PYTHON',
  'DISCLAUDE_BROWSER_WORKSPACE', 'DISCLAUDE_BROWSER_EVENTS', 'DISCLAUDE_BROWSER_TARGET',
  'DISCLAUDE_CHROMIUM_BINARY', 'DISCLAUDE_CHROMIUM_PROFILE', 'DISCLAUDE_CHROMIUM_HEADLESS',
  'BU_CDP_URL', 'BH_HOME',
] as const;
type BrowserEnvKey = typeof ENV_KEYS[number];
const SETTINGS_VERSION = 1;
const LEGACY_LABEL = 'com.disclaude.browser-ipc';
const LEGACY_SYSTEMD_UNIT = 'disclaude-browser-ipc.service';
const SETTINGS_FILE = 'browser-ipc.json';

export interface LegacyBrowserDefinition {
  platform: 'darwin' | 'linux';
  label: string;
  file: string;
  entry: string;
  environment: Record<string, string>;
  loaded: boolean;
  enabled: boolean;
  pid?: number;
  raw: string;
}

export interface LegacyBrowserMigrationAdapter {
  inspect(home: string): LegacyBrowserDefinition | undefined;
  waitUntilIdle(definition: LegacyBrowserDefinition): Promise<void>;
  stop(definition: LegacyBrowserDefinition): Promise<void>;
  restore(definition: LegacyBrowserDefinition): Promise<void>;
  commit(definition: LegacyBrowserDefinition): Promise<void>;
  isAlive(pid: number): boolean;
  ownsProcess(pid: number, entry: string): boolean;
}

export interface PreparedBrowserMigration {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

function settingsPath(home: string): string {
  return resolve(home, '.disclaude', SETTINGS_FILE);
}

function parseSettings(raw: string, file: string): Partial<Record<BrowserEnvKey, string>> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`Cannot parse migrated browser settings at ${file}; preserve the file and resolve it before continuing`); }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== SETTINGS_VERSION
      || !(value as { environment?: unknown }).environment || typeof (value as { environment: unknown }).environment !== 'object') {
    throw new Error(`Migrated browser settings at ${file} have an unsupported format; preserve the file`);
  }
  const {environment} = (value as { environment: Record<string, unknown> });
  const result: Partial<Record<BrowserEnvKey, string>> = {};
  for (const [key, item] of Object.entries(environment)) {
    if (!ENV_KEYS.includes(key as BrowserEnvKey) || typeof item !== 'string') {
      throw new Error(`Migrated browser settings at ${file} contain an unsupported entry; preserve the file`);
    }
    result[key as BrowserEnvKey] = item;
  }
  return result;
}

function readPrivateSettingsFile(file: string): Buffer | undefined {
  const parent = dirname(file);
  try {
    const parentStat = lstatSync(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()
        || (process.getuid && parentStat.uid !== process.getuid())) {
      throw new Error(`Migrated browser settings directory at ${parent} must be a regular directory owned by the current user`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;}
    throw error;
  }
  let stat;
  try { stat = lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;}
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {throw new Error(`Migrated browser settings at ${file} must be a regular file`);}
  if ((stat.mode & 0o077) !== 0) {throw new Error(`Migrated browser settings at ${file} must be private (0600)`);}
  if (process.getuid && stat.uid !== process.getuid()) {throw new Error(`Migrated browser settings at ${file} must be owned by the current user`);}
  return readFileSync(file);
}

/** Load only migration-owned browser settings, never overriding config or process environment. */
export function loadMigratedBrowserEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): void {
  const file = settingsPath(home);
  const raw = readPrivateSettingsFile(file);
  if (!raw) {return;}
  const settings = parseSettings(raw.toString('utf8'), file);
  for (const [key, value] of Object.entries(settings)) {
    if (env[key] === undefined) {env[key] = value;}
  }
}

function assertManagedEntry(entry: string, home: string): void {
  if (!isAbsolute(entry)) {throw new Error('Legacy browser IPC entry is not absolute; it was preserved');}
  const releaseRoot = resolve(home, '.local/share/disclaude/browser-ipc/releases');
  const rel = relative(releaseRoot, resolve(entry));
  if (!entry.endsWith('/service.mjs') || !/^[A-Za-z0-9._-]+\/service\.mjs$/u.test(rel)) {
    throw new Error('Legacy browser IPC definition is not a recognized Disclaude-owned release; it was preserved');
  }
  let stat;
  try { stat = lstatSync(entry); }
  catch { throw new Error('Legacy browser IPC entry is missing or unreadable; it was preserved'); }
  if (stat.isSymbolicLink() || !stat.isFile()
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Legacy browser IPC entry is not a regular file owned by the current user; it was preserved');
  }
}

function assertOwnedDefinitionFile(file: string): void {
  let stat;
  try { stat = lstatSync(file); }
  catch { throw new Error(`Legacy browser IPC definition at ${file} is missing or unreadable; it was preserved`); }
  if (stat.isSymbolicLink() || !stat.isFile()
      || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Legacy browser IPC definition at ${file} is not a regular file owned by the current user; it was preserved`);
  }
}

export function parseSystemdEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inService = false;
  for (const line of text.split(/\r?\n/u)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/u);
    if (section) {
      inService = section[1] === 'Service';
      continue;
    }
    if (!inService) {continue;}
    if (/^\s*EnvironmentFile\s*=/u.test(line)) {
      throw new Error('Legacy browser IPC unit uses EnvironmentFile; move its settings into the Disclaude config before migration');
    }
    const directive = line.match(/^\s*Environment\s*=\s*(.*)$/u);
    if (!directive) {continue;}
    const [, assignments = ''] = directive;
    if (/(?:^|[^\\])\\\s*$/u.test(assignments)) {
      throw new Error('Legacy browser IPC unit uses a continued Environment directive; move its settings into the Disclaude config before migration');
    }
    const tokens: string[] = [];
    let token = '';
    let quote: '"' | "'" | undefined;
    let escaped = false;
    for (const character of assignments) {
      if (escaped) {
        token += `\\${character}`;
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (quote) {
        if (character === quote) {quote = undefined;}
        else {token += character;}
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (/\s/u.test(character)) {
        if (token) {tokens.push(token); token = '';}
      } else {
        token += character;
      }
    }
    if (escaped || quote) {throw new Error('Legacy browser IPC unit has malformed Environment quoting; it was preserved');}
    if (token) {tokens.push(token);}
    for (const assignment of tokens) {
      const separator = assignment.indexOf('=');
      const key = separator < 0 ? '' : assignment.slice(0, separator);
      if (ENV_KEYS.includes(key as BrowserEnvKey)) {
        if (separator < 0) {throw new Error(`Legacy browser IPC setting ${key} has no value; it was preserved`);}
        result[key] = assignment.slice(separator + 1).replace(/\\([\\"'\s])/gu, '$1');
      }
    }
  }
  return result;
}

function commandText(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function parseSystemdServiceState(raw: string): {
  activeState: string;
  pid?: number;
  unitFileState: string;
} {
  const properties = new Map<string, string>();
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) {
      properties.set(line.slice(0, separator), line.slice(separator + 1));
    }
  }
  const pid = Number(properties.get('MainPID'));
  return {
    activeState: properties.get('ActiveState') || '',
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined,
    unitFileState: properties.get('UnitFileState') || '',
  };
}

function inspectLaunchd(home: string): LegacyBrowserDefinition | undefined {
  const file = resolve(home, 'Library/LaunchAgents', `${LEGACY_LABEL}.plist`);
  if (!existsSync(file)) {return undefined;}
  assertOwnedDefinitionFile(file);
  const raw = readFileSync(file, 'utf8');
  let plist: { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, unknown> };
  try { plist = JSON.parse(commandText('plutil', ['-convert', 'json', '-o', '-', file])); }
  catch { throw new Error(`Cannot safely inspect ${file}; it was preserved`); }
  if (plist.Label !== LEGACY_LABEL || !Array.isArray(plist.ProgramArguments)) {
    throw new Error(`Unexpected launchd definition at ${file}; it was preserved`);
  }
  const entry = plist.ProgramArguments.find(value => typeof value === 'string' && value.endsWith('/service.mjs'));
  if (!entry) {throw new Error(`Launchd definition at ${file} has no recognized browser IPC entry; it was preserved`);}
  assertManagedEntry(entry, home);
  const environment: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = plist.EnvironmentVariables?.[key];
    if (typeof value === 'string') {environment[key] = value;}
  }
  const state = (() => {
    try { return commandText('launchctl', ['list', LEGACY_LABEL]); }
    catch { return ''; }
  })();
  const pid = Number(state.match(/"PID"\s*=\s*(\d+)/u)?.[1]);
  return { platform: 'darwin', label: LEGACY_LABEL, file, entry, environment,
    loaded: Boolean(state), enabled: Boolean(state), pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, raw };
}

function inspectSystemd(home: string): LegacyBrowserDefinition | undefined {
  const configHome = process.env.XDG_CONFIG_HOME || resolve(home, '.config');
  const file = resolve(configHome, 'systemd/user', LEGACY_SYSTEMD_UNIT);
  if (!existsSync(file)) {return undefined;}
  assertOwnedDefinitionFile(file);
  const raw = readFileSync(file, 'utf8');
  const execLine = raw.split(/\r?\n/u).find(line => /^\s*ExecStart\s*=/u.test(line)) || '';
  const entry = execLine.match(/((?:\/[^\s"']+)+\/\.local\/share\/disclaude\/browser-ipc\/releases\/[A-Za-z0-9._-]+\/service\.mjs)/u)?.[1];
  if (!entry) {throw new Error(`Unexpected systemd unit at ${file}; it was preserved`);}
  assertManagedEntry(entry, home);
  let dropInPaths: string;
  try {
    dropInPaths = commandText('systemctl', ['--user', 'show', LEGACY_SYSTEMD_UNIT, '--property=DropInPaths', '--value']);
  } catch {
    throw new Error(`Cannot verify systemd drop-ins for ${LEGACY_SYSTEMD_UNIT}; no migration was performed`);
  }
  if (dropInPaths) {
    throw new Error(`Legacy browser IPC unit has systemd drop-ins (${dropInPaths}); move their settings into the Disclaude config before migration`);
  }
  let state: string;
  try { state = commandText('systemctl', ['--user', 'show', LEGACY_SYSTEMD_UNIT, '--property=ActiveState', '--property=MainPID', '--property=UnitFileState']); }
  catch { throw new Error(`Cannot query the user systemd manager for ${LEGACY_SYSTEMD_UNIT}; no migration was performed`); }
  const { activeState, pid, unitFileState } = parseSystemdServiceState(state);
  return { platform: 'linux', label: LEGACY_SYSTEMD_UNIT, file, entry,
    environment: parseSystemdEnvironment(raw), loaded: ['active', 'activating', 'reloading', 'deactivating'].includes(activeState),
    enabled: unitFileState === 'enabled' || unitFileState === 'enabled-runtime', pid, raw };
}

function currentDefinition(home: string): LegacyBrowserDefinition | undefined {
  if (process.platform === 'darwin') {return inspectLaunchd(home);}
  if (process.platform === 'linux') {return inspectSystemd(home);}
  return undefined;
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function createHostAdapter(): LegacyBrowserMigrationAdapter {
  return {
    inspect: currentDefinition,
    async waitUntilIdle(definition) {
      const socket = definition.environment.DISCLAUDE_BROWSER_SOCKET;
      if (!socket) {throw new Error('Legacy browser IPC has no socket path; it was preserved');}
      let client: Awaited<ReturnType<typeof connectBrowser>> | undefined;
      try {
        client = await connectBrowser(socket);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          let timer: NodeJS.Timeout | undefined;
          let status: { state?: string; queued?: number };
          try {
            status = await Promise.race([
              client.request('status'),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Legacy browser IPC status timed out')), 3000);
              }),
            ]);
          } finally { if (timer) {clearTimeout(timer);} }
          if (status.state === 'idle' && status.queued === 0) {return;}
          await delay(250);
        }
        throw new Error('Legacy browser IPC has active/queued work; migration stopped before interrupting it');
      } catch (error) {
        throw new Error(`Cannot verify that legacy browser IPC is idle; migration stopped: ${error instanceof Error ? error.message : String(error)}`);
      } finally { client?.close(); }
    },
    stop(definition) {
      if (definition.platform === 'darwin') {
        if (definition.loaded) {commandText('launchctl', ['bootout', launchdDomain(), definition.file]);}
        return Promise.resolve();
      }
      commandText('systemctl', ['--user', 'disable', '--now', definition.label]);
      return Promise.resolve();
    },
    restore(definition) {
      if (!existsSync(definition.file)) {writeFileSync(definition.file, definition.raw, { mode: 0o600, flag: 'wx' });}
      if (definition.platform === 'darwin') {
        if (definition.loaded) {commandText('launchctl', ['bootstrap', launchdDomain(), definition.file]);}
        return Promise.resolve();
      }
      commandText('systemctl', ['--user', 'daemon-reload']);
      if (definition.enabled) {commandText('systemctl', ['--user', 'enable', definition.label]);}
      if (definition.loaded) {commandText('systemctl', ['--user', 'start', definition.label]);}
      return Promise.resolve();
    },
    commit(definition) {
      if (definition.platform === 'darwin') {
        const current = inspectLaunchd(homedir());
        if (current?.loaded) {throw new Error('Legacy browser IPC relaunched during migration; its definition was preserved');}
        rmSync(definition.file);
        return Promise.resolve();
      }
      const current = inspectSystemd(homedir());
      if (current?.loaded || current?.pid) {
        throw new Error('Legacy browser IPC became active during migration; its definition was preserved');
      }
      if (definition.enabled) {commandText('systemctl', ['--user', 'disable', definition.label]);}
      rmSync(definition.file);
      commandText('systemctl', ['--user', 'daemon-reload']);
      return Promise.resolve();
    },
    isAlive(pid) {
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    },
    ownsProcess(pid, entry) {
      try {
        const cmd = commandText('ps', ['-p', String(pid), '-o', 'command=']);
        return cmd.includes(entry);
      } catch { return false; }
    },
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isWithinOrEqual(parent: string, child: string): boolean {
  return resolve(parent) === resolve(child) || isWithin(parent, child);
}

function assertOwnedStateDirectories(home: string): string {
  const root = resolve(home, '.local/state/disclaude/browser-ipc');
  for (const path of [resolve(home, '.local'), resolve(home, '.local/state'), resolve(home, '.local/state/disclaude'), root]) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {continue;}
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()
        || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Legacy browser IPC state directory is unsafe or not owned by the current user; it was preserved');
    }
  }
  return root;
}

function readOwnedLock(socket: string, home: string): { path: string; raw: string; pid: number; instance?: string } | undefined {
  const root = assertOwnedStateDirectories(home);
  const lockPath = `${socket}.lock`;
  if (!isAbsolute(socket) || !isWithin(root, resolve(socket))) {
    throw new Error('Legacy browser IPC socket is outside its owned state directory; it was preserved');
  }
  if ((existsSync(lockPath) || existsSync(socket))
      && (!existsSync(root) || !isWithinOrEqual(realpathSync(root), realpathSync(dirname(socket))))) {
    throw new Error('Legacy browser IPC socket resolves outside its owned state directory; it was preserved');
  }
  if (existsSync(socket)) {
    const socketStat = lstatSync(socket);
    if (socketStat.isSymbolicLink() || !socketStat.isSocket()
        || (process.getuid && socketStat.uid !== process.getuid())) {
      throw new Error('Legacy browser IPC socket is not an owned Unix socket; it was preserved');
    }
  }
  if (!existsSync(lockPath)) {return undefined;}
  const lockStat = lstatSync(lockPath);
  if (lockStat.isSymbolicLink() || !lockStat.isFile()
      || (process.getuid && lockStat.uid !== process.getuid())) {
    throw new Error('Legacy browser IPC lock is not a regular owned file; it was preserved');
  }
  const raw = readFileSync(lockPath, 'utf8');
  let lock: { pid?: unknown; instance?: unknown };
  try { lock = JSON.parse(raw); }
  catch { throw new Error('Legacy browser IPC lock is unreadable; it was preserved'); }
  if (!Number.isSafeInteger(lock.pid) || (lock.instance !== undefined && typeof lock.instance !== 'string')) {
    throw new Error('Legacy browser IPC lock ownership is invalid; it was preserved');
  }
  return { path: lockPath, raw, pid: lock.pid as number, instance: lock.instance as string | undefined };
}

function assertCoordinatedConfiguration(env: NodeJS.ProcessEnv): void {
  const socket = env.DISCLAUDE_BROWSER_SOCKET;
  if (!socket || !isAbsolute(socket) || Buffer.byteLength(socket) > 95) {
    throw new Error('Legacy browser IPC settings cannot be migrated: configure an absolute socket path of at most 95 bytes');
  }
  if (Boolean(env.BU_CDP_URL) === Boolean(env.DISCLAUDE_CHROMIUM_BINARY)) {
    throw new Error('Legacy browser IPC settings cannot be migrated: configure exactly one of BU_CDP_URL or DISCLAUDE_CHROMIUM_BINARY');
  }
}

function mergePersistedSettings(file: string, incoming: Partial<Record<BrowserEnvKey, string>>): Buffer | undefined {
  const original = readPrivateSettingsFile(file);
  let previous: Partial<Record<BrowserEnvKey, string>> = {};
  if (original) {
    previous = parseSettings(original.toString('utf8'), file);
  }
  const merged = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    if (merged[key as BrowserEnvKey] !== undefined && merged[key as BrowserEnvKey] !== value) {
      throw new Error(`Existing migrated browser setting ${key} conflicts with the legacy service; both were preserved`);
    }
    merged[key as BrowserEnvKey] = value;
  }
  if (Object.keys(incoming).length === 0) {return original;}
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Refuse to write through a user-created symlink or into another user's directory.
  readPrivateSettingsFile(file);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: SETTINGS_VERSION, environment: merged }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
  return original;
}

function restorePersistedSettings(file: string, original: Buffer | undefined): void {
  // Also validate the destination during rollback; never follow a replaced parent.
  if (existsSync(dirname(file))) {
    const parent = lstatSync(dirname(file));
    if (parent.isSymbolicLink() || !parent.isDirectory()
        || (process.getuid && parent.uid !== process.getuid())) {
      throw new Error(`Migrated browser settings directory at ${dirname(file)} changed during rollback; preserve it`);
    }
  }
  if (original === undefined) { rmSync(file, { force: true }); return; }
  const temp = `${file}.${process.pid}.${Date.now()}.rollback`;
  writeFileSync(temp, original, { flag: 'wx', mode: 0o600 });
  renameSync(temp, file);
}

async function waitForOwnedProcessExit(
  definition: LegacyBrowserDefinition,
  lock: { pid: number } | undefined,
  adapter: LegacyBrowserMigrationAdapter,
): Promise<void> {
  const pid = lock?.pid ?? definition.pid;
  if (!pid) {return;}
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!adapter.isAlive(pid) || !adapter.ownsProcess(pid, definition.entry)) {return;}
    await delay(100);
  }
  throw new Error(`Legacy browser IPC process ${pid} did not stop; no socket or lock was removed`);
}

function removeOwnedArtifacts(
  socket: string,
  home: string,
  lock: { path: string; raw: string; pid: number; instance?: string } | undefined,
): void {
  let socketStat;
  try { socketStat = lstatSync(socket); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;} }
  const socketExists = Boolean(socketStat);
  let lockExists = false;
  if (lock) {
    let lockStat;
    try { lockStat = lstatSync(lock.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;} }
    if (lockStat) {
      if (lockStat.isSymbolicLink() || !lockStat.isFile()
          || (process.getuid && lockStat.uid !== process.getuid())) {
        throw new Error('Legacy browser IPC lock changed to an unsafe file during migration; it was preserved');
      }
      lockExists = true;
      if (readFileSync(lock.path, 'utf8') !== lock.raw) {
        throw new Error('Legacy browser IPC lock changed during migration; artifacts were preserved');
      }
    }
  }
  const root = assertOwnedStateDirectories(home);
  if ((socketExists || lockExists)
      && (!existsSync(root) || !isWithinOrEqual(realpathSync(root), realpathSync(dirname(socket))))) {
    throw new Error('Legacy browser IPC artifacts resolve outside their owned state directory; they were preserved');
  }
  if (socketExists) {
    if (!lock) {throw new Error('Legacy browser IPC socket has no ownership lock; it was preserved');}
    if (socketStat?.isSymbolicLink() || !socketStat?.isSocket()
        || (process.getuid && socketStat.uid !== process.getuid())) {
      throw new Error('Legacy browser IPC socket path is not an owned Unix socket; it was preserved');
    }
  }
  if (socketExists) {rmSync(socket);}
  if (lockExists && lock) {rmSync(lock.path);}
  // The dedicated bin is not removed: it may be referenced by existing agent PATHs or archives.
}

/**
 * Disable a recognized standalone browser IPC service before the Disclaude
 * service starts its supervised broker. The old definition remains available
 * for rollback until the owning service reports fully ready.
 */
export async function prepareLegacyBrowserIpcMigration(
  env: NodeJS.ProcessEnv = process.env,
  options: { home?: string; adapter?: LegacyBrowserMigrationAdapter } = {},
): Promise<PreparedBrowserMigration | undefined> {
  // Test services and explicitly isolated instances may share the same OS user
  // as the installed service. Do not inspect or mutate that user's manager.
  if (env.DISCLAUDE_BROWSER_MIGRATION === 'skip') {return undefined;}
  const home = options.home || homedir();
  const adapter = options.adapter || createHostAdapter();
  const file = settingsPath(home);
  const definition = adapter.inspect(home);
  if (!definition) {return undefined;}
  assertManagedEntry(definition.entry, home);
  if (definition.label !== LEGACY_LABEL && definition.label !== LEGACY_SYSTEMD_UNIT) {
    throw new Error('Legacy browser IPC service identity is not recognized; it was preserved');
  }
  const priorEnv = new Map<BrowserEnvKey, string | undefined>(ENV_KEYS.map(key => [key, env[key]]));
  const socket = definition.environment.DISCLAUDE_BROWSER_SOCKET;
  if (!socket) {throw new Error('Legacy browser IPC definition has no socket path; it was preserved');}
  if (env.DISCLAUDE_BROWSER_SOCKET !== undefined && env.DISCLAUDE_BROWSER_SOCKET !== socket) {
    throw new Error('Legacy browser IPC uses a different socket from this service configuration; no service or files were changed');
  }
  const lock = readOwnedLock(socket, home);
  if (definition.loaded && (!definition.pid || !lock || lock.pid !== definition.pid)) {
    if (!definition.pid && lock && !adapter.isAlive(lock.pid)) {
      // launchd/systemd can report a loaded job with no active process after a
      // crash. A dead, owned lock is safe to retire after the unit is unloaded.
    } else {
      throw new Error('Cannot match the running legacy broker to its IPC lock; no service or files were changed');
    }
  }
  if (definition.loaded && definition.pid && !adapter.ownsProcess(definition.pid, definition.entry)) {
    throw new Error('Legacy browser IPC PID does not match its managed entry; no service or files were changed');
  }
  if (lock && adapter.isAlive(lock.pid) && (!definition.pid || lock.pid !== definition.pid)) {
    throw new Error(`Legacy browser IPC lock PID ${lock.pid} is not owned by the recognized service; it was preserved`);
  }
  let previousSettings: Buffer | undefined;
  let settingsWritten = false;
  let stopAttempted = false;
  try {
    const imported: Partial<Record<BrowserEnvKey, string>> = {};
    for (const key of ENV_KEYS) {
      const value = definition.environment[key];
      if (env[key] === undefined && value !== undefined) {
        env[key] = value;
        imported[key] = value;
      }
    }
    if (env.DISCLAUDE_BROWSER_MODE === undefined) {
      env.DISCLAUDE_BROWSER_MODE = 'coordinated';
      imported.DISCLAUDE_BROWSER_MODE = 'coordinated';
    }
    if (env.DISCLAUDE_BROWSER_MODE !== 'coordinated') {
      throw new Error('The main Disclaude config disables coordinated browser mode; legacy service was preserved');
    }
    assertCoordinatedConfiguration(env);
    // Keep the old settings available after the standalone service definition is removed.
    previousSettings = mergePersistedSettings(file, imported);
    settingsWritten = true;
    if (definition.loaded && definition.pid) {await adapter.waitUntilIdle(definition);}
    stopAttempted = true;
    await adapter.stop(definition);
    await waitForOwnedProcessExit(definition, lock, adapter);
    removeOwnedArtifacts(socket, home, lock);
  } catch (error) {
    let restoreError: unknown;
    const ownerStillRunning = Boolean(lock && adapter.isAlive(lock.pid) && adapter.ownsProcess(lock.pid, definition.entry));
    if (stopAttempted && !ownerStillRunning) {
      try { await adapter.restore(definition); }
      catch (restore) { restoreError = restore; }
    }
    if (settingsWritten) {restorePersistedSettings(file, previousSettings);}
    for (const [key, value] of priorEnv) {
      if (value === undefined) {delete env[key];} else {env[key] = value;}
    }
    if (restoreError) {
      throw new AggregateError([error, restoreError], 'Browser IPC migration failed and the legacy service could not be restored; preserve all service files and inspect both errors');
    }
    throw error;
  }
  let done = false;
  return {
    async commit() {
      if (done) {return;}
      await adapter.commit(definition);
      done = true;
    },
    async rollback() {
      if (done) {return;}
      let restoreError: unknown;
      try { await adapter.restore(definition); }
      catch (error) { restoreError = error; }
      restorePersistedSettings(file, previousSettings);
      for (const [key, value] of priorEnv) {
        if (value === undefined) {delete env[key];} else {env[key] = value;}
      }
      done = true;
      if (restoreError) {throw restoreError;}
    },
  };
}
