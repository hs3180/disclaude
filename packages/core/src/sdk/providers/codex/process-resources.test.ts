import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readProcessGroupResources } from './process-resources.js';

describe('owned process group accounting', () => {
  it.skipIf(process.platform === 'win32')('measures a real owned group without leaking argv and observes reclamation', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)', 'synthetic-secret-argument'], {
      detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const closed = once(child, 'close');
    try {
      await once(child.stdout!, 'data');
      const sample = await readProcessGroupResources(child.pid!);
      expect(sample).toMatchObject({ available: true, processCount: 1 });
      expect(sample.rssKiB).toBeGreaterThan(0);
      expect(sample.oldestAgeSeconds).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(sample)).not.toContain('synthetic-secret-argument');
      child.kill('SIGKILL');
      await closed;
      expect(await readProcessGroupResources(child.pid!)).toMatchObject({ available: true, processCount: 0, rssKiB: 0 });
    } finally {child.kill('SIGKILL'); await closed;}
  });
  it('reports unavailable accounting for invalid group identifiers', async () => {
    expect(await readProcessGroupResources(-1)).toEqual({ groupId: -1, available: false });
  });
});
