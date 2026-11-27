/**
 * Cold-path apply of durably registered external channel types (#5745, r2 S3):
 * `disclaude start` reads the ChannelTypeStore written by
 * `disclaude channel-type register`, dynamically imports each registered
 * module, validates the exported descriptor shape and registers it into the
 * runtime channel-type registry — before cli-main.ts enumerates the registry
 * for channel creation, so config `channels.<name>: { type }` entries can
 * create instances of external types with zero core-code changes.
 *
 * Error isolation is the contract (review #5745): one bad record — module
 * unreadable, import throwing, wrong shape, or a duplicate id — is logged and
 * skipped; it never blocks the remaining records, the built-ins, or service
 * startup. The store document itself is corrupt-or-absent tolerant at this
 * layer: a corrupt document warns and skips the whole apply (register/unregister
 * remain the strict, fail-closed surface).
 */
import { pathToFileURL } from 'node:url';
import type { ExtensionSection } from '@disclaude/core';
import type { WiredChannelDescriptor } from '../channel-lifecycle-manager.js';
import { channelTypeRegistry } from '../channels/wired-descriptors.js';
import { ChannelTypeStore, type ChannelTypeRecord } from './channel-type-store.js';

export interface ApplyChannelTypesDeps {
  /** Registry to register into; defaults to the runtime channelTypeRegistry. */
  registry?: ExtensionSection<WiredChannelDescriptor>;
  /** Receives one line per skipped record (and one for an unreadable store). */
  warn?: (message: string) => void;
}

export interface ApplyChannelTypesResult {
  applied: string[];
  failed: Array<{ type: string; reason: string }>;
}

const REQUIRED_DESCRIPTOR_FUNCTIONS = ['factory', 'createCallbacks', 'createMessageHandler'] as const;

function descriptorShapeError(descriptor: unknown, record: ChannelTypeRecord): string | null {
  if (descriptor === null || typeof descriptor !== 'object') {
    return `module must default-export a WiredChannelDescriptor object, got ${typeof descriptor}`;
  }
  const candidate = descriptor as Partial<WiredChannelDescriptor> & Record<string, unknown>;
  if (typeof candidate.type !== 'string' || candidate.type !== record.type) {
    return `descriptor type must be ${JSON.stringify(record.type)}, got ${JSON.stringify(candidate.type)}`;
  }
  for (const member of REQUIRED_DESCRIPTOR_FUNCTIONS) {
    if (typeof candidate[member] !== 'function') {
      return `descriptor member "${member}" must be a function`;
    }
  }
  if (candidate.setup !== undefined && typeof candidate.setup !== 'function') {
    return 'descriptor member "setup" must be a function when present';
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Applies every record in `store` into `deps.registry` (default: the runtime
 * channelTypeRegistry). Never throws for per-record problems; resolves with
 * the applied/failed split so callers can log a startup summary.
 */
export async function applyChannelTypes(
  store: ChannelTypeStore,
  deps: ApplyChannelTypesDeps = {}
): Promise<ApplyChannelTypesResult> {
  const registry = deps.registry ?? channelTypeRegistry;
  const warn = deps.warn ?? (() => {});
  const result: ApplyChannelTypesResult = { applied: [], failed: [] };
  for (const record of store.list()) {
    try {
      const module = await import(pathToFileURL(record.modulePath).href);
      const shapeError = descriptorShapeError(
        (module as { default?: unknown }).default,
        record
      );
      if (shapeError !== null) {
        throw new Error(shapeError);
      }
      registry.register(record.type, module.default as WiredChannelDescriptor, {
        source: 'external',
      });
      result.applied.push(record.type);
    } catch (error) {
      const reason = errorMessage(error);
      result.failed.push({ type: record.type, reason });
      warn(`Skipping external channel type "${record.type}" (${record.modulePath}): ${reason}`);
    }
  }
  return result;
}

/**
 * Config-dir convenience for the `disclaude start` cold path: an unreadable or
 * corrupt store document degrades to "no external types" with a warning
 * instead of failing startup.
 */
export async function applyChannelTypesForConfigDir(
  configDir: string,
  deps: ApplyChannelTypesDeps = {}
): Promise<ApplyChannelTypesResult> {
  const warn = deps.warn ?? (() => {});
  try {
    return await applyChannelTypes(ChannelTypeStore.forConfigDir(configDir), deps);
  } catch (error) {
    warn(`Cannot load channel types under ${configDir}: ${errorMessage(error)} — external channel types skipped.`);
    return { applied: [], failed: [] };
  }
}
