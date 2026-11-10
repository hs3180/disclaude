/**
 * External extension module loading (Issue #5745 Part 4).
 *
 * `extensions.<name>: { module, enabled }` declarations in
 * disclaude.config.yaml map to ES modules loaded here. A module exports a
 * `register` (or default) function that receives {@link ExtensionModuleContext}
 * and registers into the unified extension registries (harness provider /
 * channel type / llms.via / llms.api.protocol) — the same sections builtins
 * are preregistered into, so third-party types reach `/agent` switching,
 * channel wiring and config validation with zero core-code changes.
 *
 * Security boundary:
 * - **Default disabled.** A declaration does nothing unless it sets
 *   `enabled: true`; disabled declarations are never imported.
 * - **Secret-free context.** The register function receives the registries
 *   only — never the parsed config, credentials or environment. An extension
 *   reads its own settings from its own module/environment surface.
 * - **Operator trust.** Enabling a module means executing it in-process;
 *   the trust boundary is write access to disclaude.config.yaml (the same
 *   boundary as any other config-driven behavior).
 *
 * Error isolation: each declaration is imported and run independently. A
 * missing module, a bad export shape or a throwing register fails that one
 * declaration (with best-effort rollback of ids it had managed to register)
 * and leaves every other declaration, the builtin entries and the core
 * service untouched.
 *
 * Reload semantics are declarative: declarations are applied at boot (before
 * config validation consumes the registries). Re-applying within a process
 * first calls {@link unregisterApplied} on the previous reports — ids an
 * extension registered are attributed by diffing section membership around
 * its register call.
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionSection } from './registry.js';

/** One `extensions.<name>` declaration from disclaude.config.yaml. */
export interface ExtensionModuleDeclaration {
  /** Module specifier: absolute or config-relative path, or a bare package specifier. */
  readonly module?: string;
  /** Explicit opt-in; extensions are disabled by default. */
  readonly enabled?: boolean;
}

/** The registry sections an extension module can register into. */
export interface ExtensionRegistries {
  readonly harness: ExtensionSection<unknown>;
  readonly channelType: ExtensionSection<unknown>;
  readonly llmVia: ExtensionSection<unknown>;
  readonly llmProtocol: ExtensionSection<unknown>;
}

/**
 * What an extension module's register function receives. Deliberately
 * secret-free (see security boundary above).
 */
export interface ExtensionModuleContext {
  /** The declaring `extensions.<name>` key, for diagnostics. */
  readonly name: string;
  readonly registries: ExtensionRegistries;
}

/** Register export contract: `register` or the default export. */
export type ExtensionModuleRegister = (context: ExtensionModuleContext) => void | Promise<void>;

/** The module shape looked up after dynamic import. */
export interface ExtensionModule {
  register?: ExtensionModuleRegister;
  default?: ExtensionModuleRegister;
}

export type ExtensionLoadStatus = 'applied' | 'disabled' | 'failed';

/** Outcome of one declaration. `registeredIds` keys are registry keys. */
export interface ExtensionLoadReport {
  readonly name: string;
  readonly module: string;
  readonly status: ExtensionLoadStatus;
  readonly registeredIds: Readonly<Record<string, string[]>>;
  readonly error?: string;
}

/** Options for {@link applyExtensionDeclarations}. */
export interface ApplyExtensionsOptions {
  /** Directory the config file lives in; relative module paths resolve against it. */
  readonly configDir: string;
  readonly registries: ExtensionRegistries;
}

/**
 * Resolve a declaration's module specifier to an import target.
 *
 * - Absolute paths and `./`-relative paths resolve against `configDir` and
 *   become file URLs.
 * - Anything else is passed to `import()` unchanged as a bare specifier,
 *   resolved against the running process (an installed package).
 */
function resolveModuleTarget(specifier: string, configDir: string): string {
  if (isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(resolve(configDir, specifier)).href;
  }
  return specifier;
}

function snapshotIds(registries: ExtensionRegistries): Map<string, Set<string>> {
  const snapshot = new Map<string, Set<string>>();
  for (const [key, section] of Object.entries(registries)) {
    snapshot.set(key, new Set(section.ids()));
  }
  return snapshot;
}

function diffAdded(
  before: Map<string, Set<string>>,
  registries: ExtensionRegistries
): Record<string, string[]> {
  const added: Record<string, string[]> = {};
  for (const [key, section] of Object.entries(registries)) {
    const beforeIds = before.get(key) ?? new Set<string>();
    const gained = section.ids().filter((id: string) => !beforeIds.has(id));
    if (gained.length) {
      added[key] = gained;
    }
  }
  return added;
}

/**
 * Apply `extensions.<name>` declarations in deterministic (sorted-name) order.
 *
 * Never throws: every failure is captured in the returned reports. Warnings
 * for failed entries belong to the caller's logging policy.
 */
export async function applyExtensionDeclarations(
  declarations: Record<string, ExtensionModuleDeclaration> | undefined,
  options: ApplyExtensionsOptions
): Promise<ExtensionLoadReport[]> {
  const reports: ExtensionLoadReport[] = [];
  const entries = Object.entries(declarations ?? {}).sort(([a], [b]) => a.localeCompare(b));

  for (const [name, declaration] of entries) {
    const module = declaration?.module;
    if (declaration?.enabled !== true) {
      reports.push({
        name,
        module: typeof module === 'string' ? module : '(unset)',
        status: 'disabled',
        registeredIds: {},
      });
      continue;
    }
    if (typeof module !== 'string' || module.length === 0) {
      reports.push({
        name,
        module: '(unset)',
        status: 'failed',
        registeredIds: {},
        error: 'extensions.<name>.module must be a non-empty string when enabled',
      });
      continue;
    }

    const before = snapshotIds(options.registries);
    try {
      const target = resolveModuleTarget(module, options.configDir);
      const imported = (await import(target)) as ExtensionModule;
      const register = imported.register ?? imported.default;
      if (typeof register !== 'function') {
        throw new Error(
          `extension module must export a register() function (or default function), got: ${typeof register}`
        );
      }
      await register({ name, registries: options.registries });
      reports.push({
        name,
        module,
        status: 'applied',
        registeredIds: diffAdded(before, options.registries),
      });
    } catch (error) {
      // Roll back ids this declaration managed to register before failing,
      // so a broken extension leaves no partial state behind.
      const added = diffAdded(before, options.registries);
      for (const [key, ids] of Object.entries(added)) {
        const section = options.registries[key as keyof ExtensionRegistries];
        for (const id of ids) {
          section.unregister(id);
        }
      }
      reports.push({
        name,
        module,
        status: 'failed',
        registeredIds: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return reports;
}

/**
 * Unregister everything applied by a previous {@link applyExtensionDeclarations}
 * batch. Returns the number of ids removed. Only ids attributed to extension
 * batches are touched — builtin entries and ids registered by other callers
 * are never removed.
 */
export function unregisterApplied(
  reports: readonly ExtensionLoadReport[],
  registries: ExtensionRegistries
): number {
  let removed = 0;
  for (const report of reports) {
    for (const [key, ids] of Object.entries(report.registeredIds)) {
      const section = registries[key as keyof ExtensionRegistries];
      if (!section) {
        continue;
      }
      for (const id of ids) {
        if (
          section.get(id) !== undefined &&
          section.unregister(id)
        ) {
          removed += 1;
        }
      }
    }
  }
  return removed;
}
