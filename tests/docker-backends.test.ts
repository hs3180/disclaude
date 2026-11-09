/**
 * #5168 — build-time harness backend preinstall (docker/install-backends.mjs).
 *
 * Covers, without network or Docker:
 * - DISCLAUDE_BACKENDS parsing: 'all' default, subsets, aliases, dedupe,
 *   and the clear build error for unknown/empty values
 * - version resolution (override > env > pinned default)
 * - install plans: exact npm argv for the pi runtime (no lockfile writes, no
 *   pnpm-tree rewrites) and the global CLIs
 * - CLI dry-run + the unknown-backend failure path
 * - --verify / --diagnose against a fake /app layout built by applying the
 *   plan's symlink geometry
 * - drift guards keeping Dockerfile.service, docker-compose.yml and the
 *   script's pinned defaults in sync, plus the Dockerfile wiring itself
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_SPECS,
  BackendSelectionError,
  DEFAULT_SELECTION,
  DEFAULT_VERSIONS,
  buildManifest,
  parseBackendSelection,
  planAppStage,
  planGlobalsStage,
  resolveVersions,
} from '../docker/install-backends.mjs';

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = join(repoRoot, 'docker', 'install-backends.mjs');
const ALL = ['claude', 'pi', 'codex', 'dsh'];

async function runScript(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await exec('node', [script, ...args], {
      cwd: repoRoot,
      timeout: 20_000,
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('parseBackendSelection (#5168)', () => {
  it('defaults to every backend when unset', () => {
    expect(parseBackendSelection(undefined)).toEqual(ALL);
  });

  it.each([
    ['all', ALL],
    ['ALL', ALL],
    ['claude,pi,codex,dsh', ALL],
    [' codex , dsh ', ['codex', 'dsh']],
    ['Codex', ['codex']],
    ['codex,codex', ['codex']],
    ['all,pi', ALL],
    ['pi,,', ['pi']],
  ])('parses %j', (raw, expected) => {
    expect(parseBackendSelection(raw)).toEqual(expected);
  });

  it('rejects an unknown backend with a message naming it and the valid set', () => {
    expect(() => parseBackendSelection('claude,bogus')).toThrow(BackendSelectionError);
    try {
      parseBackendSelection('claude,bogus');
      expect.unreachable('must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("'bogus'");
      expect(message).toContain('claude, pi, codex, dsh');
      expect(message).toContain('DISCLAUDE_BACKENDS');
      expect(message).not.toContain('alias');
    }
  });

  it('rejects the removed deepseek alias instead of silently mapping it to dsh', () => {
    expect(() => parseBackendSelection('deepseek')).toThrow(BackendSelectionError);
    try {
      parseBackendSelection('claude,deepseek');
      expect.unreachable('must throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("'deepseek'");
      expect(message).toContain('claude, pi, codex, dsh');
      expect(message).not.toContain('alias');
    }
  });

  it.each(['', '   ', ' , '])('rejects empty selection %j', (raw) => {
    expect(() => parseBackendSelection(raw)).toThrow(/DISCLAUDE_BACKENDS is set to an empty value/);
  });
});

describe('resolveVersions (#5168)', () => {
  it('falls back to the pinned defaults', () => {
    expect(resolveVersions({})).toEqual(DEFAULT_VERSIONS);
  });

  it('prefers env (Dockerfile ARG) over defaults and explicit flags over env', () => {
    expect(resolveVersions({ CODEX_VERSION: '9.9.9' })).toMatchObject({ codex: '9.9.9', dsh: DEFAULT_VERSIONS.dsh });
    expect(resolveVersions({ CODEX_VERSION: '9.9.9' }, { codex: '1.0.0' })).toMatchObject({ codex: '1.0.0' });
  });

  it('rejects empty version env values with the ARG name', () => {
    expect(() => resolveVersions({ PI_VERSION: ' ' })).toThrow(/PI_VERSION must be a non-empty version string/);
  });
});

describe('install plans (#5168)', () => {
  it('plans the pi runtime without touching manifests or the pnpm tree', () => {
    const plan = planAppStage({ selection: ALL, versions: DEFAULT_VERSIONS, root: '/app' });
    const npm = plan.filter((entry) => entry.kind === 'npm');
    expect(npm).toHaveLength(1);
    const args = (npm[0] as { args: string[] }).args;
    expect(args).toContain('--no-save');
    expect(args).toContain('--no-package-lock');
    expect(args.join(' ')).toContain('--prefix=/app/node_modules/.pi-runtime');
    expect(args).toContain('@earendil-works/pi-agent-core@0.83.0');
    expect(args).toContain('@earendil-works/pi-ai@0.83.0');
    expect(args.join(' ')).not.toMatch(/package(-lock)?\.json@/);

    const links = plan.filter((entry) => entry.kind === 'symlink');
    expect(links).toHaveLength(2);
    for (const link of links as { target: string; path: string }[]) {
      expect(link.target).toMatch(/^..\/.pi-runtime\/node_modules\/@earendil-works\//);
      expect(link.path.startsWith('/app/node_modules/')).toBe(true);
    }

    const resolves = plan.filter((entry) => entry.kind === 'resolve') as {
      anchor: string;
      esm: string[];
      cjs: string[];
    }[];
    expect(resolves).toHaveLength(2);
    const claudeCheck = resolves.find((entry) => entry.anchor.includes('/claude/'));
    const piCheck = resolves.find((entry) => entry.anchor.includes('/pi/'));
    expect(claudeCheck?.esm).toEqual(['@anthropic-ai/claude-agent-sdk']);
    expect(piCheck?.cjs).toEqual(['@earendil-works/pi-agent-core/package.json']);
    for (const specifier of [
      '@earendil-works/pi-agent-core',
      '@earendil-works/pi-agent-core/node',
      '@earendil-works/pi-ai/api/anthropic-messages',
      '@earendil-works/pi-ai/api/openai-completions',
    ]) {
      expect(piCheck?.esm).toContain(specifier);
    }
    expect((plan.at(-1) as { kind: string }).kind).toBe('manifest');
  });

  it('plans no npm work when pi is not selected, but still verifies claude and writes the manifest', () => {
    const plan = planAppStage({ selection: ['claude'], versions: DEFAULT_VERSIONS, root: '/app' });
    expect(plan.filter((entry) => entry.kind === 'npm')).toHaveLength(0);
    expect(plan.filter((entry) => entry.kind === 'resolve')).toHaveLength(1);
    expect((plan.at(-1) as { kind: string }).kind).toBe('manifest');
  });

  it('plans global CLI installs with PATH checks for codex and dsh only', () => {
    const plan = planGlobalsStage({ selection: ALL, versions: DEFAULT_VERSIONS });
    const globals = plan.filter((entry) => entry.kind === 'npm-global') as { args: string[] }[];
    expect(globals.map((entry) => entry.args.at(-1))).toEqual([
      '@openai/codex@0.154.0',
      '@deepseek-ai/dsh@0.1.2-rc.1',
    ]);
    for (const entry of globals) {
      expect(entry.args).toContain('-g');
      expect(entry.args.join(' ')).toContain('--registry');
    }
    expect(plan.filter((entry) => entry.kind === 'command-v').map((entry) => (entry as { binary: string }).binary))
      .toEqual(['codex', 'dsh']);
  });

  it('plans nothing for the globals stage when only non-CLI backends are selected', () => {
    expect(planGlobalsStage({ selection: ['claude', 'pi'], versions: DEFAULT_VERSIONS })).toHaveLength(0);
  });
});

describe('install-backends CLI (#5168)', () => {
  it('dry-runs the globals stage with pinned specs and no side effects', async () => {
    const { code, stdout } = await runScript(['--stage', 'globals', '--dry-run', '--backends', 'codex']);
    expect(code).toBe(0);
    expect(stdout).toContain('npm install -g');
    expect(stdout).toContain('@openai/codex@0.154.0');
    expect(stdout).toContain('--registry https://registry.npmjs.org');
  });

  it('dry-runs the app stage for pi with the isolated npm root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backends-dry-'));
    try {
      const { code, stdout } = await runScript(['--stage', 'app', '--dry-run', '--backends', 'pi', '--root', root]);
      expect(code).toBe(0);
      expect(stdout).toContain(`--prefix=${join(root, 'node_modules/.pi-runtime')}`);
      expect(stdout).toContain('--no-save');
      expect(stdout).toContain('--no-package-lock');
      expect(stdout).toContain('@earendil-works/pi-agent-core@0.83.0');
      // dry-run must not touch the filesystem
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails with a clear error for an unknown backend', async () => {
    const { code, stdout, stderr } = await runScript(['--stage', 'globals', '--backends', 'nope']);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Unknown DISCLAUDE_BACKENDS entry 'nope'");
    expect(stderr).toContain('claude, pi, codex, dsh');
    expect(stdout).toBe('');
  });

  it('fails with a clear error for the removed deepseek alias', async () => {
    const { code, stdout, stderr } = await runScript(['--stage', 'globals', '--backends', 'deepseek']);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Unknown DISCLAUDE_BACKENDS entry 'deepseek'");
    expect(stderr).toContain('claude, pi, codex, dsh');
    expect(stderr).not.toContain('alias');
    expect(stdout).toBe('');
  });

  it('honors DISCLAUDE_BACKENDS and version env vars', async () => {
    const dry = await runScript(['--stage', 'globals', '--dry-run'], { DISCLAUDE_BACKENDS: 'dsh', DSH_VERSION: '1.2.3' });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('@deepseek-ai/dsh@1.2.3');
    expect(dry.stdout).not.toContain('@openai/codex@');
    expect(dry.stdout).toContain("selection=dsh");
  });

  it('requires a known stage', async () => {
    const { code, stderr } = await runScript(['--stage', 'wat']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('--stage is required');
  });

  it('executes the globals stage end to end with a stub npm (argv + PATH checks)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backends-globals-'));
    try {
      const fakeNpm = join(root, 'fake-npm');
      const globalBin = join(root, 'global-bin');
      const nodeBin = join(root, 'node-bin');
      for (const dir of [fakeNpm, globalBin, nodeBin]) {
        await mkdir(dir);
      }
      // Stub npm: record argv; a "-g" install "provides" the package's bin.
      await writeFile(
        join(fakeNpm, 'npm'),
        [
          '#!/bin/sh',
          'echo "STUB-NPM $*" >> "$NPM_LOG"',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    @openai/codex@*) printf "#!/bin/sh\\nexit 0\\n" > "$STUB_GLOBAL_BIN/codex"; chmod +x "$STUB_GLOBAL_BIN/codex" ;;',
          '    @deepseek-ai/dsh@*) printf "#!/bin/sh\\nexit 0\\n" > "$STUB_GLOBAL_BIN/dsh"; chmod +x "$STUB_GLOBAL_BIN/dsh" ;;',
          '  esac',
          'done',
          'exit 0',
          '',
        ].join('\n')
      );
      await chmod(join(fakeNpm, 'npm'), 0o755);
      await symlink(process.execPath, join(nodeBin, 'node'));

      const { code, stdout } = await runScript(['--stage', 'globals', '--backends', 'codex,dsh'], {
        PATH: [globalBin, fakeNpm, nodeBin].join(':'),
        NPM_LOG: join(root, 'npm.log'),
        STUB_GLOBAL_BIN: globalBin,
      });
      expect(code).toBe(0);
      expect(stdout).toContain('npm install -g');
      expect(stdout).toContain('verified on PATH: codex');
      expect(stdout).toContain('verified on PATH: dsh');
      const npmLog = await readFile(join(root, 'npm.log'), 'utf8');
      expect(npmLog).toContain('@openai/codex@0.154.0');
      expect(npmLog).toContain('@deepseek-ai/dsh@0.1.2-rc.1');
      expect(npmLog).toContain('--registry https://registry.npmjs.org');
      expect(await readFile(join(globalBin, 'codex'), 'utf8')).toContain('exit 0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('--verify / --diagnose against a fake app root (#5168)', () => {
  async function buildFakeRoot() {
    const root = await mkdtemp(join(tmpdir(), 'backends-root-'));
    const modules = join(root, 'node_modules');

    // Bundled claude backend: the version-pinned agent SDK (stub of the real shape).
    const sdkDir = join(modules, '@anthropic-ai/claude-agent-sdk');
    await mkdir(sdkDir, { recursive: true });
    await writeFile(
      join(sdkDir, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'index.js' })
    );
    await writeFile(join(sdkDir, 'index.js'), 'module.exports = {};\n');

    // pi runtime packages exactly where the app stage's npm --prefix install
    // drops them, then apply the plan's symlink geometry to prove the relative
    // targets are correct.
    const piRoot = join(modules, '.pi-runtime/node_modules/@earendil-works');
    const piCore = join(piRoot, 'pi-agent-core');
    const piAi = join(piRoot, 'pi-ai');
    const piCoreManifest = {
      name: '@earendil-works/pi-agent-core',
      version: DEFAULT_VERSIONS.pi,
      exports: {
        '.': './index.js',
        './package.json': './package.json',
        './node': './node.js',
      },
    };
    const piAiManifest = {
      name: '@earendil-works/pi-ai',
      version: DEFAULT_VERSIONS.pi,
      exports: {
        '.': './index.js',
        './api/anthropic-messages': './api/anthropic-messages.js',
        './api/openai-completions': './api/openai-completions.js',
      },
    };
    for (const [dir, manifest, files] of [
      [piCore, piCoreManifest, ['index.js', 'node.js']],
      [piAi, piAiManifest, ['index.js', 'api/anthropic-messages.js', 'api/openai-completions.js']],
    ] as const) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
      for (const file of files) {
        await mkdir(join(dir, file, '..'), { recursive: true });
        await writeFile(join(dir, file), 'export default {};\n');
      }
    }
    const plan = planAppStage({ selection: ALL, versions: DEFAULT_VERSIONS, root });
    for (const entry of plan) {
      if (entry.kind === 'symlink') {
        const link = entry as { target: string; path: string };
        // mkdirSync plan entries are applied implicitly by recursive mkdir here.
        await mkdir(join(root, 'node_modules/@earendil-works'), { recursive: true });
        await symlink(link.target, link.path);
      }
    }

    // Backend manifest as the app stage writes it.
    await writeFile(
      join(root, '.backends-manifest.json'),
      `${JSON.stringify(buildManifest({ selection: ALL, versions: DEFAULT_VERSIONS }), null, 2)}\n`
    );

    // Global CLI stubs on PATH, plus a PATH entry that can start node but
    // holds no backend binaries (for the missing-CLI case).
    const bin = join(root, 'bin');
    const nodeOnlyBin = join(root, 'node-only-bin');
    await mkdir(bin);
    await mkdir(nodeOnlyBin);
    for (const name of ['codex', 'dsh']) {
      await writeFile(join(bin, name), '#!/bin/sh\nexit 0\n');
      await chmod(join(bin, name), 0o755);
    }
    await symlink(process.execPath, join(nodeOnlyBin, 'node'));
    return { root, bin, nodeOnlyBin };
  }

  it('verifies every selected backend and prints versions', async () => {
    const { root, bin } = await buildFakeRoot();
    try {
      const { code, stdout, stderr } = await runScript(['--verify', '--root', root], {
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(code).toBe(0);
      expect(stdout).toContain('claude: PASS');
      expect(stdout).toContain('sdk 0.3.263');
      expect(stdout).toContain('pi: PASS');
      expect(stdout).toContain('@earendil-works/pi-agent-core/package.json (0.83.0)');
      expect(stdout).toContain('codex: PASS');
      expect(stdout).toContain('dsh: PASS');
      expect(stdout).toContain('all selected backends present');
      expect(stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails verification when a selected pi runtime cannot be resolved', async () => {
    const { root, bin } = await buildFakeRoot();
    try {
      await rm(join(root, 'node_modules/@earendil-works/pi-agent-core'), { force: true });
      const { code, stderr } = await runScript(['--verify', '--root', root], {
        PATH: `${bin}:${process.env.PATH}`,
      });
      expect(code).not.toBe(0);
      expect(stderr).toContain('pi: FAIL');
      expect(stderr).toContain('1 selected backend(s) failed verification');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails verification when a selected CLI binary is missing from PATH', async () => {
    const { root, nodeOnlyBin } = await buildFakeRoot();
    try {
      const { code, stdout, stderr } = await runScript(['--verify', '--root', root], { PATH: nodeOnlyBin });
      expect(code).not.toBe(0);
      expect(stderr).toContain('codex: FAIL');
      expect(stderr).toContain('dsh: FAIL');
      expect(stdout).toContain('claude: PASS');
      expect(stdout).toContain('pi: PASS');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('diagnoses with one line and never fails, even without a manifest', async () => {
    const { root, bin } = await buildFakeRoot();
    try {
      const ok = await runScript(['--diagnose', '--root', root], { PATH: `${bin}:${process.env.PATH}` });
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('[backends] claude=ok(0.3.263) pi=ok(0.83.0) codex=ok dsh=ok');

      await rm(join(root, '.backends-manifest.json'));
      const degraded = await runScript(['--diagnose', '--root', root], { PATH: `${bin}:${process.env.PATH}` });
      expect(degraded.code).toBe(0);
      expect(degraded.stdout).toContain('manifest unavailable');
      expect(degraded.stdout).toContain('not-selected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Dockerfile / compose wiring stays in sync (#5168)', () => {
  it('mirrors the pinned defaults in Dockerfile.service', async () => {
    const dockerfile = await readFile(join(repoRoot, 'Dockerfile.service'), 'utf8');
    const arg = (name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)?.[1];
    expect(arg('DISCLAUDE_BACKENDS')).toBe(DEFAULT_SELECTION);
    expect(arg('PI_VERSION')).toBe(DEFAULT_VERSIONS.pi);
    expect(arg('CODEX_VERSION')).toBe(DEFAULT_VERSIONS.codex);
    expect(arg('DSH_VERSION')).toBe(DEFAULT_VERSIONS.dsh);
  });

  it('mirrors the pinned defaults in docker-compose.yml', async () => {
    const compose = await readFile(join(repoRoot, 'docker-compose.yml'), 'utf8');
    const composeDefault = (name: string) =>
      new RegExp(`${name}: \\$\\{${name}:-([^}]+)\\}`).exec(compose)?.[1];
    expect(composeDefault('DISCLAUDE_BACKENDS')).toBe(DEFAULT_SELECTION);
    expect(composeDefault('PI_VERSION')).toBe(DEFAULT_VERSIONS.pi);
    expect(composeDefault('CODEX_VERSION')).toBe(DEFAULT_VERSIONS.codex);
    expect(composeDefault('DSH_VERSION')).toBe(DEFAULT_VERSIONS.dsh);
  });

  it('runs both install stages and ships the manifest plus diagnostics script', async () => {
    const dockerfile = await readFile(join(repoRoot, 'Dockerfile.service'), 'utf8');
    expect(dockerfile).toContain('node /tmp/install-backends.mjs --stage app --root /app');
    expect(dockerfile).toContain('node /tmp/install-backends.mjs --stage globals');
    // Pre-existing image behavior: lark channel tooling still installs.
    expect(dockerfile).toContain('npm install -g "@larksuite/cli@>=1.0.0"');
    expect(dockerfile).toContain('COPY --from=builder --chown=disclaude:disclaude /app/.backends-manifest.json ./.backends-manifest.json');
    expect(dockerfile).toContain('COPY --chown=disclaude:disclaude docker/install-backends.mjs ./scripts/install-backends.mjs');
  });

  it('keeps the entrypoint diagnostic guarded and non-blocking', async () => {
    const entrypoint = await readFile(join(repoRoot, 'docker-entrypoint.sh'), 'utf8');
    expect(entrypoint).toContain('install-backends.mjs --diagnose --root /app 2>/dev/null || true');
    expect(entrypoint).toContain('exec tini -- "$@"');
  });
});
