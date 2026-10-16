import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promptJupyterValue, resolveJupyterAuth } from '../../bin/jupyter-auth.js';
import { terminalArguments } from '../../bin/jupyter-patch.js';

const baseUrl = 'https://jupyter.invalid/proxy/user/';
const cli = new URL('../../bin/disclaude.js', import.meta.url);

test('the Node-only authentication module loads without compiled packages', async () => {
  const parser = pathToFileURL(createRequire(import.meta.url).resolve('dotenv')).href;
  const source = readFileSync(new URL('../../bin/jupyter-auth.js', import.meta.url), 'utf8')
    .replace("from 'dotenv'", 'from ' + JSON.stringify(parser));
  // Relative compiled-package imports cannot resolve from a data URL.
  const auth = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const owned = fixture();
  try {
    await assert.rejects(auth.resolveJupyterAuth({ jupyter: 'configured', interactive: false },
      { environment: {}, cwd: owned.cwd }), error => error.diagnostic?.code === 'credentials_missing');
  } finally { owned.close(); }
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'jupyter-auth-'));
  return { cwd, close: () => rmSync(cwd, { recursive: true, force: true }) };
}
function terminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.readableFlowing = false;
  input.setRawMode = (raw) => {
    input.isRaw = raw;
    return input;
  };
  input.resume = () => {
    input.readableFlowing = true;
  };
  input.pause = () => {
    input.readableFlowing = false;
  };
  let text = '';
  const output = {
    isTTY: true,
    write: (data) => {
      text += data;
    },
  };
  return { input, output, text: () => text };
}

test('.env discovery and explicit files parse quoted credentials without expansion or host environment mutation', async () => {
  const { cwd, close } = fixture();
  try {
    const environment = {};
    const secret = 'secret # $(never-execute) `literal` $VARIABLE';
    const contents = `export JUPYTERLAB_HOST=${baseUrl}\nJUPYTERLAB_PASS='${secret}' # outside comment\n`;
    writeFileSync(join(cwd, '.env'), contents, { mode: 0o600 });
    const options = { jupyter: 'configured', interactive: false };
    assert.deepEqual(await resolveJupyterAuth(options, { cwd, environment }), {
      baseUrl,
      mode: 'password',
      secret,
    });
    const envFile = join(cwd, 'private file.env');
    writeFileSync(envFile, `JUPYTERLAB_HOST=${baseUrl}\nJUPYTERLAB_TOKEN='file-token'\n`);
    assert.deepEqual(await resolveJupyterAuth({ ...options, envFile }, { cwd, environment }), {
      baseUrl,
      mode: 'token',
      secret: 'file-token',
    });
    assert.deepEqual(environment, {});
    assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), contents);
  } finally {
    close();
  }
});

test('real environment wins over .env across auth modes; empty values mask the same file key', async () => {
  const { cwd, close } = fixture();
  try {
    writeFileSync(
      join(cwd, '.env'),
      `JUPYTERLAB_HOST=${baseUrl}\nJUPYTERLAB_PASS=file-password\nJUPYTERLAB_TOKEN=file-token\n`
    );
    const options = { jupyter: 'configured', interactive: false };
    const environment = {
      JUPYTERLAB_HOST: 'https://env.invalid/prefix/',
      JUPYTERLAB_TOKEN: 'env-token',
    };
    const before = { ...environment };
    assert.deepEqual(await resolveJupyterAuth(options, { cwd, environment }), {
      baseUrl: environment.JUPYTERLAB_HOST,
      mode: 'token',
      secret: 'env-token',
    });
    assert.deepEqual(environment, before);
    assert.equal(
      (
        await resolveJupyterAuth(
          { ...options, passwordEnv: 'JUPYTERLAB_PASS' },
          { cwd, environment }
        )
      ).secret,
      'file-password'
    );
    await assert.rejects(
      resolveJupyterAuth(
        { ...options, passwordEnv: 'JUPYTERLAB_PASS' },
        { cwd, environment: { JUPYTERLAB_PASS: '' } }
      ),
      /missing/
    );
    await assert.rejects(
      resolveJupyterAuth(options, { cwd, environment: { JUPYTERLAB_HOST: '' } }),
      /missing/
    );
  } finally {
    close();
  }
});

test('password/token environment and custom names work without .env; literal URL has priority', async () => {
  const { cwd, close } = fixture();
  try {
    const options = { jupyter: baseUrl, interactive: false };
    const environment = {
      JUPYTERLAB_HOST: 'https://ignored.invalid/',
      JUPYTERLAB_PASS: 'env-password',
      JUPYTERLAB_TOKEN: 'env-token',
      PRIVATE_PASSWORD: 'custom-password',
      PRIVATE_TOKEN: 'custom-token',
    };
    assert.deepEqual(await resolveJupyterAuth(options, { cwd, environment }), {
      baseUrl,
      mode: 'password',
      secret: 'env-password',
    });
    assert.deepEqual(
      await resolveJupyterAuth({ ...options, tokenEnv: 'PRIVATE_TOKEN' }, { cwd, environment }),
      { baseUrl, mode: 'token', secret: 'custom-token' }
    );
    assert.deepEqual(
      await resolveJupyterAuth(
        { ...options, passwordEnv: 'PRIVATE_PASSWORD' },
        { cwd, environment }
      ),
      { baseUrl, mode: 'password', secret: 'custom-password' }
    );
    assert.deepEqual(
      terminalArguments({
        action: 'status',
        ...options,
        envFile: '/private/secret.env',
        tokenEnv: 'PRIVATE_TOKEN',
        interactive: true,
      }),
      ['status']
    );
  } finally {
    close();
  }
});

test('TTY fills only missing fields and accepts either password or token; forced input replaces configured credentials', async () => {
  const { cwd, close } = fixture();
  try {
    for (const mode of ['password', 'token']) {
      const prompts = [],
        answers = [baseUrl, mode, 'private-' + mode];
      const result = await resolveJupyterAuth(
        { jupyter: 'configured' },
        {
          cwd,
          environment: {},
          ...terminal(),
          prompt: async (label, options) => {
            prompts.push([label, options.hidden]);
            return answers.shift();
          },
        }
      );
      assert.deepEqual(result, { baseUrl, mode, secret: 'private-' + mode });
      assert.deepEqual(
        prompts.map((p) => p[1]),
        [false, false, true]
      );
    }
    const prompts = [],
      environment = { JUPYTERLAB_HOST: baseUrl, JUPYTERLAB_PASS: 'configured-password' };
    const result = await resolveJupyterAuth(
      { jupyter: 'configured', interactive: true, passwordEnv: 'JUPYTERLAB_PASS' },
      {
        cwd,
        environment,
        ...terminal(),
        prompt: async (label, options) => {
          prompts.push([label, options.hidden]);
          return 'new-password';
        },
      }
    );
    assert.deepEqual(result, { baseUrl, mode: 'password', secret: 'new-password' });
    assert.deepEqual(prompts, [['Jupyter password (hidden): ', true]]);
    assert.equal(environment.JUPYTERLAB_PASS, 'configured-password');
    const complete = await resolveJupyterAuth(
      { jupyter: 'configured' },
      {
        cwd,
        environment,
        ...terminal(),
        prompt: () => {
          throw new Error('Unexpected prompt');
        },
      }
    );
    assert.equal(complete.secret, 'configured-password');
  } finally {
    close();
  }
});

test('missing auth fails without a TTY or with --no-interactive; malformed URLs and secrets fail privately before prompting', async () => {
  const { cwd, close } = fixture();
  try {
    const prompt = () => {
      throw new Error('Unexpected prompt');
    };
    await assert.rejects(
      resolveJupyterAuth(
        { jupyter: baseUrl },
        { cwd, environment: {}, input: {}, output: {}, prompt }
      ),
      /missing/
    );
    await assert.rejects(
      resolveJupyterAuth(
        { jupyter: baseUrl, interactive: false },
        { cwd, environment: {}, ...terminal(), prompt }
      ),
      /missing/
    );
    for (const jupyter of [
      'https://user:private@jupyter.invalid/',
      'https://jupyter.invalid/?token=private',
      'not a URL private',
      'file:///private',
    ]) {
      await assert.rejects(
        resolveJupyterAuth(
          { jupyter },
          { cwd, environment: { JUPYTERLAB_PASS: 'private' }, prompt }
        ),
        (error) => !error.message.includes('private') && /Jupyter URL/.test(error.message)
      );
    }
    for (const secret of ['private\nline', 'private\u0000byte', 'x'.repeat(8193)]) {
      await assert.rejects(
        resolveJupyterAuth(
          { jupyter: baseUrl },
          { cwd, environment: { JUPYTERLAB_PASS: secret }, prompt }
        ),
        (error) => !error.message.includes(secret) && /credential/.test(error.message)
      );
    }
    await assert.rejects(
      resolveJupyterAuth(
        { jupyter: baseUrl, envFile: join(cwd, 'missing.env') },
        { cwd, environment: { JUPYTERLAB_PASS: 'private' }, prompt }
      ),
      /could not be read/
    );
  } finally {
    close();
  }
});

test('hidden Unicode input and backspace never reach output, restoring original TTY state', async () => {
  const fixture = terminal(),
    before = process.listenerCount('SIGINT');
  const result = promptJupyterValue('Password: ', { ...fixture, hidden: true });
  assert.equal(fixture.input.isRaw, true);
  fixture.input.emit('data', Buffer.from('私密x\x7f密码\r'));
  assert.equal(await result, '私密密码');
  assert.equal(fixture.text(), 'Password: \n');
  assert.equal(fixture.input.isRaw, false);
  assert.equal(fixture.input.readableFlowing, false);
  assert.equal(fixture.input.listenerCount('keypress'), 0);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('Ctrl-C, Ctrl-D, stream close and SIGTERM cancel hidden input and restore echo/listeners', async () => {
  for (const cancel of ['\x03', '\x04', 'end', 'SIGTERM']) {
    const fixture = terminal(),
      before = process.listenerCount('SIGTERM');
    const result = promptJupyterValue('Password: ', { ...fixture, hidden: true });
    fixture.input.emit('data', Buffer.from('never-printed'));
    if (cancel === 'end') fixture.input.emit('end');
    else if (cancel === 'SIGTERM') process.emit('SIGTERM');
    else fixture.input.emit('data', Buffer.from(cancel));
    await assert.rejects(result, /cancelled|closed/);
    assert.equal(fixture.text(), 'Password: \n');
    assert.equal(fixture.input.isRaw, false);
    assert.equal(fixture.input.readableFlowing, false);
    assert.equal(fixture.input.listenerCount('keypress'), 0);
    assert.equal(process.listenerCount('SIGTERM'), before);
  }
});

test('CLI rejects ambiguous/irrelevant interactive options before transport, and explains non-TTY missing auth', () => {
  const { cwd, close } = fixture();
  try {
    for (const args of [
      ['info', '--interactive'],
      ['generate', '--output', join(cwd, 'patch.pyz'), '--no-interactive'],
      ['status', '--ssh', 'fixture', '--interactive'],
      ['status', '--jupyter', 'configured', '--interactive', '--no-interactive'],
      ['status', '--jupyter', 'configured', '--token-env', 'TOKEN', '--password-env', 'PASSWORD'],
    ]) {
      const result = spawnSync(process.execPath, [cli.pathname, 'jupyter', 'patch', ...args], {
        cwd,
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|fetch|Terminal API/);
    }
    const result = spawnSync(
      process.execPath,
      [cli.pathname, 'jupyter', 'patch', 'status', '--jupyter', 'configured', '--no-interactive'],
      { cwd, encoding: 'utf8', env: { PATH: process.env.PATH } }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\.env\/environment variables.*--interactive.*TTY/);
    assert.equal(result.stdout, '');
  } finally {
    close();
  }
});

test('discovers cwd, explicit Project, workspace marker and environment workspace without exposing values', async () => {
  const { cwd: parent, close } = fixture();
  try {
    const workspace = join(parent, 'workspace'), project = join(workspace, 'project'), cwd = join(project, 'nested');
    const fallback = join(parent, 'environment-workspace');
    mkdirSync(cwd, { recursive: true }); mkdirSync(join(workspace, '.disclaude')); mkdirSync(fallback);
    writeFileSync(join(workspace, '.disclaude', 'project-bindings.json'), '{}');
    const save = (directory, secret) => writeFileSync(join(directory, '.env'), `JUPYTERLAB_HOST=${baseUrl}\nJUPYTERLAB_TOKEN=${secret}\n`);
    save(workspace, 'workspace-owned-token'); save(fallback, 'fallback-owned-token');
    const options = { jupyter: 'configured', projectDir: project, interactive: false };
    const events = [];
    const context = { cwd, environment: { DISCLAUDE_WORKSPACE_DIR: fallback }, onDiscovery: event => events.push(event) };
    assert.equal((await resolveJupyterAuth(options, context)).secret, 'workspace-owned-token');
    assert.equal(events.at(-1).envFile, join(workspace, '.env'));
    save(project, 'project-owned-token');
    assert.equal((await resolveJupyterAuth(options, context)).secret, 'project-owned-token');
    save(cwd, 'cwd-owned-token');
    assert.equal((await resolveJupyterAuth(options, context)).secret, 'cwd-owned-token');
    assert.equal((await resolveJupyterAuth({ ...options, envFile: join(fallback, '.env') }, context)).secret, 'fallback-owned-token');
    assert.ok(!JSON.stringify(events).includes('owned-token'));
    await assert.rejects(resolveJupyterAuth({ ...options, envFile: join(parent, 'missing.env') }, context),
      error => error.diagnostic?.layer === 'auth' && error.diagnostic.code === 'env_file_unreadable');
    const unrelated = join(parent, 'unrelated'); mkdirSync(unrelated);
    assert.equal((await resolveJupyterAuth({ ...options, projectDir: unrelated }, { ...context, cwd: unrelated })).secret, 'fallback-owned-token');
  } finally { close(); }
});
