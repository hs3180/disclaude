import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('browser harness worker diagnostics', () => {
  it('forwards supervised daemon stderr to the worker diagnostic pipe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-harness-worker-'));
    const fakePython = join(root, 'fake-python.mjs');
    writeFileSync(fakePython, `#!/usr/bin/env node
if (process.argv.includes('browser_harness.daemon')) {
  process.stderr.write('fixture daemon stderr\\n');
  setInterval(() => {}, 1000);
} else {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(1));
}
`, { mode: 0o700 });
    const worker = fork(new URL('./harness-worker.mjs', import.meta.url), [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', chunk => { stderr += chunk; });
    const daemonStarted = new Promise(resolve => worker.on('message', message => {
      if (message.kind === 'daemon-started') resolve();
    }));
    try {
      worker.send({
        kind: 'init',
        url: 'ws://fixture.invalid',
        target: 'fixture-target',
        options: { python: fakePython, cwd: root, runtime: join(root, 'runtime') },
      });
      await daemonStarted;
      for (let i = 0; i < 20 && !stderr.includes('fixture daemon stderr'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      worker.send({ kind: 'stop' });
      await once(worker, 'exit');
      expect(stderr).toContain('fixture daemon stderr');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
