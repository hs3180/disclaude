import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { parseTestOptions, runTests, suiteResult } from '../../bin/jupyter-test.js';
import {
  createCLIProbe,
  probeAuth,
  probeConnection,
  probeKernel,
} from '../../jupyter/probes/cli-probe-client.mjs';
import {
  lineChartSource,
  reportStudySource,
  reportInteraction,
} from '../../jupyter/probes/display-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'bin/disclaude.js');
const fixture = () => fs.mkdtempSync(path.join(tmpdir(), 'jupyter-test-cli-'));
const cleanup = (directory) => fs.rmSync(directory, { recursive: true, force: true });
const credential = 'test-cli-private-token';
const auth = { baseUrl: 'https://example.invalid/prefix/', mode: 'token', secret: credential };
const good = () => ({
  completed: true,
  checks: [{ name: 'Owned fixture assertion', passed: true }],
  originalResourcesPreserved: true,
  source: { commit: 'fixture' },
  resourceCounts: { kernels: [0, 0], sessions: [0, 0] },
});

test('CLI-backed model tools pass the shared host registry and validate an actual CLI result', async () => {
  const directory = fixture();
  let probe;
  try {
    const envFile = path.join(directory, '.env');
    fs.writeFileSync(
      envFile,
      'JUPYTERLAB_HOST=https://example.invalid/\nJUPYTERLAB_PASS=' + credential,
      {
        mode: 0o600,
      }
    );
    probe = await createCLIProbe({ envFile, project: directory, directory });
    // Read the real TypeScript registry without requiring a build in the CLI matrix.
    const { tsImport } = await import('tsx/esm/api');
    const { prepareTools } = await tsImport(
      path.join(root, 'packages/core/src/sdk/tools.ts'),
      import.meta.url
    );
    const tools = prepareTools(await probe.modelTools());
    assert(tools.length > 0);
    const list = tools.find((tool) => tool.name === 'notebook_list');
    assert(list);
    assert.deepEqual(await list.execute({}, { signal: new AbortController().signal }), {
      notebooks: [],
      recentRuns: [],
    });
  } finally {
    await probe?.close();
    cleanup(directory);
  }
});

test('public help/list discover all packaged suites without login, a model or a remote call', () => {
  const cwd = fixture();
  try {
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'JUPYTERLAB_HOST=not-a-valid-url\nJUPYTERLAB_PASS=' + credential
    );
    const run = (args) =>
      spawnSync(process.execPath, [cli, 'jupyter', 'test', ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PATH: '' },
      });
    const help = run(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Default: core, edge, fault, report/);
    assert.match(help.stdout, /no extra plotting packages are required/);
    assert.match(help.stdout, /Jupyter MCP extension\s+is not required/);
    assert(!help.stdout.includes('--python-path'));
    assert(!help.stdout.includes(credential));
    const listed = run(['--list']);
    assert.equal(listed.status, 0);
    const data = JSON.parse(listed.stdout).data;
    assert.deepEqual(data.defaultSuites, ['core', 'edge', 'fault', 'report']);
    assert.deepEqual(
      data.suites.map((s) => s.name),
      ['core', 'edge', 'fault', 'report', 'dsh', 'image', 'delivery']
    );
    assert(!listed.stdout.includes(credential));
  } finally {
    cleanup(cwd);
  }
});

test('invalid suites, model/outbound inputs and removed transports fail before authentication or output creation', () => {
  const cwd = fixture();
  try {
    const output = path.join(cwd, 'receipt');
    for (const args of [
      ['--suite', 'all'],
      ['--suite', 'dsh'],
      ['--suite', 'image', '--model', 'gpt-6-luna'],
      ['--suite', 'delivery'],
      ['--ssh', 'host'],
      ['--container', 'name'],
      ['--python-path', '/remote/extra-packages'],
      ['--suite', 'core', '--chat-id', 'oc_fixture'],
      ['--interactive', '--no-interactive'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [cli, 'jupyter', 'test', ...args, '--output', output],
        { cwd, env: { PATH: '' }, encoding: 'utf8' }
      );
      assert.notEqual(result.status, 0);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert(!fs.existsSync(output));
      assert(!result.stdout.includes('authentication is missing'));
    }
  } finally {
    cleanup(cwd);
  }
});

test('default kernel fixtures import only standard-library modules and the existing IPython display interface', () => {
  const allowed = new Set([
    'struct',
    'zlib',
    'csv',
    'html',
    'json',
    'random',
    'statistics',
    'sys',
    'IPython.display',
  ]);
  for (const source of [lineChartSource, reportStudySource('synthetic-input.csv')]) {
    const imports = [...source.matchAll(/^(?:import (.+)|from (\S+) import .+)$/gm)];
    assert(imports.length > 0);
    for (const match of imports)
      for (const module of match[1]?.split(',') ?? [match[2]])
        assert(allowed.has(module), 'Unexpected kernel dependency: ' + module);
    assert(!/sys\.path|pip|importlib/.test(source));
  }
});

test('the self-contained report interaction computes the sum from its actual CSV-derived values', () => {
  for (const values of [
    [3, 7, 2],
    [4, 1, 6],
  ]) {
    const button = {};
    const summary = { textContent: 'Mean' };
    const element = {
      dataset: { reportValues: JSON.stringify(values) },
      querySelector: (selector) => (selector === 'button' ? button : summary),
    };
    runInNewContext(reportInteraction, { document: { currentScript: { parentElement: element } } });
    assert.equal(summary.textContent, 'Mean');
    button.onclick();
    assert.equal(summary.textContent, 'Sum: ' + values.reduce((sum, value) => sum + value, 0));
  }
});

test('default API suites exclude model/outbound and failed assertions are not converted into success', async () => {
  const cwd = fixture();
  try {
    const selected = [];
    const output = path.join(cwd, 'result');
    const result = await runTests(parseTestOptions(['--output', output], cwd), {
      authenticate: async () => auth,
      runSuite: async (suite, args, directory, environment) => {
        selected.push(suite.name);
        assert.equal(environment.JUPYTERLAB_PASS, '');
        assert.equal(environment.JUPYTERLAB_TOKEN, credential);
        assert.equal(args[0], '--output');
        assert.equal(directory, path.join(output, suite.name));
        const receipt = good();
        if (suite.name === 'edge') receipt.checks[0].passed = false;
        return { receipt, exitCode: 0 };
      },
    });
    assert.deepEqual(selected, ['core', 'edge', 'fault', 'report']);
    assert.equal(result.ok, false);
    assert.equal(result.data.suites[0].state, 'passed');
    assert.equal(result.data.suites[1].state, 'failed');
    const persisted = fs.readFileSync(result.data.receiptFile, 'utf8');
    assert(!persisted.includes(credential));
    assert.equal(fs.statSync(result.data.receiptFile).mode & 0o777, 0o600);
  } finally {
    cleanup(cwd);
  }
});

test('absence of assertions, failed exit codes and resource loss never pass; unconfirmed cleanup stops further suites', async () => {
  assert.equal(suiteResult('edge', { ...good(), checks: [] }, 0).state, 'failed');
  assert.equal(suiteResult('core', { ...good(), requiredChecksPassed: false }, 0).state, 'failed');
  assert.equal(
    suiteResult('core', { ...good(), originalResourcesPreserved: false }, 0).state,
    'failed'
  );
  assert.equal(suiteResult('core', { ...good(), cleanupFailed: true }, 0).state, 'failed');
  assert.equal(suiteResult('edge', good(), 1).state, 'failed');
  assert.equal(
    suiteResult('image', { completed: true, noKernelOrSessionChanges: false }, 0).state,
    'failed'
  );
  const cwd = fixture();
  try {
    let calls = 0;
    const result = await runTests(parseTestOptions(['--output', path.join(cwd, 'result')], cwd), {
      authenticate: async () => auth,
      runSuite: async () => {
        calls++;
        return { receipt: { ...good(), cleanupFailed: true }, exitCode: 1 };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.deepEqual(
      result.data.suites.map((s) => s.state),
      ['failed', 'not_run', 'not_run', 'not_run']
    );
  } finally {
    cleanup(cwd);
  }
});

test('TTY options, custom secret variables and per-suite data reach their host-only boundaries', async () => {
  const cwd = fixture();
  const name = 'DIS_JUPYTER_TEST_CUSTOM_SECRET';
  const previous = process.env[name];
  process.env[name] = credential;
  try {
    const options = parseTestOptions(
      [
        '--suite',
        'edge',
        '--cases',
        'move-delete-running',
        '--token-env',
        name,
        '--interactive',
        '--output',
        path.join(cwd, 'result'),
      ],
      cwd
    );
    const result = await runTests(options, {
      authenticate: async (input) => {
        assert.equal(input.interactive, true);
        assert.equal(input.tokenEnv, name);
        return auth;
      },
      runSuite: async (suite, args, directory, environment) => {
        assert.equal(environment[name], undefined);
        assert.equal(environment.JUPYTERLAB_TOKEN, credential);
        assert.equal(environment.JUPYTERLAB_PASS, '');
        assert(args.includes('move-delete-running'));
        assert(!args.includes(credential));
        return { receipt: good(), exitCode: 0 };
      },
    });
    assert.equal(result.ok, true);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    cleanup(cwd);
  }
});

test('the normalized environment supports both token and password probes without requiring an env file', async () => {
  const cwd = fixture();
  const saved = Object.fromEntries(
    ['JUPYTERLAB_HOST', 'JUPYTERLAB_PASS', 'JUPYTERLAB_TOKEN'].map((key) => [key, process.env[key]])
  );
  try {
    const file = path.join(cwd, 'host.env');
    fs.writeFileSync(file, 'JUPYTERLAB_HOST=https://file.invalid/\nJUPYTERLAB_PASS=file-password');
    process.env.JUPYTERLAB_HOST = auth.baseUrl;
    process.env.JUPYTERLAB_PASS = '';
    process.env.JUPYTERLAB_TOKEN = credential;
    const token = await probeAuth(file);
    assert.deepEqual(token, auth);
    assert.equal(await probeConnection(token).authorization(), 'token ' + credential);
    process.env.JUPYTERLAB_PASS = 'test-cli-private-password';
    process.env.JUPYTERLAB_TOKEN = '';
    const password = await probeAuth(file);
    assert.equal(password.mode, 'password');
    assert.equal(await probeConnection(password).password(), 'test-cli-private-password');
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    cleanup(cwd);
  }
});

test('remote kernel selection uses published names and refuses ambiguity without an explicit selection', async () => {
  const spec = { spec: { language: 'python', display_name: 'Python fixture' } };
  const client = {
    json: async () => ({ default: 'missing-default', kernelspecs: { 'custom-python': spec } }),
  };
  assert.equal((await probeKernel(client)).name, 'custom-python');
  client.json = async () => ({
    default: 'missing-default',
    kernelspecs: { first: spec, second: spec },
  });
  await assert.rejects(probeKernel(client), /--kernel-name/);
  assert.equal((await probeKernel(client, 'second')).name, 'second');
  await assert.rejects(probeKernel(client, 'absent'), /--kernel-name/);
});

test('an interrupt allows the active suite to finish cleanup and does not start another suite', async () => {
  const cwd = fixture();
  const controller = new AbortController();
  let finished = false,
    calls = 0;
  try {
    const result = await runTests(parseTestOptions(['--output', path.join(cwd, 'result')], cwd), {
      authenticate: async () => auth,
      signal: controller.signal,
      runSuite: async () => {
        calls++;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished = true;
        return { receipt: good(), exitCode: 0 };
      },
    });
    assert(finished);
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(result.data.interrupted, true);
    assert.equal(result.data.suites[0].state, 'passed');
  } finally {
    cleanup(cwd);
  }
});

test('existing output is refused before authentication and user evidence remains intact', async () => {
  const cwd = fixture();
  try {
    const file = path.join(cwd, 'user.txt');
    fs.writeFileSync(file, 'user evidence');
    let authenticated = false;
    await assert.rejects(
      runTests(parseTestOptions(['--output', cwd], cwd), {
        authenticate: async () => {
          authenticated = true;
          return auth;
        },
      }),
      /new directory/
    );
    assert.equal(authenticated, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'user evidence');
  } finally {
    cleanup(cwd);
  }
});

test('actual CLI interruption waits for an isolated probe process, preserves its receipt and redacts its stdout', async () => {
  const cwd = fixture();
  let child;
  try {
    fs.mkdirSync(path.join(cwd, 'bin'));
    fs.mkdirSync(path.join(cwd, 'jupyter/probes'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"type":"module"}');
    for (const file of ['disclaude.js', 'jupyter-test.js'])
      fs.copyFileSync(path.join(root, 'bin', file), path.join(cwd, 'bin', file));
    fs.writeFileSync(
      path.join(cwd, 'bin/jupyter-auth.js'),
      'export async function resolveJupyterAuth(){return ' + JSON.stringify(auth) + ';}'
    );
    fs.writeFileSync(
      path.join(cwd, 'jupyter/probes/datalayer-probe.mjs'),
      `import fs from 'node:fs';import path from 'node:path';const dir=process.argv[process.argv.indexOf('--output')+1];fs.mkdirSync(dir,{mode:0o700});console.log(process.env.JUPYTERLAB_TOKEN);await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(dir,'report.json'),${JSON.stringify(JSON.stringify(good()))});`
    );
    const output = path.join(cwd, 'result');
    child = spawn(
      process.execPath,
      [path.join(cwd, 'bin/disclaude.js'), 'jupyter', 'test', '--output', output],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '',
      stderr = '',
      sent = false;
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => {
      stderr += data;
      if (!sent && stderr.includes('core: running')) {
        sent = true;
        child.kill('SIGINT');
      }
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    const exitCode = await new Promise((resolve) => child.once('close', resolve));
    clearTimeout(timer);
    assert.equal(exitCode, 130);
    assert(sent);
    const result = JSON.parse(stdout);
    assert.equal(result.data.interrupted, true);
    assert.equal(result.data.suites[0].state, 'passed');
    assert.equal(result.data.suites[1].state, 'not_run');
    assert(fs.existsSync(path.join(output, 'core/report.json')));
    assert(!stdout.includes(credential));
    assert(!fs.readFileSync(path.join(output, 'core.stdout.log'), 'utf8').includes(credential));
  } finally {
    if (child?.exitCode === null) throw new Error('Retain active fixture for inspection');
    cleanup(cwd);
  }
});
