import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../docker-entrypoint.sh', import.meta.url));

async function runEntrypoint(config: unknown, extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'disclaude-entrypoint-'));
  try {
    const bin = join(root, 'bin');
    const modules = join(root, 'config');
    await mkdir(bin);
    await mkdir(modules);

    // Only relocate the packaged loader. The extracted script still runs under
    // the real Node executable, including Node 22's handling of top-level return.
    const source = (await readFile(entrypoint, 'utf8')).replace(
      'const base = "/app/node_modules/@disclaude/core/dist/config";',
      `const base = ${JSON.stringify(modules)};`
    );
    const script = join(root, 'docker-entrypoint.sh');
    await writeFile(script, source);
    await writeFile(join(modules, 'package.json'), '{"type":"commonjs"}');
    await writeFile(
      join(modules, 'discovery.js'),
      `
      exports.readDiscoveredConfigYaml = () => {
        if (process.env.TEST_CONFIG_CRASH) throw new Error('config loader exploded');
        return { config: JSON.parse(process.env.TEST_CONFIG) };
      };
    `
    );
    await writeFile(
      join(modules, 'env-reference.js'),
      `
      exports.credentialEnvName = value => /^\\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)?.[1];
    `
    );
    await writeFile(
      join(bin, 'lark-cli'),
      `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_ARGS_FILE"
cat > "$TEST_SECRET_FILE"
`
    );
    await writeFile(join(bin, 'tini'), '#!/bin/sh\nexit 0\n');
    await exec('chmod', ['+x', join(bin, 'lark-cli'), join(bin, 'tini')]);
    const configFile = join(root, 'disclaude.config.yaml');
    await writeFile(configFile, '# read by the discovery stub\n');
    const argsFile = join(root, 'lark-args');
    const secretFile = join(root, 'lark-secret');
    const { stdout, stderr } = await exec('sh', [script, 'start'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        DISCLAUDE_CONFIG_PATH: configFile,
        TEST_CONFIG: JSON.stringify(config),
        TEST_ARGS_FILE: argsFile,
        TEST_SECRET_FILE: secretFile,
        ...extraEnv,
      },
      timeout: 5_000,
    });
    const readOptional = async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    };
    return {
      stdout,
      stderr,
      args: await readOptional(argsFile),
      secret: await readOptional(secretFile),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('docker-entrypoint lark-cli authentication', () => {
  it.each([
    ['literal', 'secret literal', {}, 'secret literal'],
    [
      'environment reference',
      '$FEISHU_TEST_SECRET',
      { FEISHU_TEST_SECRET: 'secret from env' },
      'secret from env',
    ],
  ])(
    `initializes lark-cli with %s credentials on Node ${process.version}`,
    async (_name, appSecret, env, expectedSecret) => {
      const result = await runEntrypoint(
        { channels: { feishu: { appId: 'cli_test_app', appSecret } } },
        env
      );
      expect(result.args).toContain('config\ninit\n--app-id\ncli_test_app\n--app-secret-stdin');
      expect(result.secret).toBe(expectedSecret);
      expect(result.stdout).toContain('lark-cli auth configured successfully');
      expect(result.stderr).not.toContain('SyntaxError');
    }
  );

  it('preserves the not-configured result without invoking lark-cli', async () => {
    const result = await runEntrypoint({ channels: { feishu: {} } });
    expect(result.stdout).toContain('appId/appSecret not configured');
    expect(result.args).toBeNull();
    expect(result.stderr).not.toContain('failed to extract');
  });

  it('preserves the missing-env result without invoking lark-cli', async () => {
    const result = await runEntrypoint({
      channels: { feishu: { appId: 'cli_test_app', appSecret: '$FEISHU_TEST_SECRET' } },
    });
    expect(result.stdout).toContain('WARNING: appSecret references FEISHU_TEST_SECRET');
    expect(result.args).toBeNull();
  });

  it('reports extraction crashes separately from missing configuration', async () => {
    const result = await runEntrypoint({}, { TEST_CONFIG_CRASH: '1' });
    expect(result.stderr).toContain('config loader exploded');
    expect(result.stderr).toContain('failed to extract channels.feishu credentials (exit 1)');
    expect(result.stdout).not.toContain('not configured');
    expect(result.args).toBeNull();
  });
});
