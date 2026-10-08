/** Install files through authenticated Jupyter Terminal; activation requires a restart. */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { resolveJupyterAuth } from './jupyter-auth.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function terminalSession(options) {
  const { baseUrl, mode, secret } = await resolveJupyterAuth(options);
  // Reuse the main client's cookie, XSRF, origin and redirect rules. Secrets stay
  // in this host session, never in terminal commands, artifacts or printed output.
  const { JupyterHttpConnection } =
    await import('../packages/core/dist/jupyter/http-connection.js');
  const require = createRequire(resolve(ROOT, 'packages/service/package.json'));
  return {
    client: new JupyterHttpConnection({
      baseUrl,
      ...(mode === 'token'
        ? { authorization: async () => 'token ' + secret }
        : { password: async () => secret }),
      allowInsecureHttp: baseUrl.startsWith('http://'),
    }),
    WebSocket: require('ws'),
  };
}

export async function deployTerminal(options, patch, forwarded, injected) {
  if (!['prepare', 'apply', 'rollback', 'status'].includes(options.action))
    throw new Error('Expected a Jupyter Terminal installation action');
  const { client, WebSocket } = injected || (await terminalSession(options));
  async function request(route, method = 'GET', body) {
    const response = await client.response(route, method, body);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Jupyter Terminal API returned HTTP ${response.status}; enable terminals and check login permissions`
      );
    }
    return response.status === 204 ? null : JSON.parse(await client.responseText(response));
  }
  const terminal = await request('api/terminals', 'POST', {});
  if (!terminal || typeof terminal.name !== 'string' || !terminal.name)
    throw new Error('Created terminal identity is unconfirmed; no command sent');
  const ready = 'REPAIR_READY_' + randomUUID().replaceAll('-', '');
  const receipt = 'REPAIR_RESULT_' + randomUUID().replaceAll('-', '');
  const digest = createHash('sha256').update(patch.bytes).digest('hex');
  const code = `import base64, hashlib, json, os, pathlib, shlex, subprocess, sys, tempfile
print('${ready}', flush=True)
lines = []
for line in sys.stdin:
    if line.strip() == '${receipt}': break
    lines.append(line.strip())
    if sum(map(len, lines)) > ${Math.ceil(patch.bytes.length / 3) * 4 + 4}: raise SystemExit('Transfer too large')
data = base64.b64decode(''.join(lines), validate=True)
if hashlib.sha256(data).hexdigest() != '${digest}': raise SystemExit('Transfer checksum differs')
root = pathlib.Path.home() / '.local/share/disclaude/jupyter-patches' / '${digest}'
root.mkdir(parents=True, exist_ok=True)
if root.is_symlink(): raise SystemExit('Refuse a symlinked patch directory')
root.chmod(0o700)
artifact = root / 'nbmodel-repair.pyz'
if artifact.exists() or artifact.is_symlink():
    if artifact.is_symlink() or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != '${digest}': raise SystemExit('Cached artifact differs')
else:
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as stream:
        temporary = pathlib.Path(stream.name)
        stream.write(data)
    temporary.chmod(0o600)
    temporary.replace(artifact)
target_python = sys.executable
if ${options.python ? 'False' : 'True'}:
    target_python = None
    pid = os.getppid()
    for unused in range(20):
        try:
            proc = pathlib.Path('/proc') / str(pid)
            if proc.exists():
                args = proc.joinpath('cmdline').read_bytes().decode().strip('\\0').split('\\0')
                parent = int(next(line.split()[1] for line in proc.joinpath('status').read_text().splitlines() if line.startswith('PPid:')))
            else:
                record = subprocess.check_output(['ps', '-o', 'ppid=', '-o', 'command=', '-p', str(pid)], text=True).strip().split(None, 1)
                parent, args = int(record[0]), shlex.split(record[1])
            if any('jupyter' in pathlib.Path(arg).name.lower() for arg in args[:3]):
                for arg in args[:2]:
                    entry = pathlib.Path(arg)
                    if entry.is_absolute() and 'python' in entry.name.lower():
                        target_python = str(entry); break
                    if entry.is_absolute() and entry.is_file() and 'jupyter' in entry.name.lower():
                        with entry.open() as stream: header = stream.readline(1024)
                        words = shlex.split(header[2:]) if header.startswith('#!') else []
                        if words and pathlib.Path(words[0]).is_absolute() and 'python' in pathlib.Path(words[0]).name.lower():
                            target_python = words[0]; break
                if target_python: break
            if parent <= 1 or parent == pid: break
            pid = parent
        except (OSError, ValueError, StopIteration): break
if not target_python:
    print('${receipt}' + json.dumps({'ok': False, 'reason': 'Cannot discover the Jupyter Server interpreter; pass --python explicitly'}), flush=True)
    raise SystemExit(1)
result = subprocess.run([target_python, str(artifact)] + ${JSON.stringify(forwarded)}, capture_output=True, text=True)
value = {'ok': False, 'exit': result.returncode}
if result.returncode == 0:
    value = {'ok': True, 'result': json.loads(result.stdout.splitlines()[-1])}
print('${receipt}' + json.dumps(value), flush=True)
`;
  let socket;
  try {
    const bootstrap =
      "import base64,zlib;exec(zlib.decompress(base64.b64decode('" +
      deflateSync(Buffer.from(code)).toString('base64') +
      "')))";
    const command =
      'stty -echo; ' + quote(options.python || 'python3') + ' -u -c ' + quote(bootstrap) + '\r';
    if (Buffer.byteLength(command) > 3500)
      throw new Error('Terminal bootstrap exceeds PTY input limits; shorten target paths');
    const address = await client.socket('terminals/websocket/' + encodeURIComponent(terminal.name));
    socket = new WebSocket(address.url, { headers: address.headers });
    const result = await new Promise((done, fail) => {
      let output = '',
        sent = false,
        settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? fail(error) : done(value);
      };
      const timer = setTimeout(
        () =>
          finish(new Error('Jupyter terminal outcome unconfirmed; inspect status before retry')),
        45_000
      );
      socket.on('error', () => finish(new Error('Jupyter terminal connection failed')));
      socket.on('close', () =>
        finish(new Error('Jupyter terminal closed before a verified receipt'))
      );
      socket.on('open', () => socket.send(JSON.stringify(['stdin', command])));
      socket.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message[0] !== 'stdout' || typeof message[1] !== 'string' || settled) return;
          output += message[1];
          if (output.length > 100_000)
            throw new Error('Jupyter terminal output exceeded its limit');
          const lines = output.split(/\r?\n/);
          if (!sent && lines.some((line) => line.endsWith(ready))) {
            sent = true;
            const encoded = patch.bytes.toString('base64');
            // PTY canonical input lines have a size limit. Small lines plus a
            // handshake also prevent bytes being interpreted by the shell.
            for (let offset = 0; offset < encoded.length && !settled; offset += 1024) {
              socket.send(JSON.stringify(['stdin', encoded.slice(offset, offset + 1024) + '\n']));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            if (!settled) socket.send(JSON.stringify(['stdin', receipt + '\n']));
          }
          const line = lines
            .map((line) => line.slice(line.indexOf(receipt + '{')))
            .find((line) => line.startsWith(receipt + '{') && line.endsWith('}'));
          if (line) {
            const value = JSON.parse(line.slice(receipt.length));
            if (!value.ok)
              throw new Error(
                value.reason ||
                  `Remote patch command failed (exit ${value.exit}); inspect the private state before retry`
              );
            finish(null, {
              ...value.result,
              transport: 'jupyter-terminal',
              artifactSha256: digest,
            });
          }
        } catch (error) {
          finish(error);
        }
      });
    });
    return result;
  } finally {
    socket?.terminate();
    // Only the terminal returned by our own create operation is ours to close.
    await request('api/terminals/' + encodeURIComponent(terminal.name), 'DELETE');
  }
}
