/**
 * Durable channel-type registrations backing runtime channel registration
 * via the disclaude CLI (#5745): records which external channel types exist
 * and which module implements each, so `disclaude start` can apply them into
 * `channelTypeRegistry` and config `channels.<name>: { type }` entries can
 * create instances with zero core-code changes.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Built-in channel types pre-registered by channels/wired-descriptors.ts — never overridable. */
export const BUILTIN_CHANNEL_TYPE_IDS: readonly string[] = ['rest', 'feishu', 'wechat'];

const CHANNEL_TYPE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ChannelTypeRecord {
  type: string;
  /** Absolute path to the ESM module default-exporting the WiredChannelDescriptor. */
  modulePath: string;
  displayName?: string;
  registeredAt: string;
  moduleMtimeMs: number;
  contentHash: string;
}

interface ChannelTypeDocument { version: 1; channelTypes: Record<string, ChannelTypeRecord> }

export type ChannelTypeStoreErrorCode = 'invalid' | 'reserved' | 'conflict' | 'unknown';

export class ChannelTypeStoreError extends Error {
  constructor(message: string, readonly code: ChannelTypeStoreErrorCode) {
    super(message);
    this.name = 'ChannelTypeStoreError';
  }
}

export interface ChannelTypeUpsertInput {
  type: string;
  modulePath: string;
  displayName?: string;
}

export type ChannelTypeUpsertResult =
  | { status: 'registered'; record: ChannelTypeRecord }
  | { status: 'unchanged'; record: ChannelTypeRecord };

function validRecord(value: ChannelTypeRecord, type: string): boolean {
  return value !== null && typeof value === 'object' && value.type === type
    && typeof value.modulePath === 'string' && isAbsolute(value.modulePath)
    && (value.displayName === undefined || (typeof value.displayName === 'string' && !!value.displayName.trim()))
    && typeof value.registeredAt === 'string' && Number.isFinite(Date.parse(value.registeredAt))
    && Number.isFinite(value.moduleMtimeMs)
    && typeof value.contentHash === 'string' && /^[0-9a-f]{64}$/.test(value.contentHash);
}

/**
 * Synchronous, owner-only and atomic. Persisted as
 * `<configDir>/extensions/channel-types.json`; a corrupt document is fatal at
 * load instead of silently dropping registrations. Record identity is
 * modulePath + content hash, so re-registering an unchanged module is a
 * no-op while a same-type/different-module registration is a listed-diff
 * error (registry `override: false` semantics, no silent replacement).
 */
export class ChannelTypeStore {
  private readonly channelTypes: Record<string, ChannelTypeRecord>;

  constructor(readonly filePath: string, readonly builtinIds: readonly string[] = BUILTIN_CHANNEL_TYPE_IDS) {
    let document: ChannelTypeDocument = { version: 1, channelTypes: {} };
    try {
      if (statSync(filePath).size > 1024 * 1024) { throw new Error('too large'); }
      chmodSync(filePath, 0o600);
      document = JSON.parse(readFileSync(filePath, 'utf8')) as ChannelTypeDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read channel types at ${filePath}`);
      }
    }
    if (document.version !== 1 || !document.channelTypes || typeof document.channelTypes !== 'object'
      || Array.isArray(document.channelTypes)
      || !Object.entries(document.channelTypes).every(([type, record]) => validRecord(record, type))) {
      throw new Error(`Invalid channel types at ${filePath}`);
    }
    this.channelTypes = document.channelTypes;
  }

  static forConfigDir(configDir: string, builtinIds?: readonly string[]): ChannelTypeStore {
    return new ChannelTypeStore(join(configDir, 'extensions', 'channel-types.json'), builtinIds);
  }

  list(): ChannelTypeRecord[] {
    return Object.values(this.channelTypes).map((record) => ({ ...record }));
  }

  get(type: string): ChannelTypeRecord | undefined {
    const record = this.channelTypes[type];
    return record ? { ...record } : undefined;
  }

  upsert({ type, modulePath, displayName }: ChannelTypeUpsertInput): ChannelTypeUpsertResult {
    if (!CHANNEL_TYPE_ID_PATTERN.test(type)) {
      throw new ChannelTypeStoreError(
        `Invalid channel type id ${JSON.stringify(type)}: expected a lowercase identifier matching ${CHANNEL_TYPE_ID_PATTERN}`,
        'invalid'
      );
    }
    if (this.builtinIds.includes(type)) {
      throw new ChannelTypeStoreError(
        `Channel type "${type}" is built-in and cannot be overridden or unregistered`,
        'reserved'
      );
    }
    if (!isAbsolute(modulePath)) {
      throw new ChannelTypeStoreError(
        `Channel type "${type}" module path must be absolute, got ${modulePath}`,
        'invalid'
      );
    }
    let moduleContent: Buffer;
    let moduleMtimeMs: number;
    try {
      moduleMtimeMs = statSync(modulePath).mtimeMs;
      moduleContent = readFileSync(modulePath);
    } catch {
      throw new ChannelTypeStoreError(`Channel type "${type}" module not readable at ${modulePath}`, 'invalid');
    }
    const contentHash = createHash('sha256').update(moduleContent).digest('hex');
    const previous = this.channelTypes[type];
    if (previous && previous.modulePath === modulePath && previous.contentHash === contentHash) {
      return { status: 'unchanged', record: { ...previous } };
    }
    if (previous) {
      throw new ChannelTypeStoreError(
        `Channel type "${type}" is already registered from ${previous.modulePath} `
          + `(sha256 ${previous.contentHash}); refusing to replace with ${modulePath} (sha256 ${contentHash}) `
          + '— unregister it first',
        'conflict'
      );
    }
    const record: ChannelTypeRecord = {
      type,
      modulePath,
      ...(displayName ? { displayName } : {}),
      registeredAt: new Date().toISOString(),
      moduleMtimeMs,
      contentHash,
    };
    this.channelTypes[type] = record;
    try { this.write(); } catch (error) {
      delete this.channelTypes[type];
      throw error;
    }
    return { status: 'registered', record: { ...record } };
  }

  remove(type: string): ChannelTypeRecord {
    if (this.builtinIds.includes(type)) {
      throw new ChannelTypeStoreError(
        `Channel type "${type}" is built-in and cannot be overridden or unregistered`,
        'reserved'
      );
    }
    const previous = this.channelTypes[type];
    if (!previous) {
      throw new ChannelTypeStoreError(`Channel type "${type}" is not registered`, 'unknown');
    }
    delete this.channelTypes[type];
    try { this.write(); } catch (error) {
      this.channelTypes[type] = previous;
      throw error;
    }
    return { ...previous };
  }

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${dirname(this.filePath)}/.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, channelTypes: this.channelTypes }, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.filePath);
    } finally { rmSync(temp, { force: true }); }
  }
}
