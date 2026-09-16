import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { captureDescendantGroups, signalDescendantGroups } from './owned-descendants.js';

it.skipIf(process.platform === 'win32')('checks captured identity and leaves other process groups untouched', async () => {
  const start = () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { child, ready: once(child.stdout!, 'data'), closed: once(child, 'close') };
  };
  const owned = start(), other = start();
  try {
    await Promise.all([owned.ready, other.ready]);
    const groups = (await captureDescendantGroups(process.pid)).filter(group => group.pid === owned.child.pid);
    expect(groups).toHaveLength(1);
    await signalDescendantGroups([{ ...groups[0], started: 'different process lifetime' }], 'SIGKILL');
    expect(() => process.kill(owned.child.pid!, 0)).not.toThrow();
    await signalDescendantGroups(groups, 'SIGTERM');
    await owned.closed;
    expect(() => process.kill(owned.child.pid!, 0)).toThrow();
    expect(() => process.kill(other.child.pid!, 0)).not.toThrow();
  } finally {
    owned.child.kill('SIGKILL'); other.child.kill('SIGKILL');
    await Promise.all([owned.closed, other.closed]);
  }
});
