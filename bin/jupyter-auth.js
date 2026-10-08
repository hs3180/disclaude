/** Host-only Jupyter credentials from environment, .env or a private TTY prompt. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { parse as parseEnv } from 'dotenv';

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
    throw new Error('Jupyter URL must be HTTP(S), without credentials, query or fragment');
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
    throw new Error('Jupyter credential is empty, too long or contains control characters');
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
  } = {}
) {
  if (options.interactive === true && (!input.isTTY || !output.isTTY)) {
    throw new Error('Interactive Jupyter authentication requires a TTY on stdin and stderr');
  }
  let file = {},
    contents;
  try {
    contents = readFileSync(options.envFile || resolve(cwd, '.env'), 'utf8');
  } catch (error) {
    if (options.envFile || error.code !== 'ENOENT') {
      throw new Error('Host-private Jupyter environment file could not be read');
    }
  }
  if (contents !== undefined) {
    try {
      // Use parse only: config() would mutate process.env and may print values.
      file = parseEnv(contents);
    } catch {
      throw new Error('Host-private Jupyter environment file could not be parsed');
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
  const ask = (label, hidden = false) => {
    if (options.interactive === false || !input.isTTY || !output.isTTY) {
      throw new Error(
        'Jupyter URL/authentication is missing; configure .env/environment variables or use --interactive in a TTY'
      );
    }
    return prompt(label, { hidden, input, output });
  };
  if (!baseUrl) baseUrl = (await ask('Jupyter URL (without credentials): ')).trim();
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
  }
  return { baseUrl, mode, secret: validateSecret(secret, mode) };
}
