import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveJupyterAuth } from '../../bin/jupyter-auth.js';

const cli = fileURLToPath(new URL('../../bin/disclaude.js', import.meta.url));

export const probeAuth = (envFile) =>
  resolveJupyterAuth({ jupyter: 'configured', envFile, interactive: false });

export const probeConnection = (auth) => ({
  baseUrl: auth.baseUrl,
  ...(auth.mode === 'token'
    ? { authorization: async () => 'token ' + auth.secret }
    : { password: async () => auth.secret }),
});

export async function probeKernel(client, selectedName) {
  const specs = await client.json('api/kernelspecs');
  const names = Object.keys(specs.kernelspecs);
  const name =
    selectedName ??
    (names.includes(specs.default) ? specs.default : names.length === 1 ? names[0] : undefined);
  const spec = specs.kernelspecs[name]?.spec;
  if (!spec || spec.language !== 'python')
    throw new Error('Select an existing remote Python kernelspec with --kernel-name');
  return { name, display_name: spec.display_name, language: spec.language };
}

export function probeSource() {
  const root = path.dirname(path.dirname(cli));
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const top = git(['rev-parse', '--show-toplevel']);
  const checkout = top.status === 0 && fs.realpathSync(top.stdout.trim()) === fs.realpathSync(root);
  const digest = createHash('sha256');
  for (const name of fs
    .readdirSync(new URL('.', import.meta.url))
    .filter(
      (n) => n.endsWith('.mjs') && (n.startsWith('datalayer-') || n === 'cli-probe-client.mjs')
    )
    .sort()) {
    digest.update(name).update(fs.readFileSync(new URL(name, import.meta.url)));
  }
  return {
    commit: checkout ? git(['rev-parse', 'HEAD']).stdout.trim() : null,
    dirty: checkout ? Boolean(git(['status', '--porcelain']).stdout.trim()) : null,
    release: fs.existsSync(path.join(root, 'release-source.json'))
      ? JSON.parse(fs.readFileSync(path.join(root, 'release-source.json'), 'utf8'))
      : undefined,
    cliSha256: createHash('sha256').update(fs.readFileSync(cli)).digest('hex'),
    probeSha256: digest.digest('hex'),
  };
}

// A transport observer, not a Jupyter server. Every forwarded operation still
// runs on the explicitly configured remote endpoint. No credentials are logged.
export async function observeTransport(baseUrl) {
  const remote = new URL(baseUrl);
  const transport = remote.protocol === 'https:' ? https : http;
  const sockets = new Set();
  const requests = [];
  const observer = { requests, fault: undefined, onResponse: undefined };
  const headers = (incoming) => ({
    ...incoming,
    host: remote.host,
    ...(incoming.origin ? { origin: remote.origin } : {}),
  });
  const target = (url) => new URL(url, remote.origin);
  const server = http.createServer((incoming, outgoing) => {
    const route = incoming.url
      .split('?')[0]
      .slice(remote.pathname.replace(/\/$/, '').length)
      .replace(/^\//, '');
    const entry = { route, method: incoming.method };
    requests.push(entry);
    const fault = observer.fault;
    const matches = fault && (!fault.match || fault.match(entry));
    if (matches && fault.kind !== 'lost-reply') {
      entry.injected = fault.kind;
      if (fault.kind === 'disconnect') {
        incoming.resume();
        outgoing.destroy();
      } else {
        entry.status = fault.kind === 'denied' ? 401 : 503;
        incoming.resume();
        outgoing.writeHead(entry.status).end('{}');
      }
      return;
    }
    const upstream = transport.request(
      target(incoming.url),
      {
        method: incoming.method,
        headers: headers(incoming.headers),
      },
      async (response) => {
        entry.status = response.statusCode;
        if (entry.method === 'POST' && route.endsWith('/execute')) {
          entry.requestId = response.headers.location?.match(/\/requests\/([A-Za-z0-9_-]+)$/)?.[1];
        }
        try {
          await observer.onResponse?.(entry);
          if (matches && response.statusCode === 202 && fault.kind === 'lost-reply') {
            observer.fault = undefined;
            entry.injected = 'lost-reply';
            response.resume();
            outgoing.writeHead(502).end('{}');
            return;
          }
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        } catch {
          response.resume();
          outgoing.destroy();
        }
      }
    );
    upstream.on('error', () => {
      entry.transportError = true;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('{}');
    });
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (incoming, socket, head) => {
    const upstream = transport.request(target(incoming.url), {
      headers: headers(incoming.headers),
    });
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      sockets.add(peer);
      peer.on('close', () => sockets.delete(peer));
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
      }
      socket.write('\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
      socket.on('error', () => peer.destroy());
      peer.on('error', () => socket.destroy());
      socket.on('close', () => peer.destroy());
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  observer.baseUrl = `http://127.0.0.1:${server.address().port}${remote.pathname}`;
  observer.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return observer;
}

export async function createCLIProbe({ envFile, project, directory, observe = false }) {
  if (envFile) envFile = fs.realpathSync(envFile);
  project = fs.realpathSync(project);
  directory = fs.realpathSync(directory);
  const auth = await probeAuth(envFile);
  const traffic = observe ? await observeTransport(auth.baseUrl) : undefined;
  const commands = [];
  const children = new Set();
  const probe = { project, commands, traffic, requests: traffic?.requests ?? [] };
  probe.command = async (command, input, extra = [], { signal, timeoutMs = 65000 } = {}) => {
    signal?.throwIfAborted();
    const args = [cli, 'jupyter', command, '--project-dir', project, '--no-interactive'];
    if (envFile) args.push('--env-file', envFile);
    if (traffic) args.push('--jupyter', traffic.baseUrl);
    let inputFile;
    if (input !== undefined) {
      inputFile = path.join(directory, `cli-input-${randomUUID()}.json`);
      fs.writeFileSync(inputFile, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
      args.push('--input-file', inputFile);
    }
    args.push(...extra);
    const entry = { command, startedAt: new Date().toISOString() };
    commands.push(entry);
    try {
      const child = spawn(process.execPath, args, {
        cwd: project,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          JUPYTERLAB_HOST: auth.baseUrl,
          JUPYTERLAB_PASS: auth.mode === 'password' ? auth.secret : '',
          JUPYTERLAB_TOKEN: auth.mode === 'token' ? auth.secret : '',
        },
      });
      children.add(child);
      entry.pid = child.pid;
      let stdout = '',
        exceeded = false;
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 2_000_000) {
          exceeded = true;
          child.kill('SIGTERM');
        }
      });
      // Never persist raw stderr or execFile errors (which may include credentials).
      child.stderr.resume();
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        entry.timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
      const code = await new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('CLI process could not start')));
        child.once('close', resolve);
      }).finally(() => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        children.delete(child);
      });
      entry.exitCode = code;
      if (stdout.includes(auth.secret)) throw new Error('Credential reached CLI stdout');
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        throw new Error('CLI did not return a JSON envelope');
      }
      if (exceeded || entry.timedOut || signal?.aborted || code !== 0 || envelope.ok !== true) {
        entry.failed = true;
        throw new Error(`Jupyter CLI ${command} failed; query the original run before retrying`);
      }
      entry.data = envelope.data;
      return envelope.data;
    } finally {
      if (inputFile) fs.rmSync(inputFile, { force: true });
      entry.finishedAt = new Date().toISOString();
      fs.writeFileSync(
        path.join(directory, 'cli-commands.json'),
        JSON.stringify(commands, null, 2) + '\n',
        { mode: 0o600 }
      );
    }
  };
  probe.call = (name, input, invocation = {}) =>
    probe.command(name.replace(/^notebook_/, '').replaceAll('_', '-'), input, [], invocation);
  probe.close = async () => {
    if (children.size) throw new Error('CLI commands must finish before probe cleanup');
    await traffic?.close();
  };
  // These optional tools belong only to the explicit DSH component probe. They
  // invoke the public CLI; no ChatAgent hooks, session factory or service state.
  probe.modelTools = async () =>
    (await probe.command('tools')).map((schema) => ({
      name: 'notebook_' + schema.command.replaceAll('-', '_'),
      description: schema.description,
      inputSchema: schema.inputSchema,
      execute: async (input, invocation) => {
        const result = await probe.call(
          'notebook_' + schema.command.replaceAll('-', '_'),
          input,
          invocation
        );
        if (!result.images?.length) return result;
        return {
          format: 'disclaude.tool-result.v1',
          data: result.data,
          images: result.images.map(({ mimeType, filePath }) => {
            const actual = fs.realpathSync(filePath);
            if (!actual.startsWith(project + path.sep))
              throw new Error('Image escaped owned Project');
            return { mimeType, data: fs.readFileSync(actual).toString('base64') };
          }),
        };
      },
    }));
  return probe;
}
