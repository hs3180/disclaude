#!/usr/bin/env node
/** Opt-in configured Jupyter checks; never loaded by ordinary chat. */
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveJupyterAuth } from './jupyter-auth.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = ['core', 'edge', 'fault', 'report'];
export const testSuites = [
  {
    name: 'core',
    file: 'datalayer-probe.mjs',
    description: 'Live cells, original-run recovery, background outputs, cancellation and exports',
    options: ['long-seconds', 'kernel-name'],
  },
  {
    name: 'edge',
    file: 'datalayer-edge-probe.mjs',
    description: 'Cancellation/source/MIME/document/export races and process recovery',
    options: ['cases', 'kernel-name'],
  },
  {
    name: 'fault',
    file: 'datalayer-fault-probe.mjs',
    description: 'Injected transport failures, lost acceptance and owned kernel restart',
    options: ['kernel-name'],
  },
  {
    name: 'report',
    file: 'datalayer-report-probe.mjs',
    description: 'CSV, two clean kernels, PNG/SVG/HTML reports and authentication',
    options: ['kernel-name'],
  },
  {
    name: 'dsh',
    file: 'datalayer-dsh-probe.mjs',
    description: 'Explicit real DSH model with optional CLI-backed tools',
    options: ['oauth-auth-file', 'model', 'binary', 'kernel-name'],
    requires: ['oauth-auth-file', 'model'],
  },
  {
    name: 'image',
    file: 'datalayer-image-probe.mjs',
    description: 'Explicit real model observation of an existing owned Project image',
    options: ['oauth-auth-file', 'model', 'binary', 'project', 'cell-id', 'output-index'],
    requires: ['oauth-auth-file', 'model', 'project', 'cell-id'],
  },
  {
    name: 'delivery',
    file: 'datalayer-delivery-probe.mjs',
    description: 'Explicit real file delivery into an authorized fresh Feishu thread',
    options: ['project', 'chat-id', 'root-message-id'],
    requires: ['project', 'chat-id', 'root-message-id'],
  },
];

export const testHelp = `Usage: disclaude jupyter test [options]

Run configured-remote checks through independent public CLI processes.
Default: core, edge, fault, report. Model and outbound suites require explicit selection.
Only owned scratch Notebooks/kernels are exercised; no local Jupyter, service
restart, SSH/container management, automatic package installation or bot connection.

  --suite NAME[,NAME]    api (default), core, edge, fault, report, dsh, image, delivery
                        Repeat --suite to combine selections; api excludes model/outbound
  --list                List suites without authentication or remote operations
  --output PATH         New private evidence directory (default: a fresh temporary directory)
  --jupyter URL         Remote endpoint (default: configured JUPYTERLAB_HOST)
  --env-file PATH       Host-private .env; actual environment values take precedence
  --password-env NAME   Read a password from this variable
  --token-env NAME      Read a token from this variable
  --interactive         Hidden TTY authentication input; prompts once before launching suites
  --no-interactive      Refuse prompts (recommended for agents)

  --cases NAME[,NAME]   Edge case selection
  --long-seconds N      Core background wait, 2–120 seconds (default 67)
  --kernel-name NAME    Existing remote Python kernelspec for scratch kernels
  --oauth-auth-file PATH --model gpt-5.6-luna   Required for dsh/image suites
  --binary PATH         DSH executable (default: dsh)
  --project PATH --cell-id ID [--output-index N]  Existing owned image-probe Project
  --project PATH --chat-id ID --root-message-id ID  Authorized fresh delivery thread

Default suites use Python's standard library and the existing IPython display
interface; no extra plotting packages or Jupyter MCP extension are required. JSON stdout summarizes
checks, source and evidence paths;
failed checks and unverified conditions are preserved. A nonzero exit means a
failed/incomplete suite. SIGINT/SIGTERM stops further suites after the active
suite finishes its bounded work and owned-resource cleanup.

Examples:
  disclaude jupyter test --env-file /private/host.env --no-interactive
  disclaude jupyter test --suite core --output ./jupyter-check
  disclaude jupyter test --suite edge --cases move-delete-running --no-interactive
  disclaude jupyter test --suite report --kernel-name existing-python
`;

export function parseTestOptions(args, cwd = process.cwd()) {
  if (args[0] === 'test') args = args.slice(1);
  const strings = [
    'output',
    'jupyter',
    'env-file',
    'password-env',
    'token-env',
    ...new Set(testSuites.flatMap((s) => s.options)),
  ];
  const { values } = parseArgs({
    args,
    options: {
      ...Object.fromEntries(strings.map((name) => [name, { type: 'string' }])),
      suite: { type: 'string', multiple: true },
      list: { type: 'boolean' },
      interactive: { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
    },
  });
  if (values.interactive && values['no-interactive'])
    throw new Error('Choose --interactive or --no-interactive');
  if (values['password-env'] && values['token-env'])
    throw new Error('Choose --password-env or --token-env');
  const suites = [
    ...new Set(
      (values.suite ?? ['api'])
        .flatMap((value) => value.split(','))
        .flatMap((name) => (name === 'api' ? api : [name]))
    ),
  ];
  if (!suites.length || suites.some((name) => !testSuites.some((s) => s.name === name)))
    throw new Error('Unknown Jupyter test suite; use --list');
  const selected = testSuites.filter((s) => suites.includes(s.name));
  for (const name of new Set(testSuites.flatMap((s) => s.options)))
    if (values[name] !== undefined && !selected.some((s) => s.options.includes(name)))
      throw new Error('--' + name + ' is not used by the selected suites');
  if (!values.list)
    for (const suite of selected) {
      for (const name of suite.requires ?? [])
        if (!values[name]) throw new Error('Suite ' + suite.name + ' requires --' + name);
      if (suite.options.includes('model') && values.model !== 'gpt-5.6-luna')
        throw new Error('DSH/image acceptance requires the explicit --model gpt-5.6-luna override');
    }
  if (
    values['long-seconds'] !== undefined &&
    (!Number.isSafeInteger(Number(values['long-seconds'])) ||
      Number(values['long-seconds']) < 2 ||
      Number(values['long-seconds']) > 120)
  )
    throw new Error('--long-seconds must be an integer between 2 and 120');
  if (
    values['output-index'] !== undefined &&
    (!Number.isSafeInteger(Number(values['output-index'])) || Number(values['output-index']) < 0)
  )
    throw new Error('--output-index must be a nonnegative integer');
  const paths = ['output', 'env-file', 'oauth-auth-file', 'project'];
  for (const name of paths)
    if (values[name] !== undefined) values[name] = path.resolve(cwd, values[name]);
  return {
    values,
    selected,
    cwd,
    auth: {
      jupyter: values.jupyter ?? 'configured',
      envFile: values['env-file'],
      passwordEnv: values['password-env'],
      tokenEnv: values['token-env'],
      interactive: values['no-interactive'] ? false : values.interactive,
    },
  };
}

export function suiteResult(name, receipt, exitCode) {
  const checks = (receipt.checks ?? []).map((c) => ({
    name: c.name,
    passed: c.passed === true,
    required: true,
  }));
  const resourceFlags = [
    'originalResourcesPreserved',
    'originalKernelsPreserved',
    'originalSessionsPreserved',
    'noKernelOrSessionChanges',
  ].filter((key) => key in receipt);
  const cleanupConfirmed =
    (resourceFlags.length > 0
      ? resourceFlags.every((key) => receipt[key] === true)
      : name === 'image') &&
    !receipt.cleanupFailed &&
    !receipt.cleanupErrors &&
    !receipt.cleanupError;
  const assertionsPresent = !api.includes(name) || checks.some((c) => c.required);
  const passed =
    exitCode === 0 &&
    receipt.completed === true &&
    receipt.requiredChecksPassed !== false &&
    assertionsPresent &&
    checks.every((c) => !c.required || c.passed) &&
    cleanupConfirmed;
  return {
    state: passed ? 'passed' : 'failed',
    checks,
    passedChecks: checks.filter((c) => c.required && c.passed).length,
    requiredChecks: checks.filter((c) => c.required).length,
    cleanupConfirmed,
    source: receipt.source,
    scope: receipt.scope,
    resourceCounts: receipt.resourceCounts,
    error: receipt.error ?? receipt.operationError,
  };
}

async function executeSuite(suite, args, directory, environment, secret, cwd) {
  const child = spawn(process.execPath, [path.join(root, 'jupyter/probes', suite.file), ...args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '',
    exceeded = false;
  child.stdout.on('data', (chunk) => {
    if (exceeded) return;
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 2_000_000) {
      stdout = '';
      exceeded = true;
    }
  });
  child.stderr.resume();
  const exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', resolve);
  });
  fs.writeFileSync(
    path.join(path.dirname(directory), suite.name + '.stdout.log'),
    stdout.replaceAll(secret, '[REDACTED]'),
    { mode: 0o600, flag: 'wx' }
  );
  if (exceeded) throw new Error('Suite output exceeded its budget; inspect owned resources');
  const file = path.join(directory, 'report.json');
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(secret)) throw new Error('Credential reached the suite receipt');
  return { receipt: JSON.parse(raw), exitCode, receiptFile: file, pid: child.pid };
}

export async function runTests(
  options,
  { authenticate = resolveJupyterAuth, runSuite = executeSuite, signal, progress = () => {} } = {}
) {
  const { values, selected, cwd } = options;
  if (values.output && fs.existsSync(values.output))
    throw new Error('Test output must be a new directory');
  const auth = await authenticate(options.auth);
  signal?.throwIfAborted();
  const output = values.output ?? fs.mkdtempSync(path.join(tmpdir(), 'disclaude-jupyter-test-'));
  if (values.output) {
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.mkdirSync(output, { mode: 0o700 });
  }
  const environment = {
    ...process.env,
    JUPYTERLAB_HOST: auth.baseUrl,
    JUPYTERLAB_PASS: auth.mode === 'password' ? auth.secret : '',
    JUPYTERLAB_TOKEN: auth.mode === 'token' ? auth.secret : '',
  };
  for (const name of [options.auth.passwordEnv, options.auth.tokenEnv])
    if (name && !['JUPYTERLAB_PASS', 'JUPYTERLAB_TOKEN'].includes(name)) delete environment[name];
  const report = {
    startedAt: new Date().toISOString(),
    output,
    scope:
      'Configured-remote component checks; model, outbound, product and device acceptance have separate scopes',
    suites: [],
    interrupted: false,
  };
  const receiptFile = path.join(output, 'report.json');
  let cleanupUnconfirmed = false;
  const save = () => {
    const serialized = JSON.stringify(report, null, 2);
    if (serialized.includes(auth.secret)) throw new Error('Credential reached the test summary');
    fs.writeFileSync(receiptFile, serialized + '\n', { mode: 0o600 });
  };
  for (const suite of selected) {
    if (signal?.aborted || cleanupUnconfirmed) {
      report.suites.push({
        name: suite.name,
        state: 'not_run',
        reason: signal?.aborted
          ? 'Interrupted before starting this suite'
          : 'Previous suite cleanup is unconfirmed',
      });
      save();
      continue;
    }
    const directory = path.join(output, suite.name);
    const args = ['--output', directory];
    if (values['env-file']) args.push('--env-file', values['env-file']);
    for (const name of suite.options)
      if (values[name] !== undefined) args.push('--' + name, values[name]);
    const record = {
      name: suite.name,
      startedAt: new Date().toISOString(),
      state: 'running',
      output: directory,
    };
    report.suites.push(record);
    save();
    progress(suite.name + ': running');
    try {
      const result = await runSuite(suite, args, directory, environment, auth.secret, cwd);
      Object.assign(record, suiteResult(suite.name, result.receipt, result.exitCode), {
        exitCode: result.exitCode,
        receiptFile: result.receiptFile,
        pid: result.pid,
      });
      cleanupUnconfirmed = !record.cleanupConfirmed;
    } catch {
      record.state = 'failed';
      record.error =
        'Suite did not produce a verified receipt; check its prerequisites and owned resources';
      cleanupUnconfirmed = true;
    }
    record.finishedAt = new Date().toISOString();
    save();
    progress(suite.name + ': ' + record.state);
  }
  report.interrupted = signal?.aborted === true;
  report.finishedAt = new Date().toISOString();
  report.passed = !report.interrupted && report.suites.every((s) => s.state === 'passed');
  save();
  return { ok: report.passed, command: 'test', data: { ...report, receiptFile } };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(testHelp);
    return;
  }
  const options = parseTestOptions(args);
  if (options.values.list) {
    console.log(
      JSON.stringify({
        ok: true,
        command: 'test',
        data: {
          defaultSuites: api,
          suites: testSuites.map(({ file: _file, options: _options, ...suite }) => suite),
        },
      })
    );
    return;
  }
  const controller = new AbortController();
  let exitSignal;
  const stop = (signal) => {
    if (!exitSignal)
      process.stderr.write(
        'Interrupted; waiting for active suite work and owned-resource cleanup.\n'
      );
    exitSignal ??= signal;
    controller.abort();
  };
  const interrupt = () => stop('SIGINT'),
    terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await runTests(options, {
      signal: controller.signal,
      progress: (message) => process.stderr.write(message + '\n'),
    });
    console.log(JSON.stringify(result));
    if (!result.ok)
      process.exitCode = exitSignal === 'SIGINT' ? 130 : exitSignal === 'SIGTERM' ? 143 : 1;
  } catch (error) {
    if (!exitSignal) throw error;
    console.log(
      JSON.stringify({
        ok: false,
        command: 'test',
        interrupted: true,
        error: 'Interrupted before test setup completed',
      })
    );
    process.exitCode = exitSignal === 'SIGINT' ? 130 : 143;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.log(JSON.stringify({ ok: false, command: 'test', error: error.message }));
    process.exitCode = 1;
  });
