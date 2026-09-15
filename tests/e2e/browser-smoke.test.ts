import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser } from '../../packages/service/src/browser-control/managed-browser.mjs';

const exec = promisify(execFile);
const binary = process.env.DISCLAUDE_E2E_CHROMIUM;
const python = process.env.DISCLAUDE_E2E_BROWSER_PYTHON;

describe('standalone browser-use diagnostic CLI', () => {
  it.skipIf(!binary || !python)('attaches to an owned target, captures a PNG and rejects a cold dead endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-browser-smoke-'));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    nock.enableNetConnect(host => /^(127\.0\.0\.1|localhost)(:|$)/.test(host));
    try {
      browser = await launchBrowser({ binary: binary!, profile: join(root, 'profile'), headless: true });
      const env: NodeJS.ProcessEnv = { ...process.env,
        PATH: `${dirname(python!)}:${process.env.PATH || ''}`,
        SMOKE_PYTHON: python, SMOKE_CDP_URL: browser.endpoint,
        SMOKE_OUT_DIR: join(root, 'artifacts'), SMOKE_ASSERT_PROCESS_COUNT: '0',
      };
      // This diagnostic owns a separate daemon; it is not an Agent IPC invocation.
      delete env.BH_REQUIRE_EXISTING_DAEMON;
      const { stdout } = await exec('bash', [resolve('scripts/browser-use-smoke.sh')], {
        cwd: root, env, timeout: 150_000, maxBuffer: 1024 * 1024,
      });
      expect(stdout).toContain('result: 7 passed, 0 failed');
      expect(stdout).toContain('owned target removed before endpoint switch');
      expect(stdout).toContain('case 6: dead BU_CDP_URL fails hard');
      const png = await readFile(join(root, 'artifacts/smoke-shot.png'));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      console.info('BROWSER_SMOKE_ACCEPTANCE', JSON.stringify({ platform: process.platform,
        arch: process.arch, passed: 7, processCount: 'skipped: browser runs on the same host',
        targetCleanup: true, coldEndpointRefused: true, daemonCleanup: true }));
    } finally {
      await browser?.stop({ graceful: true });
      await rm(root, { recursive: true, force: true });
      nock.enableNetConnect('localhost');
    }
  }, 180_000);
});
