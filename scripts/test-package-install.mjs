#!/usr/bin/env node
// Test a built archive, never a symlink to the developer checkout. No live API calls.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  existsSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const input = process.argv[2] || '';
const isGit = /^github:hs3180\/disclaude#(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(input);
const archive = isGit ? input : resolve(input);
assert(
  isGit || (input.endsWith('.tgz') && existsSync(archive)),
  'Pass a .tgz or github:hs3180/disclaude#<full SHA or version tag>'
);
const temp = mkdtempSync(join(tmpdir(), 'disclaude-package-test-'));
let cleanupSafe = true;
async function verifyPackage() {
  const prefix = join(temp, 'prefix');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOME: temp,
    XDG_CONFIG_HOME: join(temp, '.config'),
    // Managed agents inherit overrides that outrank the smoke configuration.
    // Keep recovery journals, schedules and logs inside this owned test root.
    DISCLAUDE_WORKSPACE_DIR: temp,
    WORKSPACE_DIR: temp,
    LOG_DIR: join(temp, 'logs'),
    LOG_TO_FILE: 'false',
  };
  delete env.DISCLAUDE_API_BASE_URL;
  delete env.DISCLAUDE_API_TOKEN;
  const config = join(temp, 'smoke.json');
  writeFileSync(
    config,
    JSON.stringify({
      agents: { default: { backend: 'claude', llm: 'smoke' } },
      llms: { smoke: { model: 'claude-sonnet-4', api: { protocol: 'anthropic', apiKey: '$SMOKE_API_KEY' } } },
      workspace: { dir: temp },
      channels: { feishu: { enabled: false } },
      logging: { level: 'silent' },
    })
  );
  env.DISCLAUDE_CONFIG_PATH = config;
  env.SMOKE_API_KEY = 'offline-test-placeholder';
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (/^npm_config_/i.test(key)) delete env[key];
    if (
      key === 'DISCLAUDE_BROWSER_RUNTIME' ||
      key === 'DISCLAUDE_CHROMIUM_CONFIG' ||
      key.startsWith('DISCLAUDE_CHROMIUM_') ||
      key.startsWith('CHROMIUM_CDP_') ||
      [
        'BU_CDP_URL',
        'BU_CDP_WS',
        'BU_AUTOSPAWN',
        'BU_NAME',
        'BH_RUNTIME_DIR',
        'BH_TMP_DIR',
        'BH_RUNTIME_DIR_SHARED',
        'BH_TMP_DIR_SHARED',
        'BH_REQUIRE_EXISTING_DAEMON',
      ].includes(key)
    ) delete env[key];
  }
  const prefixFromEnv = process.argv.includes('--prefix-from-env');
  if (prefixFromEnv) env.npm_config_prefix = prefix;
  const plainInstall = process.argv.includes('--plain-install');
  assert(!plainInstall || prefixFromEnv, '--plain-install requires an isolated prefix from the environment');
  // Share npm's content-addressed download cache, never an installed prefix or
  // node_modules. Each Node/npm pair still resolves and installs independently.
  env.npm_config_cache = process.env.DISCLAUDE_INSTALL_TEST_NPM_CACHE
    ? resolve(process.env.DISCLAUDE_INSTALL_TEST_NPM_CACHE)
    : join(temp, 'cache');
  env.npm_config_userconfig = join(temp, 'empty.npmrc');
  function run(command, args, extraEnv = {}) {
    const result = spawnSync(command, args, {
      cwd: temp,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      timeout: 180_000,
    });
    // A signaled or timed-out command may leave descendants; do not erase their working
    // directory without confirmed termination. Report the retained root below.
    if (result.signal || (result.error && ['ETIMEDOUT', 'ENOBUFS'].includes(result.error.code))) cleanupSafe = false;
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`
    );
    return result.stdout;
  }
  console.log(`Isolated installation evidence: ${temp}`);
  console.log(
    `Runtime: ${process.version}; npm: ${run('npm', ['--version']).trim()}; input: ${archive}`
  );
  const installArgs = [
    'install',
    '-g',
    ...(prefixFromEnv ? [] : ['--prefix', prefix]),
    ...(plainInstall ? [] : ['--omit=dev', '--no-audit', '--no-fund']),
    archive,
  ];
  console.log(`Install command: npm ${installArgs.join(' ')}`);
  run('npm', installArgs);
  const installed = join(prefix, 'lib/node_modules/disclaude');
  assert(
    realpathSync(installed).startsWith(realpathSync(prefix) + sep),
    'Package must not link to a temporary clone'
  );
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const isPrebuilt = existsSync(join(installed, 'release-source.json'));
  assert.equal(pkg.scripts?.prepare, undefined, 'User installation must not initialize Git hooks');
  if (isGit) assert(isPrebuilt, 'Git installations must use the prebuilt distribution');
  if (isPrebuilt) {
    assert.equal(pkg.workspaces, undefined);
    for (const script of ['build', 'prepack', 'preinstall', 'install', 'postinstall'])
      assert.equal(pkg.scripts?.[script], undefined);
    assert(existsSync(join(installed, 'release-source.json')));
    assert(existsSync(join(installed, 'README.md')));
    assert(existsSync(join(installed, 'CHANGELOG.md')));
    assert(existsSync(join(installed, '.claude-plugin/plugin.json')));
    assert(existsSync(join(installed, 'agents/mac-screen-control.md')));
    if (process.argv[3] && !process.argv[3].startsWith('--'))
      assert.equal(
        JSON.parse(readFileSync(join(installed, 'release-source.json'), 'utf8')).sourceFingerprint,
        process.argv[3],
        'Installed candidate provenance mismatch'
      );
  }
  assert(!existsSync(join(installed, 'node_modules/husky')), 'Husky must remain development-only');
  assert(existsSync(join(installed, 'disclaude.config.example.yaml')));
  const cli = join(prefix, 'bin/disclaude');
  assert.equal(run(cli, ['--version']).trim(), `disclaude v${pkg.version}`);
  assert.match(run(cli, ['wechat', '--help']), /Personal WeChat via Tencent iLink/u);
  const wechatStatus = JSON.parse(run(cli, ['wechat', 'status', '--state-dir', join(temp, 'wechat-account')]));
  assert.equal(wechatStatus.configured, false);
  assert.equal(wechatStatus.authenticated, 'not-checked');
  // The startup matrix below also checks WeChat-only zero-account registration.
  const wechatConfig = join(temp, 'wechat-empty.json');
  writeFileSync(wechatConfig, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')),
    channels: { wechat: { enabled: true, stateDir: join(temp, 'wechat-account') } },
    logging: { level: 'info', pretty: false },
  }));
  assert.match(run(cli, ['browser', '--help']), /automatically serializes calls/u);
  assert.match(run(cli, ['plugins', '--help']), /official diagnostics plugin is optional/u);
  assert(!existsSync(join(installed, 'skills/diagnose-logs')), 'Diagnostics must not ship in the default skills bundle');
  assert(existsSync(join(installed, 'optional-plugins/diagnostics/skills/diagnose-logs/SKILL.md')));
  assert.match(run(cli, ['jupyter', '--help']), /Kernel memory stays on remote Jupyter/u);
  const notebookTools = JSON.parse(run(cli, ['jupyter', 'tools', '--no-interactive']));
  assert.equal(notebookTools.ok, true);
  assert(notebookTools.data.some((tool) => tool.command === 'execute'));
  assert(notebookTools.data.some((tool) => tool.command === 'download-report'));
  const localList = JSON.parse(run(cli, ['jupyter', 'list', '--project-dir', temp, '--no-interactive']));
  assert.equal(localList.ok, true);
  assert.equal(localList.command, 'list');
  assert.equal(localList.scope, 'project-local-references');
  assert.equal(localList.auth.authentication, 'not_checked');
  assert.deepEqual(localList.data, { scope: 'project-local-references', auth: 'not_checked',
    remoteInventory: 'not_queried', notebooks: [], recentRuns: [] });
  assert(existsSync(join(installed, 'skills/jupyter/SKILL.md')));
  assert(existsSync(join(installed, 'skills/jupyter/README.md')));
  assert.match(run(cli, ['jupyter', 'patch', '--help']), /Generation uses Node only/u);
  assert.match(run(cli, ['jupyter', 'patch', '--help']), /--jupyter URL/u);
  assert.match(run(cli, ['jupyter', 'patch', '--help']), /--interactive/u);
  assert.match(run(cli, ['jupyter', 'patch', '--help']), /--no-interactive/u);
  assert.doesNotMatch(run(cli, ['jupyter', 'patch', '--help']), /--ssh|--container|--service|--restart|--stopped/u);
  assert.equal(existsSync(join(installed, 'jupyter/datalayer/Dockerfile')), false);
  assert(existsSync(join(installed, 'bin/jupyter-terminal.js')));
  assert(existsSync(join(installed, 'bin/jupyter-auth.js')));
  assert(existsSync(join(installed, 'bin/jupyter-test.js')));
  assert.match(run(cli, ['jupyter', 'test', '--help']), /Default: core, edge, fault, report/u);
  assert.match(run(cli, ['jupyter', 'test', '--help']), /no extra plotting packages are required/u);
  assert.doesNotMatch(run(cli, ['jupyter', 'test', '--help']), /--python-path/u);
  const jupyterTests = JSON.parse(run(cli, ['jupyter', 'test', '--list']));
  assert.equal(jupyterTests.ok, true);
  assert.deepEqual(jupyterTests.data.defaultSuites, ['core', 'edge', 'fault', 'report']);
  assert.equal(jupyterTests.data.suites.length, 7);
  for (const suite of ['core', 'edge', 'fault', 'report', 'dsh', 'image', 'delivery']) {
    const filename = suite === 'core' ? 'datalayer-probe.mjs' : `datalayer-${suite}-probe.mjs`;
    assert(existsSync(join(installed, 'jupyter/probes', filename)));
  }
  assert(existsSync(join(installed, 'jupyter/probes/cli-probe-client.mjs')));
  assert(existsSync(join(installed, 'jupyter/probes/display-fixtures.mjs')));
  run(process.execPath, ['--input-type=module', '-e', `
    const { resolveJupyterAuth } = await import(${JSON.stringify(join(installed, 'bin/jupyter-auth.js'))});
    const auth = await resolveJupyterAuth({ jupyter: 'configured', interactive: false }, {
      cwd: ${JSON.stringify(temp)}, environment: { JUPYTERLAB_HOST: 'https://fixture.invalid/prefix/', JUPYTERLAB_TOKEN: 'fixture-token' }
    });
    if (auth.mode !== 'token' || auth.secret !== 'fixture-token') throw new Error('Installed Jupyter auth resolution failed');
  `]);
  assert(existsSync(join(installed, 'packages/core/dist/jupyter/http-connection.js')));
  const patchInfo = JSON.parse(run(cli, ['jupyter', 'patch', 'info']));
  assert.equal(patchInfo.target, 'jupyter_server_nbmodel');
  assert.equal(patchInfo.activation.hotApplySupported, false);
  const patchArtifact = join(temp, 'nbmodel-repair.pyz');
  const generatedPatch = JSON.parse(run(cli, ['jupyter', 'patch', 'generate', '--output', patchArtifact]));
  assert.equal(generatedPatch.manifestSha256, patchInfo.manifestSha256);
  assert(existsSync(patchArtifact));
  assert.equal(readFileSync(patchArtifact + '.sha256', 'utf8').split(' ')[0], generatedPatch.sha256);
  for (const removed of ['coordinator.mjs', 'harness-session.mjs', 'python-runtime.mjs']) {
    assert(!existsSync(join(prefix, 'lib/node_modules/disclaude/packages/service/dist/browser-control', removed)), `Obsolete browser layer shipped: ${removed}`);
  }
  assert.match(run(cli, ['start', '--help']), /Usage:/i);
  assert.match(run(cli, ['channel', '--help']), /Usage:/i);
  // Managed agent sandboxes cannot write the service's inherited host log.
  // Exercise the installed client with a deterministically unusable log path.
  const blockedCliLogDir = join(temp, 'cli-log-path-is-a-file');
  writeFileSync(blockedCliLogDir, 'not a directory');
  for (const args of [
    ['help'],
    ['send_file', '--help'],
    ['send_file', '--chat', 'installation-probe@im.wechat', '--file', config, '--dry-run'],
  ]) {
    const probe = spawnSync(cli, ['channel', ...args], { cwd: temp, encoding: 'utf8', timeout: 15_000,
      env: { ...env, LOG_TO_FILE: 'true', LOG_DIR: blockedCliLogDir },
    });
    assert.equal(probe.status, 0, `Installed channel CLI must tolerate inherited service logging: ${probe.stderr}`);
    if (args.includes('--dry-run')) assert.equal(JSON.parse(probe.stdout).dryRun, true);
    else assert.match(`${probe.stdout}\n${probe.stderr}`, /Usage:/i);
  }
  if (isPrebuilt && process.platform !== 'win32') {
    run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      import { spawnSync } from 'node:child_process';
      const { runningChannelCliInvocation } = await import(pathToFileURL(${JSON.stringify(join(installed, 'packages/service/dist/messaging/channel-cli-invocation.js'))}).href);
      const check = spawnSync('/bin/sh', ['-c', runningChannelCliInvocation() + ' help'], { encoding: 'utf8', env: { ...process.env, PATH: '/no-global-cli', LOG_TO_FILE: 'true', LOG_DIR: ${JSON.stringify(blockedCliLogDir)} } });
      assert.equal(check.status, 0, check.stderr);
      assert.match(check.stdout, /Usage:/i);
    `]);
  }
  assert.match(run(cli, ['chromium-cdp', 'setup', '--help']), /--download/);
  assert.match(run(cli, ['chromium-cdp', 'status', '--help']), /Read-only/u);
  assert.match(run(cli, ['chromium-cdp', 'doctor', '--help']), /Read-only/u);
  assert.match(run(join(prefix, 'bin/disclaude'), ['--help']), /Usage:/i);
  assert.deepEqual(Object.keys(pkg.bin), ['disclaude']);
  assert(!existsSync(join(installed, 'packages/primary-node')));
  assert(!existsSync(join(installed, 'node_modules/@disclaude/primary-node')));
  assert(!existsSync(join(prefix, 'bin/disclaude-primary')));
  assert(!existsSync(join(prefix, 'bin/disclaude-service')));
  // Loading the installed modules catches missing transitive SDK dependencies that
  // --version alone cannot detect. Resolve relative to the installed distribution.
  run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import { join, resolve } from 'node:path';
    import { readFileSync, realpathSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const installed = ${JSON.stringify(installed)};
    const modulesRoot = ${JSON.stringify(isPrebuilt ? 'packages' : 'node_modules/@disclaude')};
    const load = (name, file = 'index.js') => import(pathToFileURL(join(installed, modulesRoot, name, 'dist', file)).href);
    await load('core', 'sdk/providers/deepseek/native-app.js');
    for (const name of ['core', 'service', 'channel-cli']) {
      await load(name);
    }
    // Exercise lazy RTC dependencies in the installed archive.
    await load('core', 'jupyter/rtc-document.js');
    const { createJupyterCookieJar } = await load('core');
    await createJupyterCookieJar();
    const { DisclaudeService } = await load('service', 'service.js');
    const { Config } = await load('core');
    assert.equal(realpathSync(Config.getWorkspaceDir()), realpathSync(${JSON.stringify(temp)}),
      'Installation checks must never use an inherited production workspace');
    if (${isPrebuilt} && realpathSync(Config.getBuiltinsDir()) !== realpathSync(installed)) throw new Error('Builtins do not resolve to installed release');
    // Exercise the installed Codex discovery path from the user's execution root,
    // not a copied skill fixture or the source checkout.
    const { codexSkillsRegistry } = await load('core', 'sdk/providers/codex/skill-sources.js');
    const workspace = realpathSync(process.cwd());
    const skills = codexSkillsRegistry(workspace, Config.getBuiltinsDir()).resolve();
    assert(!skills.manifest.includes('diagnose-logs'), 'Clean default manifest must not expose diagnostics');
    assert.deepEqual(skills.diagnostics.filter((item) => item.name === 'browser-use'), [],
      'Installed browser-use metadata must parse successfully');
    const browserLink = skills.manifest.match(/\\[browser-use\\]\\(([^)]+)\\)/)?.[1];
    assert(browserLink, 'Installed Codex manifest must expose browser-use');
    const browserPath = realpathSync(resolve(workspace, decodeURIComponent(browserLink)));
    assert.equal(browserPath, realpathSync(join(installed, 'skills/browser-use/SKILL.md')),
      'Manifest link must resolve to the installed skill from the execution workspace');
    assert.match(readFileSync(browserPath, 'utf8'), /name: browser-use/);
    const service = new DisclaudeService();
    await service.start({ deferScheduler: true });
    if (!service.isRunning()) throw new Error('DisclaudeService did not start');
    await service.stop();
    if (service.isRunning()) throw new Error('DisclaudeService did not stop');
    process.exit(0);
  `,
  ]);
  // Install through the actual distributed executable, without network or a
  // link to the checkout. Keep the plugin scoped to a separate user Project.
  const diagnosticsProject = join(temp, 'diagnostics project');
  mkdirSync(diagnosticsProject);
  const pluginArgs = ['--project-dir', diagnosticsProject];
  assert.equal(JSON.parse(run(cli, ['plugins', 'list', ...pluginArgs])).data.installed, false);
  assert(!existsSync(join(diagnosticsProject, '.disclaude')), 'Listing plugins must remain read-only');
  assert.equal(JSON.parse(run(cli, ['plugins', 'install', 'diagnostics', ...pluginArgs])).data.changed, true);
  assert.equal(JSON.parse(run(cli, ['plugins', 'install', 'diagnostics', ...pluginArgs])).data.changed, false);
  assert.equal(JSON.parse(run(cli, ['plugins', 'update', 'diagnostics', ...pluginArgs])).data.changed, false);
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { join, resolve } from 'node:path';
    import { readFileSync } from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const root = ${JSON.stringify(installed)};
    const project = ${JSON.stringify(diagnosticsProject)};
    const modulesRoot = ${JSON.stringify(isPrebuilt ? 'packages' : 'node_modules/@disclaude')};
    const load = file => import(pathToFileURL(join(root, modulesRoot, 'core/dist', file)).href);
    const { codexSkillsRegistry } = await load('sdk/providers/codex/skill-sources.js');
    const { diagnosticsPluginManifest, diagnosticsPluginRoot } = await load('skills/diagnostics-plugin.js');
    const { adaptPiOptions } = await load('sdk/providers/pi/options-adapter.js');
    const { adaptOptions } = await load('sdk/providers/claude/options-adapter.js');
    const resolution = codexSkillsRegistry(project, root).resolve();
    const skill = resolution.skills.find(item => item.name === 'diagnose-logs');
    assert(skill, 'Installed diagnostics must be discovered');
    const instructions = readFileSync(resolve(project, skill.reference), 'utf8');
    assert.match(instructions, /Disclaude service issues only/);
    assert(diagnosticsPluginManifest(project).includes('diagnose-logs'), 'DSH manifest must discover installed diagnostics');
    const pi = adaptPiOptions({ settingSources: [], cwd: project }, diagnosticsPluginManifest(project));
    const piReference = pi.systemPrompt.match(/\\[diagnose-logs\\]\\(([^)]+)\\)/)?.[1];
    assert(piReference, 'Installed Pi prompt must discover diagnostics');
    assert.match(readFileSync(resolve(project, decodeURIComponent(piReference)), 'utf8'), /Disclaude service issues only/);
    assert(adaptOptions({ cwd: project, settingSources: [] }).plugins.some(item => item.path === diagnosticsPluginRoot(project)),
      'Claude must load the installed optional local plugin');
  `]);
  assert.equal(JSON.parse(run(cli, ['plugins', 'remove', 'diagnostics', ...pluginArgs])).data.changed, true);
  assert.equal(JSON.parse(run(cli, ['plugins', 'list', ...pluginArgs])).data.installed, false);
  assert(!existsSync(join(diagnosticsProject, '.disclaude/plugins/diagnostics')));
  console.log('OPTIONAL_DIAGNOSTICS_INSTALL_DISCOVERY_REMOVE_OK');
  // Exercise the public executable twice with isolated data and loopback-only REST.
  // No model prompt, live channel or production service is touched.
  const portProbe = createServer();
  await new Promise((done) => portProbe.listen(0, '127.0.0.1', done));
  const restPort = portProbe.address().port;
  await new Promise((done) => portProbe.close(done));
  const cliConfig = JSON.parse(readFileSync(config, 'utf8'));
  cliConfig.channels.rest = { port: restPort, host: '127.0.0.1', fileStorageDir: join(temp, 'files') };
  cliConfig.channels.wechat = { stateDir: join(temp, 'wechat-account') };
  writeFileSync(config, JSON.stringify(cliConfig));
  const sentinel = join(temp, 'user-data.txt');
  writeFileSync(sentinel, 'preserved across restart');
  const registered = [];
  const loginFixture = new URL('../tests/fixtures/wechat-login-gateway.mjs', import.meta.url).href;
  const runtimeFixture = new URL('../tests/fixtures/wechat-runtime-gateway.mjs', import.meta.url).href;
  function registerAccount(bot, id) {
    const output = run(cli, ['wechat', 'login', '--state-dir', join(temp, 'wechat-account'),
      '--qr-file', join(temp, `${bot}.png`), ...(id ? ['--id', id, '--force'] : [])],
      { NODE_OPTIONS: `--import ${loginFixture}`, WECHAT_FIXTURE_BOT: bot });
    assert(!output.includes('fixture-private-token'));
    return JSON.parse(output.trim().split('\n').at(-1));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const startupConfig = attempt === 0 ? wechatConfig : config;
    let output = '';
    const child = spawn(cli, ['start', '--config', startupConfig, '--api-port', '0', '--api-token', 'package-smoke-token'], {
      cwd: temp, env: { ...env, NODE_OPTIONS: `--import ${runtimeFixture}`, LOCKFILE_PATH: join(temp, 'service.pid') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    let childError;
    child.on('error', (error) => { childError = error; });
    const exited = new Promise((done) => child.once('close', (code) => done(code)));
    try {
      let baseUrl;
      for (let i = 0; i < 150; i++) {
        baseUrl = output.match(/HTTP API server started on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
        if (baseUrl || childError || child.exitCode !== null) break;
        await delay(100);
      }
      assert(baseUrl, `CLI failed to start: ${childError || ''}\n${output}`);
      const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.status, 'ok');
      assert.equal(typeof status.instanceId, 'string');
      assert.equal(status.nodeId, undefined);
      const snapshot = async () => {
        const response = await fetch(`${baseUrl}/api/channel-capabilities`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer package-smoke-token' }, body: '{}', signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200);
        return (await response.json()).channels;
      };
      const waitChannels = async ids => {
        let channels;
        for (let i = 0; i < 150; i++) {
          channels = await snapshot();
          if (JSON.stringify(channels.map(channel => channel.id).sort()) === JSON.stringify([...ids].sort()) && channels.every(channel => channel.healthy)) return channels;
          await delay(100);
        }
        assert.fail(`Registered channels did not reconcile: ${JSON.stringify(channels)}`);
      };
      const restIds = attempt === 0 ? [] : ['rest'];
      await waitChannels([...restIds, ...registered.map(account => account.channelId)]);
      if (attempt === 0) {
        registered.push(registerAccount('package-first'));
        await waitChannels(registered.map(account => account.channelId));
        registered.push(registerAccount('package-second'));
        assert.notEqual(registered[0].id, registered[1].id);
        await waitChannels(registered.map(account => account.channelId));
        run(cli, ['wechat', 'disable', registered[0].id, '--state-dir', join(temp, 'wechat-account')]);
        await waitChannels([registered[1].channelId]);
        run(cli, ['wechat', 'enable', registered[0].id, '--state-dir', join(temp, 'wechat-account')]);
        await waitChannels(registered.map(account => account.channelId));
        assert.equal(registerAccount('package-first', registered[0].id).id, registered[0].id);
        await waitChannels(registered.map(account => account.channelId));
        // A failed re-login rolls the account back and reports what the probe
        // found (#5479): config restored is not login restored, and the
        // running service re-attaches the re-enabled account afterwards.
        {
          const result = spawnSync(cli, ['wechat', 'login', '--state-dir', join(temp, 'wechat-account'),
            '--id', registered[0].id, '--force', '--qr-file', join(temp, 'failed-relogin.png')], {
            cwd: temp, encoding: 'utf8', timeout: 60_000,
            env: { ...env, NODE_OPTIONS: `--import ${loginFixture}`, WECHAT_FIXTURE_BOT: 'package-first', WECHAT_FIXTURE_FAILURE: '1' },
          });
          assert.notEqual(result.status, 0, 'A failed re-login must exit non-zero');
          // Stdout only, like registerAccount above: stderr carries the fixture
          // gateway's nock debug traces, which mirror intercepted bodies.
          assert(!result.stdout.includes('fixture-private-token'));
          const report = JSON.parse(result.stdout.trim().split('\n').at(-1));
          assert.equal(report.restored, registered[0].id);
          assert.equal(report.verified, true);
          assert(!('loginExpired' in report));
          await waitChannels(registered.map(account => account.channelId));
        }
      } else if (attempt === 1) {
        run(cli, ['wechat', 'remove', registered[1].id, '--state-dir', join(temp, 'wechat-account')]);
        registered.pop();
        await waitChannels([...restIds, registered[0].channelId]);
      }
      const accounts = JSON.parse(run(cli, ['wechat', 'status', '--state-dir', join(temp, 'wechat-account')])).accounts;
      assert.deepEqual(accounts.map(account => account.id).sort(), registered.map(account => account.id).sort());
      child.kill('SIGTERM');
      assert.equal(await Promise.race([exited, delay(15000).then(() => 'timeout')]), 0, output);
      assert(!existsSync(join(temp, 'service.pid')), 'Graceful shutdown must release the instance lock');
      assert.equal(readFileSync(sentinel, 'utf8'), 'preserved across restart');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        // Wait for the owned CLI to finish before removing its workspace.
        child.kill('SIGTERM');
      }
      // close, unlike exit, waits for inherited output pipes to close too.
      const closed = await Promise.race([exited.then(() => true), delay(15_000, undefined, { ref: false }).then(() => false)]);
      if (!closed) {
        // Do not delete data while the CLI may still be using it. The public
        // wrapper forwards graceful signals to the service; keep diagnostics
        // if that shutdown cannot be confirmed instead of hiding a live leak.
        cleanupSafe = false;
        throw new Error(`Package test CLI did not stop; temporary files retained at ${temp} (pid ${child.pid})`);
      }
    }
  }
  console.log(`WECHAT_DYNAMIC_REGISTRATION_OK ${pkg.version}`);
  console.log(`CLI_START_STOP_RESTART_OK ${pkg.version}`);
  console.log(`PACKAGE_INSTALL_OK ${pkg.version}`);
}

try {
  await verifyPackage();
} finally {
  if (process.argv.includes('--keep-temp') || !cleanupSafe) {
    console.error(`Package test files retained at ${temp}; remove this directory after diagnosis and after confirming its processes have stopped.`);
  } else {
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      assert(!existsSync(temp), `Temporary package test directory still exists: ${temp}`);
      console.log('PACKAGE_TEST_CLEANUP_OK');
    } catch (error) {
      throw new Error(`Package test cleanup failed; inspect residual files at ${temp}`, { cause: error });
    }
  }
}
