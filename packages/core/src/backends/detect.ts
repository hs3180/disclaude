/**
 * Discovery probes for `disclaude backend` (Issue #5169).
 *
 * Each probe answers exactly the question the service runtime asks at query
 * time, so doctor/list results cannot drift from how backends really resolve:
 * PATH lookup for spawned CLI binaries, Node module resolution for the pi
 * runtime packages, and the bundled agent-SDK manifest for the Claude Code CLI
 * the service actually spawns. All probes are offline and read no secrets.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_AGENT_SDK_PACKAGE } from './registry.js';
import type { ProcessRunner } from './types.js';

/**
 * The @disclaude/core package directory. This file sits at
 * `packages/core/src/backends/` in source and `packages/core/dist/backends/`
 * in installs, so two levels up is the package root in both layouts — the
 * same module-resolution chain the pi provider resolves through.
 */
export function corePackageDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  return resolve(from, '../..');
}

/** Locate an executable on PATH the way the service's spawn() would. */
export function findOnPath(binary: string, env: { PATH?: string }): string | undefined {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : [''];
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, binary + suffix);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* Keep scanning PATH. */
      }
    }
  }
  return undefined;
}

/** Parse `npm ls -g --depth=0 --json` stdout into package → version. */
export function parseNpmLs(stdout: string): Record<string, string> {
  const start = stdout.indexOf('{');
  if (start < 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(stdout.slice(start)) as {
      dependencies?: Record<string, { version?: unknown }>;
    };
    const versions: Record<string, string> = {};
    for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
      if (typeof info?.version === 'string') {
        versions[name] = info.version;
      }
    }
    return versions;
  } catch {
    return {};
  }
}

/** Installed versions in the npm global prefix (offline `npm ls -g`). */
export async function npmGlobalPackages(runner: ProcessRunner): Promise<Record<string, string>> {
  try {
    const result = await runner.run('npm', ['ls', '-g', '--depth=0', '--json'], {
      timeoutMs: 30_000,
    });
    return parseNpmLs(result.stdout);
  } catch {
    return {};
  }
}

/** The active npm global prefix, when npm can report it. */
export async function npmGlobalPrefix(runner: ProcessRunner): Promise<string | undefined> {
  try {
    const result = await runner.run('npm', ['prefix', '-g'], { timeoutMs: 15_000 });
    const prefix = result.stdout.trim().split('\n').pop() ?? '';
    return prefix || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedModule {
  resolved: boolean;
  /** Installed version read from the package manifest. */
  version?: string;
  /** Manifest path proving discoverability. */
  path?: string;
}

interface ManifestFields {
  name?: string;
  version?: string;
  claudeCodeVersion?: string;
}

/**
 * Find a package manifest by walking the `node_modules` chain up from a base
 * directory — the ESM resolution chain the pi provider's dynamic import() uses
 * (deliberately without createRequire: that honors NODE_PATH and, under test
 * runners, the runner's own resolver, neither of which the service inherits).
 */
export function findPackageManifest(
  baseDir: string,
  name: string
): (ManifestFields & { path: string }) | undefined {
  const relativeManifest = join('node_modules', ...name.split('/'), 'package.json');
  let directory = resolve(baseDir);
  for (;;) {
    const manifest = join(directory, relativeManifest);
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as ManifestFields;
        if (parsed.name === name) {
          return { ...parsed, path: manifest };
        }
      } catch {
        /* Unreadable manifest: keep walking up. */
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

/**
 * Resolve package names from a base directory through the production node_modules
 * chain — the same walk `loadPiProduction`'s dynamic imports resolve through.
 * Resolving from the core package directory mirrors the provider in both source
 * checkouts and production installs.
 */
export function resolveNodeModules(
  baseDir: string,
  names: readonly string[]
): Record<string, ResolvedModule> {
  const found: Record<string, ResolvedModule> = {};
  for (const name of names) {
    const manifest = findPackageManifest(baseDir, name);
    found[name] = manifest
      ? { resolved: true, path: manifest.path, version: manifest.version }
      : { resolved: false };
  }
  return found;
}

export interface BundledClaudeRuntime {
  resolvable: boolean;
  sdkVersion?: string;
  /** Claude Code version bundled in the SDK — what the service spawns. */
  claudeCodeVersion?: string;
  path?: string;
}

/** Probe the pinned agent SDK and the Claude Code CLI version it bundles. */
export function bundledClaudeRuntime(baseDir: string): BundledClaudeRuntime {
  const manifest = findPackageManifest(baseDir, CLAUDE_AGENT_SDK_PACKAGE);
  if (!manifest) {
    return { resolvable: false };
  }
  return {
    resolvable: true,
    path: manifest.path,
    sdkVersion: manifest.version,
    claudeCodeVersion: manifest.claudeCodeVersion,
  };
}
