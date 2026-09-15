import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export interface BrowserRuntime {
  stop(): Promise<void>;
  readonly pid: number | undefined;
}

/** Fail startup before any agent can run if coordinated mode has no usable broker. */
export async function startBrowserRuntime(
  env: NodeJS.ProcessEnv = process.env,
  onUnavailable: (message: string) => void = () => {},
  entry = new URL('./service.mjs', import.meta.url),
): Promise<BrowserRuntime | undefined> {
  if (env.DISCLAUDE_BROWSER_MODE !== 'coordinated') { return undefined; }
  const socket = env.DISCLAUDE_BROWSER_SOCKET;
  if (!socket || !isAbsolute(socket) || Buffer.byteLength(socket) > 95) {
    throw new Error('Coordinated browser mode requires an absolute DISCLAUDE_BROWSER_SOCKET (at most 95 bytes)');
  }
  if (Boolean(env.BU_CDP_URL) === Boolean(env.DISCLAUDE_CHROMIUM_BINARY)) {
    throw new Error('Configure either an existing automation browser URL or a dedicated Chromium binary/profile');
  }
  const child: ChildProcess = fork(entry, [], { env: { ...env, DISCLAUDE_BROWSER_SUPERVISED: '1' }, silent: true });
  let stopping = false;
  let startup = true;
  let stderr = '';
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdout?.resume();
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.on('error', () => {});
  child.on('close', () => {
    if (!stopping && !startup) { onUnavailable('Browser coordinator exited; browser requests will fail until the service is restarted.'); }
  });
  const runtime: BrowserRuntime = {
    get pid() { return child.pid; },
    async stop() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) { return; }
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { clearTimeout(timer); child.off('message', message); child.off('error', fail); child.off('close', closed); };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const closed = (): void => fail(new Error(`Browser coordinator failed before readiness: ${stderr || 'process exited'}`));
      const message = (value: unknown): void => {
        const ready = value as { ready?: boolean; socket?: string } | undefined;
        if (ready?.ready === true && ready.socket === socket) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => fail(new Error('Browser coordinator readiness timed out')), 45_000);
      child.on('message', message); child.once('error', fail); child.once('close', closed);
    });
    if (child.exitCode !== null || child.signalCode !== null) { throw new Error('Browser coordinator exited during startup'); }
    // This launcher is host-owned and cannot recursively launch the upstream daemon.
    const bin = join(dirname(socket), 'bin');
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    writeFileSync(join(bin, 'browser-use'),
      `#!/usr/bin/env node\nimport(${JSON.stringify(new URL('./client.mjs', import.meta.url).href)}).then(m => m.main()).catch(e => { console.error(e.message); process.exitCode = 1; });\n`,
      { mode: 0o700 });
    // Published only after broker readiness; every harness applies this after env merges.
    env.DISCLAUDE_BROWSER_BIN = bin;
    startup = false;
    return runtime;
  } catch (error) { await runtime.stop(); throw error; }
}
