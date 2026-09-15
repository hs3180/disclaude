import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transitionChromium } from '../scripts/launchd.mjs';

describe('browser service replacement failure recovery', () => {
  it.each([true, false])('restores files and only restarts a previously loaded service: %s', async wasLoaded => {
    const root = mkdtempSync(join(tmpdir(), 'dc-transition-'));
    const config = join(root, 'config');
    const plist = join(root, 'plist');
    writeFileSync(config, 'previous');
    const events: string[] = [];
    try {
      await expect(transitionChromium({ paths: [config, plist], wasLoaded,
        prepare() { writeFileSync(config, 'candidate'); writeFileSync(plist, 'new'); },
        stop() { events.push('stop'); }, start() { events.push('start'); },
        verify() { throw new Error('CDP unavailable'); },
        verifyPrevious() { events.push('previous healthy'); expect(readFileSync(config, 'utf8')).toBe('previous'); },
      })).rejects.toThrow(wasLoaded ? 'previous service restored and verified' : 'previous configuration preserved');
      expect(readFileSync(config, 'utf8')).toBe('previous');
      expect(existsSync(plist)).toBe(false);
      expect(events).toEqual(wasLoaded ? ['stop', 'start', 'stop', 'start', 'previous healthy'] : ['start', 'stop']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves the running service when preparing the replacement fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-transition-'));
    const config = join(root, 'config');
    writeFileSync(config, 'previous');
    const unexpected = () => { throw new Error('must not touch running service'); };
    try {
      await expect(transitionChromium({ paths: [config], wasLoaded: true,
        prepare() { writeFileSync(config, 'partial'); throw new Error('plist write failed'); },
        stop: unexpected, start: unexpected, verify: unexpected, verifyPrevious: unexpected,
      })).rejects.toThrow('plist write failed; previous configuration preserved');
      expect(readFileSync(config, 'utf8')).toBe('previous');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports failed rollback verification instead of claiming the old service is healthy', async () => {
    await expect(transitionChromium({ paths: [], wasLoaded: true,
      prepare() {}, stop() {}, start() {}, verify() { throw new Error('candidate failed'); },
      verifyPrevious() { throw new Error('old CDP also unavailable'); },
    })).rejects.toThrow('candidate failed; recovery incomplete: old CDP also unavailable');
  });
});
