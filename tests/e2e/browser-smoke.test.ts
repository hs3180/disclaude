import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser } from '../../packages/service/src/browser-control/managed-browser.mjs';
import { connect } from '../../packages/service/src/browser-control/cdp.mjs';

const exec = promisify(execFile);
const binary = process.env.DISCLAUDE_E2E_CHROMIUM;
const python = process.env.DISCLAUDE_E2E_BROWSER_PYTHON;

describe('standalone browser-use diagnostic CLI', () => {
  it.skipIf(!binary || !python)('attaches to an owned target, captures a PNG and rejects a cold dead endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-browser-smoke-'));
    let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
    nock.enableNetConnect(host => /^(127\.0\.0\.1|localhost)(:|$)/.test(host));
    try {
      browser = await launchBrowser({ binary: binary!, profile: join(root, 'profile'), headless: true, signal: undefined });
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
      try {
        if (browser) {
          // stop({ graceful: true }) only waits for an already-requested exit.
          // Ask Chromium to flush and close before waiting or sending signals.
          let client: Awaited<ReturnType<typeof connect>> | undefined;
          try {
            const response = await fetch(`${browser.endpoint}/json/version`, {
              signal: AbortSignal.timeout(3000),
            });
            const info = await response.json() as { webSocketDebuggerUrl: string };
            client = await connect(info.webSocketDebuggerUrl);
            await client.call('Browser.close').catch(() => {});
          } catch {
            // A failed test may already have stopped the browser; use the owned
            // child termination fallback below, never kill by process name.
          } finally {
            try {
              await client?.close();
            } finally {
              await browser.stop({ graceful: true });
            }
          }
          expect(browser.child.exitCode !== null || browser.child.signalCode !== null).toBe(true);
        }
        // Chromium helpers can finish profile writes shortly after parent exit.
        // Retry transient directory contention, but report any final failure.
        try {
          await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
          throw new Error(`Browser smoke cleanup failed; temporary files remain at ${root}`, { cause: error });
        }
        await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        console.info('BROWSER_SMOKE_CLEANUP', JSON.stringify({ rootRemoved: true, browserExited: true }));
      } finally {
        nock.enableNetConnect('localhost');
      }
    }
  }, 180_000);
});
