#!/usr/bin/env node
/**
 * Build-time harness backend installer for the service image (#5168).
 *
 * Declares, at `docker build` time, which agent harness backends the image
 * pre-installs. Everything installs during the build — the container never
 * installs at startup (the entrypoint only prints a diagnostic line).
 *
 * Selection: the `DISCLAUDE_BACKENDS` build arg (env var here) — `all`
 * (default) or a comma-separated subset of the canonical names below
 * (canonical spellings only — no aliases). Unknown names fail with a clear
 * error listing the valid ones.
 *
 * Stages (mirrored by the RUN lines in Dockerfile.service):
 *   app      builder stage, after `pnpm install --prod`: installs the `pi`
 *            runtime packages into <root>/node_modules (production Node module
 *            resolution) without rewriting the pnpm-managed tree or any
 *            lockfile, and writes <root>/.backends-manifest.json.
 *   globals  production stage: installs the `codex` / `dsh` CLIs globally.
 *   verify   acceptance: strict re-check of every selected backend against the
 *            manifest; non-zero exit on any failure. Run inside the container:
 *            `node /app/scripts/install-backends.mjs --verify`
 *   diagnose startup diagnostic (entrypoint): same checks, one summary line,
 *            never fails.
 *
 * Version pins live in DEFAULT_VERSIONS and are mirrored by the ARG defaults
 * in Dockerfile.service and docker-compose.yml; tests/docker-backends.test.ts
 * asserts the three stay in sync. Never pass secrets via build args — ARG
 * values persist in the image history; none are needed here.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Canonical backend order (manifest + diagnostics order).
 *
 * Resolution contract per backend, mirroring the provider code:
 * - `resolveSpecifiers` are resolved with ESM `import()` semantics (verified
 *   through a probe module anchored at the provider's built file — the real
 *   packages gate some subpaths behind "import"-only exports conditions).
 * - `cjsSpecifiers` are resolved with `createRequire().resolve()` exactly the
 *   way `PiAgentProvider.validateConfig()` probes the runtime package.
 */
export const BACKEND_SPECS = {
  claude: {
    kind: 'bundled',
    // Ships inside the pnpm-managed /app/node_modules via the version-pinned
    // workspace dependency — no build-time install, resolution is verified.
    summary: '@anthropic-ai/claude-agent-sdk pinned by pnpm-lock.yaml (packages/core)',
    anchor: 'packages/core/dist/sdk/providers/claude/provider.js',
    resolveSpecifiers: ['@anthropic-ai/claude-agent-sdk'],
    // Version probe (best-effort): read package.json beside the resolved entry,
    // the same trick as packages/core/src/sdk/providers/claude/version.ts.
    versionViaCjs: '@anthropic-ai/claude-agent-sdk',
  },
  pi: {
    kind: 'app-modules',
    versionEnv: 'PI_VERSION',
    summary: '@earendil-works runtime packages installed into node_modules for production resolution',
    // docs/pi-backend.md pins both runtime packages to the same release.
    packages: (version) => [`@earendil-works/pi-agent-core@${version}`, `@earendil-works/pi-ai@${version}`],
    linkNames: ['@earendil-works/pi-agent-core', '@earendil-works/pi-ai'],
    npmPrefixDir: 'node_modules/.pi-runtime',
    anchor: 'packages/core/dist/sdk/providers/pi/provider.js',
    // Exactly what production-runtime.ts imports (pi-ai api subpaths for both
    // protocols, agent-core bare + /node entry).
    resolveSpecifiers: [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-agent-core/node',
      '@earendil-works/pi-ai/api/anthropic-messages',
      '@earendil-works/pi-ai/api/openai-completions',
    ],
    // Exactly what provider.ts validateConfig resolves (CJS semantics).
    cjsSpecifiers: ['@earendil-works/pi-agent-core/package.json'],
    versionViaCjs: '@earendil-works/pi-agent-core/package.json',
  },
  codex: {
    kind: 'global-cli',
    versionEnv: 'CODEX_VERSION',
    summary: '@openai/codex CLI installed globally (binary on PATH)',
    packages: (version) => [`@openai/codex@${version}`],
    binaries: ['codex'],
  },
  dsh: {
    kind: 'global-cli',
    versionEnv: 'DSH_VERSION',
    summary: '@deepseek-ai/dsh CLI installed globally (binary on PATH)',
    packages: (version) => [`@deepseek-ai/dsh@${version}`],
    binaries: ['dsh'],
  },
};

export const DEFAULT_SELECTION = 'all';

/**
 * Pinned default versions. Mirrored by the ARG defaults in Dockerfile.service
 * and docker-compose.yml (drift-guarded by tests/docker-backends.test.ts).
 * Sources: Dockerfile.service (codex 0.154.0, dsh 0.1.2-rc.1) and
 * docs/pi-backend.md (pi runtime verified at 0.83.0).
 */
export const DEFAULT_VERSIONS = {
  codex: '0.154.0',
  dsh: '0.1.2-rc.1',
  pi: '0.83.0',
};

const VALID_NAMES = Object.keys(BACKEND_SPECS);

export class BackendSelectionError extends Error {}

/**
 * Parse a DISCLAUDE_BACKENDS value into canonical backend names.
 *
 * - unset/undefined → the default selection (`all`)
 * - `all` (any case) → every canonical backend
 * - comma-separated list: trimmed, case-insensitive, canonical names only
 *   (no aliases — `dsh` is the canonical spelling, matching the runtime
 *   `agentBackend` union), duplicates collapse; `all` may be mixed with names
 * - empty/whitespace-only string, or an unknown name → BackendSelectionError
 *   with a message that names the offender and the valid values
 *
 * @param {string | undefined} raw - raw DISCLAUDE_BACKENDS value
 * @returns {string[]} canonical backend names in BACKEND_SPECS order
 */
export function parseBackendSelection(raw) {
  if (raw === undefined) {
    raw = DEFAULT_SELECTION;
  }
  if (typeof raw !== 'string' || !/[^,\s]/.test(raw)) {
    throw new BackendSelectionError(
      `DISCLAUDE_BACKENDS is set to an empty value — use 'all' or a comma-separated subset of: ${VALID_NAMES.join(', ')}`
    );
  }
  const selected = new Set();
  for (const token of raw.split(',')) {
    const trimmed = token.trim().toLowerCase();
    if (trimmed === '') {
      continue;
    }
    if (trimmed === 'all') {
      for (const name of VALID_NAMES) {
        selected.add(name);
      }
      continue;
    }
    if (!BACKEND_SPECS[trimmed]) {
      throw new BackendSelectionError(
        `Unknown DISCLAUDE_BACKENDS entry '${trimmed}'. ` +
          `Valid: ${VALID_NAMES.join(', ')}, or 'all'.`
      );
    }
    selected.add(trimmed);
  }
  if (selected.size === 0) {
    throw new BackendSelectionError(
      `DISCLAUDE_BACKENDS '${raw}' contains no backend names — use 'all' or a comma-separated subset of: ${VALID_NAMES.join(', ')}`
    );
  }
  return VALID_NAMES.filter((name) => selected.has(name));
}

/**
 * Resolve effective versions: explicit override > env (Dockerfile ARG) >
 * DEFAULT_VERSIONS. @returns {Record<string, string>} version per backend
 */
export function resolveVersions(env, overrides = {}) {
  const versions = {};
  for (const [name, spec] of Object.entries(BACKEND_SPECS)) {
    if (!spec.versionEnv) {
      continue;
    }
    const version = overrides[name] ?? env[spec.versionEnv] ?? DEFAULT_VERSIONS[name];
    if (typeof version !== 'string' || version.trim() === '') {
      throw new BackendSelectionError(
        `${spec.versionEnv} must be a non-empty version string for backend '${name}'`
      );
    }
    versions[name] = version.trim();
  }
  return versions;
}

/**
 * @typedef {Object} PlanEntry
 * @property {'npm'|'npm-global'|'mkdir'|'symlink'|'resolve'|'command-v'|'manifest'} kind
 */

/** Shell-ish one-line rendering of a plan entry (dry-run output). */
function renderEntry(entry) {
  switch (entry.kind) {
    case 'npm':
    case 'npm-global':
      return `npm ${entry.args.join(' ')}`;
    case 'mkdir':
      return `mkdir -p ${entry.path}`;
    case 'symlink':
      return `ln -sfn ${entry.target} ${entry.path}`;
    case 'resolve':
      return `node <probe at ${dirname(entry.anchor)}/> # import.meta.resolve: ${entry.esm.join(', ')}${entry.cjs.length ? `; require.resolve: ${entry.cjs.join(', ')}` : ''}`;
    case 'command-v':
      return `command -v ${entry.binary}`;
    case 'manifest':
      return `write ${entry.path}`;
    default:
      return JSON.stringify(entry);
  }
}

const REGISTRY_PLACEHOLDER = '${NPM_REGISTRY}';

/** Common npm flags: quiet, no lockfile writes, registry pinned for reproducible installs. */
function npmInstallArgs(packages, { global = false, prefix } = {}) {
  return [
    'install',
    ...(global ? ['-g'] : []),
    ...(prefix ? [`--prefix=${prefix}`] : []),
    ...(global ? [] : ['--no-save', '--no-package-lock']),
    '--no-audit',
    '--no-fund',
    '--registry',
    REGISTRY_PLACEHOLDER,
    ...packages,
  ];
}

/** Substitute the registry placeholder once the concrete registry is known. */
function withRegistry(args, registry) {
  return args.map((arg) => (arg === REGISTRY_PLACEHOLDER ? registry : arg));
}

/**
 * Plan the `app` stage: pi runtime install + links + resolution checks +
 * manifest write. Pure — unit-testable without touching the filesystem.
 * @param {{selection: string[], versions: Record<string,string>, root: string}} input
 * @returns {PlanEntry[]}
 */
export function planAppStage({ selection, versions, root }) {
  const plan = [];
  if (selection.includes('pi')) {
    const prefix = join(root, BACKEND_SPECS.pi.npmPrefixDir);
    plan.push({ kind: 'mkdir', path: join(root, 'node_modules') });
    plan.push({
      kind: 'npm',
      args: npmInstallArgs(BACKEND_SPECS.pi.packages(versions.pi), { prefix }),
    });
    plan.push({ kind: 'mkdir', path: join(root, 'node_modules/@earendil-works') });
    for (const name of BACKEND_SPECS.pi.linkNames) {
      plan.push({
        kind: 'symlink',
        target: `../.pi-runtime/node_modules/${name}`,
        path: join(root, 'node_modules', name),
      });
    }
  }
  // Resolution checks run for every selected backend whose artifacts live in
  // the app tree: claude (bundled sdk) and pi (linked above). codex/dsh are
  // checked in the globals stage of the production image.
  for (const name of selection) {
    const spec = BACKEND_SPECS[name];
    if (spec.kind === 'global-cli') {
      continue;
    }
    plan.push({
      kind: 'resolve',
      anchor: spec.anchor,
      esm: spec.resolveSpecifiers ?? [],
      cjs: spec.cjsSpecifiers ?? [],
    });
  }
  plan.push({ kind: 'manifest', path: join(root, '.backends-manifest.json') });
  return plan;
}

/**
 * Plan the `globals` stage: global CLI installs + PATH checks.
 * @param {{selection: string[], versions: Record<string,string>}} input
 * @returns {PlanEntry[]}
 */
export function planGlobalsStage({ selection, versions }) {
  const plan = [];
  for (const name of selection) {
    const spec = BACKEND_SPECS[name];
    if (spec.kind !== 'global-cli') {
      continue;
    }
    plan.push({ kind: 'npm-global', args: npmInstallArgs(spec.packages(versions[name]), { global: true }) });
    for (const binary of spec.binaries) {
      plan.push({ kind: 'command-v', binary });
    }
  }
  return plan;
}

/** Build the manifest object for the resolved selection. */
export function buildManifest({ selection, versions }) {
  const backends = {};
  for (const [name, spec] of Object.entries(BACKEND_SPECS)) {
    const selected = selection.includes(name);
    const entry = { kind: spec.kind, selected };
    if (selected) {
      if (spec.kind === 'app-modules') {
        entry.version = versions[name];
        entry.packages = spec.packages(versions[name]);
        entry.location = `${BACKEND_SPECS.pi.npmPrefixDir} (npm root) + node_modules/@earendil-works links`;
      } else if (spec.kind === 'global-cli') {
        entry.version = versions[name];
        entry.packages = spec.packages(versions[name]);
        entry.binaries = spec.binaries;
      } else {
        entry.source = spec.summary;
      }
    }
    backends[name] = entry;
  }
  return {
    schema: 1,
    generatedBy: 'docker/install-backends.mjs',
    issue: 5168,
    selection: selection.join(','),
    backends,
  };
}

// ---------------------------------------------------------------------------
// Runtime checks (shared by app-stage verification, --verify and --diagnose)
// ---------------------------------------------------------------------------

/**
 * Resolve specifiers with ESM `import()` semantics by dropping a one-shot
 * probe module next to the provider's built file and letting
 * `import.meta.resolve` anchor exactly there (bare-subpath resolution from
 * the anchor directory walks up through <root>/node_modules like the real
 * dynamic import). import.meta.resolve is unflagged on Node >= 20.6; the
 * image's Node floor is enforced by NODE_MIN_VERSION (#5481).
 * @returns {string[]} the resolved specifiers
 */
function esmResolveViaProbe(root, anchor, specifiers) {
  if (specifiers.length === 0) {
    return [];
  }
  const anchorDir = dirname(join(root, anchor));
  const probePath = join(anchorDir, `.backend-resolve-probe-${process.pid}.mjs`);
  const source =
    'const specs = JSON.parse(process.env.BACKEND_PROBE_SPECS || "[]");\n' +
    'for (const spec of specs) {\n' +
    '  try { process.stdout.write("OK\\t" + spec + "\\t" + import.meta.resolve(spec) + "\\n"); }\n' +
    '  catch (error) {\n' +
    '    const message = error && error.message ? error.message : String(error);\n' +
    '    process.stdout.write("ERR\\t" + spec + "\\t" + message + "\\n");\n' +
    '    process.exitCode = 1;\n' +
    '  }\n' +
    '}\n';
  mkdirSync(anchorDir, { recursive: true });
  writeFileSync(probePath, source);
  try {
    const result = spawnSync(process.execPath, [probePath], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, BACKEND_PROBE_SPECS: JSON.stringify(specifiers) },
    });
    if (result.error || result.status !== 0) {
      const reason = result.error ? String(result.error) : result.stderr.trim() || `exit ${result.status}`;
      throw new Error(`resolution probe failed: ${reason}`);
    }
    const failures = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('ERR\t'))
      .map((line) => line.slice(4));
    if (failures.length > 0) {
      throw new Error(`cannot resolve (ESM import semantics): ${failures.join('; ')}`);
    }
    return result.stdout
      .split('\n')
      .filter((line) => line.startsWith('OK\t'))
      .map((line) => line.split('\t')[1]);
  } finally {
    rmSync(probePath, { force: true });
  }
}

/** Read the manifest beside a resolved package entry file (exports maps hide it). */
function readPackageJsonVersion(resolvedEntry) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(resolvedEntry), 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify one backend's in-app resolution contract (bundled + app-modules).
 * @returns {{ ok: boolean, detail: string }}
 */
function checkAppResolution(root, spec) {
  const parts = [];
  try {
    for (const specifier of spec.cjsSpecifiers ?? []) {
      const require = createRequire(join(root, spec.anchor));
      const resolved = require.resolve(specifier);
      parts.push(specifier);
      if (specifier === spec.versionViaCjs) {
        const version = readPackageJsonVersion(resolved);
        if (version) {
          parts[parts.length - 1] = `${specifier} (${version})`;
        }
      }
    }
    for (const specifier of esmResolveViaProbe(root, spec.anchor, spec.resolveSpecifiers ?? [])) {
      parts.push(specifier);
    }
    if (spec.versionViaCjs && !(spec.cjsSpecifiers ?? []).includes(spec.versionViaCjs)) {
      // Best-effort version annotation for CJS-resolvable packages (claude).
      try {
        const require = createRequire(join(root, spec.anchor));
        const version = readPackageJsonVersion(require.resolve(spec.versionViaCjs));
        if (version) {
          parts[parts.length - 1] = `${parts[parts.length - 1]} (sdk ${version})`;
        }
      } catch {
        // The ESM contract above already passed; version annotation is optional.
      }
    }
    return { ok: true, detail: parts.join(', ') };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Locate a binary on PATH without spawning a shell. */
function findOnPath(binary, env) {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir === '') {
      continue;
    }
    const candidate = join(dir, binary);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Check one backend's install evidence inside `root`.
 * @returns {{ ok: boolean, detail: string }}
 */
export function checkBackend(name, root, env = process.env) {
  const spec = BACKEND_SPECS[name];
  if (!spec) {
    return { ok: false, detail: 'unknown backend' };
  }
  if (spec.kind === 'global-cli') {
    const found = spec.binaries.map((binary) => {
      const path = findOnPath(binary, env);
      return path ? `${binary} at ${path}` : `${binary} NOT on PATH`;
    });
    const ok = found.every((line) => !line.includes('NOT on PATH'));
    return { ok, detail: found.join('; ') };
  }
  return checkAppResolution(root, spec);
}

/**
 * Read and validate the image manifest.
 * @returns {{ selection: string[], manifest: object }}
 */
export function readManifest(root) {
  const path = join(root, '.backends-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `cannot read backend manifest ${path} (${error instanceof Error ? error.message : String(error)}) — ` +
        'was the image built with docker/install-backends.mjs (#5168)?'
    );
  }
  if (manifest?.schema !== 1 || typeof manifest.selection !== 'string') {
    throw new Error(`backend manifest ${path} has an unsupported shape (schema=${manifest?.schema})`);
  }
  return { selection: parseBackendSelection(manifest.selection), manifest };
}

// ---------------------------------------------------------------------------
// Plan execution
// ---------------------------------------------------------------------------

function log(message) {
  process.stdout.write(`[backends] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[backends] ERROR: ${message}\n`);
  process.exit(1);
}

/** @param {PlanEntry[]} plan */
function executePlan(plan, { dryRun, registry, selection, versions, root }) {
  for (const entry of plan) {
    if (dryRun) {
      const printed = 'args' in entry ? { ...entry, args: withRegistry(entry.args, registry) } : entry;
      process.stdout.write(`[dry-run] ${renderEntry(printed)}\n`);
      continue;
    }
    switch (entry.kind) {
      case 'npm':
      case 'npm-global': {
        const args = withRegistry(entry.args, registry);
        log(`npm ${args.join(' ')}`);
        const result = spawnSync('npm', args, { stdio: 'inherit' });
        if (result.status !== 0) {
          fail(`npm ${args.join(' ')} failed with exit ${result.status ?? 'signal'}`);
        }
        break;
      }
      case 'mkdir':
        mkdirSync(entry.path, { recursive: true });
        break;
      case 'symlink':
        try {
          lstatSync(entry.path);
          rmSync(entry.path);
        } catch {
          // absent — nothing to replace
        }
        symlinkSync(entry.target, entry.path);
        log(`linked ${entry.path} -> ${entry.target}`);
        break;
      case 'resolve': {
        const spec = {
          anchor: entry.anchor,
          resolveSpecifiers: entry.esm,
          cjsSpecifiers: entry.cjs,
        };
        const { ok, detail } = checkAppResolution(root, spec);
        if (!ok) {
          fail(`resolution check failed from ${entry.anchor}: ${detail}`);
        }
        log(`verified resolution from ${entry.anchor}: ${detail}`);
        break;
      }
      case 'command-v': {
        const path = findOnPath(entry.binary, process.env);
        if (!path) {
          fail(`backend binary '${entry.binary}' is not on PATH after install`);
        }
        log(`verified on PATH: ${entry.binary} (${path})`);
        break;
      }
      case 'manifest': {
        const manifest = buildManifest({ selection, versions });
        const tmp = `${entry.path}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
        renameSync(tmp, entry.path);
        log(`manifest written: ${entry.path} (selection: ${selection.join(', ')})`);
        break;
      }
      default:
        fail(`unhandled plan entry: ${JSON.stringify(entry)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function runInstallStage(stage, options) {
  const selection = parseBackendSelection(options.backends);
  const versions = resolveVersions(process.env, options.versionOverrides);
  const plan =
    stage === 'app'
      ? planAppStage({ selection, versions, root: options.root })
      : planGlobalsStage({ selection, versions });
  log(`stage=${stage} selection=${selection.join(',')} root=${options.root} registry=${options.registry}`);
  for (const name of selection) {
    const spec = BACKEND_SPECS[name];
    const versionText = versions[name] ? ` @ ${versions[name]}` : '';
    log(`backend ${name}${versionText}: ${spec.summary}`);
  }
  executePlan(plan, {
    dryRun: options.dryRun,
    registry: options.registry,
    selection,
    versions,
    root: options.root,
  });
}

function runVerify(options) {
  let selection;
  try {
    ({ selection } = readManifest(options.root));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let failed = 0;
  for (const name of VALID_NAMES) {
    if (!selection.includes(name)) {
      log(`${name}: not selected (skip)`);
      continue;
    }
    const { ok, detail } = checkBackend(name, options.root);
    if (ok) {
      log(`${name}: PASS (${detail})`);
    } else {
      failed += 1;
      process.stderr.write(`[backends] ${name}: FAIL (${detail})\n`);
    }
  }
  if (failed > 0) {
    fail(`${failed} selected backend(s) failed verification`);
  }
  log(`verify: all selected backends present (${selection.join(', ')})`);
}

function runDiagnose(options) {
  let selection = [];
  try {
    ({ selection } = readManifest(options.root));
  } catch (error) {
    process.stdout.write(
      `[backends] manifest unavailable (${error instanceof Error ? error.message : String(error)})\n`
    );
  }
  const parts = VALID_NAMES.map((name) => {
    if (!selection.includes(name)) {
      return `${name}=not-selected`;
    }
    const { ok, detail } = checkBackend(name, options.root);
    if (!ok) {
      return `${name}=MISSING`;
    }
    const versionMatch = /\((?:sdk )?([^()]+)\)/.exec(detail);
    return versionMatch ? `${name}=ok(${versionMatch[1]})` : `${name}=ok`;
  });
  process.stdout.write(`[backends] ${parts.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const options = {
    stage: undefined,
    // Default selection comes from the DISCLAUDE_BACKENDS build arg (ARG
    // values are exported as env vars during RUN); --backends overrides it.
    backends: process.env.DISCLAUDE_BACKENDS,
    root: '/app',
    registry: process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org',
    dryRun: false,
    versionOverrides: {},
  };
  const versionFlags = { '--pi-version': 'pi', '--codex-version': 'codex', '--dsh-version': 'dsh' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
    const takeValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        throw new BackendSelectionError(`missing value for ${flag}`);
      }
      index += 1;
      return next;
    };
    if (flag === '--stage') {
      options.stage = takeValue();
    } else if (flag === '--verify' || flag === '--diagnose') {
      // Shortcuts for the read-only stages.
      if (inlineValue !== undefined) {
        throw new BackendSelectionError(`${flag} takes no value`);
      }
      options.stage = flag.slice(2);
    } else if (flag === '--backends' || flag === '--selection') {
      options.backends = takeValue();
    } else if (flag === '--root') {
      options.root = takeValue();
    } else if (flag === '--registry') {
      options.registry = takeValue();
    } else if (flag === '--dry-run') {
      if (inlineValue !== undefined) {
        throw new BackendSelectionError('--dry-run takes no value');
      }
      options.dryRun = true;
    } else if (versionFlags[flag]) {
      options.versionOverrides[versionFlags[flag]] = takeValue();
    } else {
      throw new BackendSelectionError(
        `unknown option '${arg}' (usage: --stage app|globals|verify|diagnose [--backends S] [--root DIR] ` +
          '[--registry URL] [--pi-version V] [--codex-version V] [--dsh-version V] [--dry-run]; ' +
          'selection defaults to the DISCLAUDE_BACKENDS env var)'
      );
    }
  }
  const stages = ['app', 'globals', 'verify', 'diagnose'];
  if (!stages.includes(options.stage)) {
    throw new BackendSelectionError(
      `--stage is required and must be one of: ${stages.join(', ')} (got ${JSON.stringify(options.stage)})`
    );
  }
  if (!isAbsolute(options.root)) {
    throw new BackendSelectionError(`--root must be an absolute path (got ${JSON.stringify(options.root)})`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (options.stage === 'app' || options.stage === 'globals') {
    try {
      runInstallStage(options.stage, options);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (options.stage === 'verify') {
    runVerify(options);
    return;
  }
  runDiagnose(options);
}

const invokedAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main(process.argv.slice(2));
}
