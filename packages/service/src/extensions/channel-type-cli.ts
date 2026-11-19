/**
 * `disclaude channel-type <subcommand>` — runtime channel-type registration
 * via the CLI (#5745, r2 S2): register/list/unregister persist through
 * ChannelTypeStore so `disclaude start` can apply them into
 * channelTypeRegistry (apply path lands in a follow-up slice). Register
 * never touches a running service here — it reports the persisted-pending
 * state, matching the "declarative reload allowed" wording of the review.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import {
  BUILTIN_CHANNEL_TYPE_IDS,
  ChannelTypeStore,
  ChannelTypeStoreError,
  type ChannelTypeRecord,
} from './channel-type-store.js';

export interface ChannelTypeCliDeps {
  /** Root config dir; registrations live under `<configDir>/extensions/`. */
  configDir: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = `Usage:
  disclaude channel-type register <type> --module <path> [--name <displayName>]
  disclaude channel-type unregister <type>
  disclaude channel-type list [--json]

Registers external channel types (#5745): the module must default-export a
WiredChannelDescriptor and live under <configDir>/extensions/; built-in ids
(rest, feishu, wechat) can never be overridden or unregistered.`;

function usageError(deps: ChannelTypeCliDeps, detail: string): number {
  deps.stderr?.(detail);
  deps.stderr?.(USAGE);
  return 1;
}

/** The extension dir both the store file and registered modules must live in. */
function extensionDir(configDir: string): string {
  return resolve(configDir, 'extensions');
}

function insideExtensionDir(configDir: string, modulePath: string): boolean {
  const rel = relative(extensionDir(configDir), modulePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function formatRecord(record: ChannelTypeRecord): string {
  const name = record.displayName ? ` (${record.displayName})` : '';
  return `${record.type}${name}\texternal\t${record.modulePath}\tregistered ${record.registeredAt}`;
}

export function runChannelTypeCommand(args: string[], deps: ChannelTypeCliDeps): number {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined || subcommand === '--help' || subcommand === 'help') {
    deps.stdout?.(USAGE);
    return subcommand === undefined ? 1 : 0;
  }

  const store = ChannelTypeStore.forConfigDir(deps.configDir);

  if (subcommand === 'register') {
    let type = '';
    let modulePath: string | undefined;
    let displayName: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--module') {
        modulePath = rest[++i];
      } else if (arg === '--name') {
        displayName = rest[++i];
      } else if (!arg.startsWith('-')) {
        if (type !== '') { return usageError(deps, `Unexpected extra argument: ${arg}`); }
        type = arg;
      } else {
        return usageError(deps, `Unknown option: ${arg}`);
      }
    }
    if (type === '') { return usageError(deps, 'Missing <type> for register.'); }
    if (!modulePath) { return usageError(deps, 'Missing --module <path> for register.'); }
    if (displayName !== undefined && !displayName.trim()) {
      return usageError(deps, '--name must be a non-empty display name.');
    }
    const resolved = resolve(modulePath);
    if (!insideExtensionDir(deps.configDir, resolved)) {
      return usageError(
        deps,
        `Module path must resolve inside ${extensionDir(deps.configDir)}, got ${resolved}. `
          + 'Place the module under the extensions directory first.'
      );
    }
    try {
      const result = store.upsert({ type, modulePath: resolved, ...(displayName ? { displayName } : {}) });
      if (result.status === 'unchanged') {
        deps.stdout?.(`Channel type "${type}" already registered from an identical module; nothing to do.`);
      } else {
        deps.stdout?.(
          `Registered channel type "${type}" from ${resolved}. `
          + 'Persisted — picked up by the running service via reload or the next `disclaude start`.'
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof ChannelTypeStoreError) {
        deps.stderr?.(error.message);
        return 1;
      }
      throw error;
    }
  }

  if (subcommand === 'unregister') {
    const [type] = rest;
    if (rest.length !== 1 || type === undefined || type.startsWith('-')) {
      return usageError(deps, 'Expected exactly one <type> for unregister.');
    }
    try {
      const record = store.remove(type);
      deps.stdout?.(`Unregistered channel type "${record.type}" (module ${record.modulePath}).`);
      return 0;
    } catch (error) {
      if (error instanceof ChannelTypeStoreError) {
        deps.stderr?.(error.message);
        return 1;
      }
      throw error;
    }
  }

  if (subcommand === 'list') {
    const asJson = rest.includes('--json');
    if (rest.some((arg) => arg.startsWith('-') && arg !== '--json')) {
      return usageError(deps, 'Unknown option for list (only --json is supported).');
    }
    const records = store.list();
    if (asJson) {
      const entries = [
        ...BUILTIN_CHANNEL_TYPE_IDS.map((id) => ({ type: id, source: 'builtin' as const })),
        ...records.map((record) => ({
          type: record.type,
          source: 'external' as const,
          modulePath: record.modulePath,
          ...(record.displayName ? { displayName: record.displayName } : {}),
          registeredAt: record.registeredAt,
        })),
      ];
      deps.stdout?.(JSON.stringify(entries, null, 2));
    } else {
      deps.stdout?.(BUILTIN_CHANNEL_TYPE_IDS.map((id) => `${id}\tbuiltin`).join('\n'));
      deps.stdout?.(records.map(formatRecord).join('\n'));
    }
    return 0;
  }

  return usageError(deps, `Unknown channel-type subcommand: ${subcommand}`);
}
