/** Host-only Jupyter credentials from environment, .env or a private TTY prompt. */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { parse as parseEnv } from 'dotenv';

// Patch/test commands use this module before the TypeScript packages are built.
// These diagnostics contain only host-selected messages, never credential values.
export class JupyterAuthError extends Error {
  constructor(diagnostic) {
    super(diagnostic.message);
    this.name = 'JupyterAuthError';
    this.diagnostic = diagnostic;
  }
}

function workspaceRoot(directory) {
  let current = resolve(directory);
  for (let depth = 0; depth < 64; depth++) {
    try { if (statSync(join(current, '.disclaude', 'project-bindings.json')).isFile()) return current; }
    catch { /* No workspace binding marker at this level. */ }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function jupyterEnvCandidates(options, { cwd = process.cwd(), environment = process.env } = {}) {
  if (options.envFile) return [resolve(cwd, options.envFile)];
  const project = resolve(cwd, options.projectDir || cwd);
  const workspace = workspaceRoot(project) || workspaceRoot(cwd);
  return [...new Set([resolve(cwd, '.env'), resolve(project, '.env'),
    ...(workspace ? [join(workspace, '.env')] : []),
    ...(environment.DISCLAUDE_WORKSPACE_DIR ? [resolve(cwd, environment.DISCLAUDE_WORKSPACE_DIR, '.env')] : [])])];
}

function validateUrl(value) {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new JupyterAuthError({ layer: 'schema', code: 'invalid_endpoint', phase: 'credentials',
      message: 'Jupyter URL must be HTTP(S), without credentials, query or fragment',
      hint: 'Use a remote endpoint in JUPYTERLAB_HOST or --jupyter; keep credentials in their separate environment keys.' });
  }
  return value;
}

function validateSecret(value, mode) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > (mode === 'token' ? 8186 : 8192) ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new JupyterAuthError({ layer: 'auth', code: 'invalid_credential', phase: 'credentials',
      message: 'Jupyter credential is empty, too long or contains control characters',
      hint: 'Check the host-owned credential value without printing it.' });
  return value;
}

export function promptJupyterValue(
  label,
  { hidden = false, input = process.stdin, output = process.stderr } = {}
) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Interactive Jupyter authentication requires a TTY on stdin and stderr');
  }
  // Raw mode disables the terminal driver's echo before the prompt is displayed.
  // Only visible fields are ever written; secret characters have no output path.
  return new Promise((done, fail) => {
    const wasRaw = !!input.isRaw,
      wasFlowing = input.readableFlowing === true;
    let characters = [],
      settled = false;
    const cancel = () => finish(new Error('Jupyter authentication input cancelled'));
    const unavailable = () => finish(new Error('Jupyter authentication input closed'));
    function finish(error) {
      if (settled) return;
      settled = true;
      input.removeListener('keypress', onKey);
      input.removeListener('end', unavailable);
      input.removeListener('error', unavailable);
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      try {
        input.setRawMode(wasRaw);
        if (!wasFlowing) input.pause();
        output.write('\n');
      } catch {
        error = new Error('Jupyter authentication terminal could not be restored');
      }
      const value = characters.join('');
      characters = [];
      error ? fail(error) : done(value);
    }
    function onKey(text, key = {}) {
      if (key.ctrl && ['c', 'd'].includes(key.name)) return cancel();
      if (['return', 'enter'].includes(key.name)) return finish();
      if (key.name === 'backspace') {
        if (characters.pop() !== undefined && !hidden) output.write('\b \b');
        return;
      }
      if (key.ctrl && key.name === 'u') {
        if (!hidden) output.write('\b \b'.repeat(characters.length));
        characters = [];
        return;
      }
      if (!text || key.ctrl || key.meta || /[\u0000-\u001f\u007f]/.test(text)) return;
      if (characters.join('').length + text.length > 8192) {
        return finish(new Error('Jupyter authentication input exceeds the length limit'));
      }
      characters.push(text);
      if (!hidden) output.write(text);
    }
    try {
      input.setRawMode(true);
      emitKeypressEvents(input);
      input.on('keypress', onKey);
      input.once('end', unavailable);
      input.once('error', unavailable);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      input.resume();
      output.write(label);
    } catch {
      finish(new Error('Jupyter authentication terminal is unavailable'));
    }
  });
}

export async function resolveJupyterAuth(
  options,
  {
    environment = process.env,
    cwd = process.cwd(),
    input = process.stdin,
    output = process.stderr,
    prompt = promptJupyterValue,
    onDiscovery = () => {},
  } = {}
) {
  if (options.interactive === true && (!input.isTTY || !output.isTTY)) {
    throw new Error('Interactive Jupyter authentication requires a TTY on stdin and stderr');
  }
  let file = {}, selectedFile;
  const checkedFiles = [];
  const observe = details => {
    try { onDiscovery({ phase: 'credentials', checkedFiles: [...checkedFiles],
      ...(selectedFile ? { envFile: selectedFile } : {}), ...details }); }
    catch { /* A diagnostic observer cannot change credential selection. */ }
  };
  for (const candidate of jupyterEnvCandidates(options, { cwd, environment })) {
    checkedFiles.push(candidate);
    let contents;
    try { contents = readFileSync(candidate, 'utf8'); }
    catch (error) {
      if (!options.envFile && error.code === 'ENOENT') continue;
      observe({ state: 'unresolved' });
      throw new JupyterAuthError({ layer: 'auth', code: 'env_file_unreadable', phase: 'credentials',
        message: 'Host-private Jupyter environment file could not be read',
        hint: 'Check the selected env-file path and host file permissions; no alternative credential source was selected.' });
    }
    // Parse only: config() would mutate process.env and may print private values.
    const parsed = parseEnv(contents);
    const names = ['JUPYTERLAB_HOST', 'JUPYTERLAB_PASS', 'JUPYTERLAB_TOKEN', options.passwordEnv, options.tokenEnv].filter(Boolean);
    if (options.envFile || names.some(name => Object.hasOwn(parsed, name))) {
      file = parsed; selectedFile = candidate; break;
    }
  }
  const configured = { ...file, ...environment };
  let baseUrl = options.jupyter === 'configured' ? configured.JUPYTERLAB_HOST : options.jupyter;
  const candidates = options.tokenEnv
    ? [{ mode: 'token', key: options.tokenEnv }]
    : options.passwordEnv
      ? [{ mode: 'password', key: options.passwordEnv }]
      : [
          { mode: 'password', key: 'JUPYTERLAB_PASS' },
          { mode: 'token', key: 'JUPYTERLAB_TOKEN' },
        ];
  // Prefer actual environment credentials across both modes, then file values.
  // Explicitly empty environment values also mask the same key in the file.
  const selected =
    candidates.find(({ key }) => environment[key]) || candidates.find(({ key }) => configured[key]);
  let mode = selected?.mode,
    secret = selected && configured[selected.key];
  const sources = { endpointSource: options.jupyter !== 'configured' ? 'explicit'
    : Object.hasOwn(environment, 'JUPYTERLAB_HOST') ? 'environment' : 'env-file',
    credentialSource: selected && environment[selected.key] ? 'environment' : selected ? 'env-file' : 'unresolved' };
  observe({ ...sources, mode, state: baseUrl && secret ? 'configured' : 'unresolved', authentication: 'not_checked' });
  const ask = (label, hidden = false) => {
    if (options.interactive === false || !input.isTTY || !output.isTTY) {
      throw new JupyterAuthError({ layer: 'auth', code: 'credentials_missing', phase: 'credentials',
        message: 'Jupyter URL/authentication is missing; configure .env/environment variables or use --interactive in a TTY',
        hint: selectedFile ? 'The selected env file/environment lacks the endpoint or credential. Check JUPYTERLAB_HOST and the password/token key.'
          : 'No Jupyter credentials were found in the known env-file locations or environment. Configure the workspace .env, use --env-file, or use --interactive in a TTY.' });
    }
    return prompt(label, { hidden, input, output });
  };
  if (!baseUrl) { baseUrl = (await ask('Jupyter URL (without credentials): ')).trim(); sources.endpointSource = 'interactive'; }
  baseUrl = validateUrl(baseUrl);
  if (!secret || options.interactive === true) {
    if (options.passwordEnv || options.tokenEnv) mode = candidates[0].mode;
    else {
      const defaultMode = mode || 'password';
      mode =
        (await ask(`Authentication [password/token] (${defaultMode}): `)).trim().toLowerCase() ||
        defaultMode;
      if (!['password', 'token'].includes(mode))
        throw new Error('Choose password or token authentication');
    }
    secret = await ask(
      mode === 'token' ? 'Jupyter API token (hidden): ' : 'Jupyter password (hidden): ',
      true
    );
    sources.credentialSource = 'interactive';
  }
  secret = validateSecret(secret, mode);
  observe({ ...sources, mode, state: 'configured', authentication: 'not_checked' });
  return { baseUrl, mode, secret };
}
