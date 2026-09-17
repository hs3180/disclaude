import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exists = path => stat(path).then(() => true, () => false);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

test('foreground test ownership: failures, signals, live peers and orphan reaping', { skip: process.platform === 'win32', timeout: 45_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'owned-test-acceptance-'));
  const registry = join(base, `disclaude-owned-tests-v1-${process.getuid()}`);
  const children = [];
  function launch(code, keep = false) {
    const child = spawn(process.execPath, [resolve('scripts/run-isolated-test.mjs'), ...(keep ? ['--keep-temp'] : []), '--', process.execPath, '-e', code], {
      env: { ...process.env, TMPDIR: base, TMP: base, TEMP: base }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run = { child, output: '', exit: undefined };
    child.stdout.on('data', data => { run.output += data; });
    child.stderr.on('data', data => { run.output += data; });
    run.done = new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { run.exit = { code, signal }; done(run.exit); });
    });
    children.push(run);
    return run;
  }
  async function waitFor(run, text) {
    const deadline = Date.now() + 10_000;
    while (!run.output.includes(text) && !run.exit && Date.now() < deadline) await delay(20);
    assert(run.output.includes(text), run.output);
  }
  const rootOf = run => run.output.match(/^OWNED_TEST_ROOT (.+)$/m)?.[1];
  try {
    for (const code of [0, 2]) {
      const run = launch(`require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(),'artifact'),'fixture');process.exit(${code})`);
      assert.equal((await run.done).code, code, run.output);
      assert.match(run.output, /OWNED_TEST_CLEANUP_OK/);
      assert.equal(await exists(rootOf(run)), false);
    }
    const userWorkspace = join(base, 'user-workspace');
    await mkdir(userWorkspace);
    await writeFile(join(userWorkspace, 'sentinel'), 'preserve user files');
    await symlink(userWorkspace, join(registry, 'run-symlink'));
    await mkdir(join(registry, 'run-unregistered'));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const run = launch('console.log("FIXTURE_READY");setInterval(()=>{},1000)');
      await waitFor(run, 'FIXTURE_READY');
      // A simultaneous run must not reap this active owner's files.
      const peer = launch('process.exit(0)');
      assert.equal((await peer.done).code, 0, peer.output);
      assert.equal(await exists(rootOf(run)), true);
      run.child.kill(signal);
      assert.equal((await run.done).code, code, run.output);
      assert.equal(await exists(rootOf(run)), false);
    }
    const orphan = launch('console.log("FIXTURE_READY");setTimeout(()=>{},2500)');
    await waitFor(orphan, 'FIXTURE_READY');
    const root = rootOf(orphan);
    orphan.child.kill('SIGKILL');
    // The fixture inherits output pipes, so close intentionally waits for it.
    const peer = launch('process.exit(0)');
    assert.equal((await peer.done).code, 0, peer.output);
    assert.equal(await exists(root), true, 'Live orphan must not be reaped');
    await orphan.done;
    const reap = launch('process.exit(0)');
    assert.equal((await reap.done).code, 0, reap.output);
    assert.match(reap.output, /OWNED_TEST_REAPED/);
    assert.equal(await exists(root), false);
    const kept = launch('process.exit(0)', true);
    assert.equal((await kept.done).code, 0, kept.output);
    const keptRoot = rootOf(kept);
    const skip = launch('process.exit(0)');
    assert.equal((await skip.done).code, 0);
    assert.equal(await exists(keptRoot), true, 'Explicit retention must survive reaping');
    const owner = JSON.parse(await readFile(join(keptRoot, 'owner.json'), 'utf8'));
    assert.equal(alive(-owner.pgid), false);
    await rm(keptRoot, { recursive: true });
    assert.equal(await readFile(join(userWorkspace, 'sentinel'), 'utf8'), 'preserve user files');
    assert.equal(await exists(join(registry, 'run-unregistered')), true);
    // Only the fixture owner removes these deliberately unregistered paths.
    await rm(join(registry, 'run-symlink'));
    await rm(join(registry, 'run-unregistered'), { recursive: true });
    assert.deepEqual(await readdir(registry), []);
  } finally {
    for (const run of children) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
    }
    await Promise.race([Promise.allSettled(children.map(run => run.done)), delay(17_000, undefined, { ref: false })]);
    let safe = true;
    for (const name of await readdir(registry).catch(() => [])) {
      try {
        const owner = JSON.parse(await readFile(join(registry, name, 'owner.json'), 'utf8'));
        if (alive(owner.pid) || alive(-owner.pgid)) safe = false;
      } catch { safe = false; }
    }
    if (safe) await rm(base, { recursive: true, force: true });
    else {
      console.error(`Owned-test acceptance files retained at ${base}: termination unconfirmed`);
      for (const run of children) { run.child.unref(); run.child.stdout.destroy(); run.child.stderr.destroy(); }
    }
  }
});
