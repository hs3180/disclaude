import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const docker = async (...args: string[]) => {
  try {
    return (await exec('docker', args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout?.slice(-8000) || ''}\n${failure.stderr?.slice(-8000) || ''}`);
  }
};

describe('browser-use CLI in the production service image', () => {
  it.skipIf(!process.env.DISCLAUDE_E2E_DOCKER_IMAGE || !process.env.DISCLAUDE_E2E_DOCKER_BROWSER_IMAGE)(
    'uses a separate Chromium container without starting Chrome in the service container', async () => {
      const suffix = randomUUID().slice(0, 8);
      const network = `dc-smoke-net-${suffix}`, service = `dc-smoke-app-${suffix}`, browser = `dc-smoke-browser-${suffix}`;
      let networkCreated = false, serviceCreated = false, browserCreated = false;
      try {
        await docker('network', 'create', network); networkCreated = true;
        // The production filesystem/runtime is used; this CLI diagnostic does
        // not start channels or connect an application to any external account.
        await docker('run', '-d', '--init', '--name', service, '--network', network,
          '--entrypoint', 'sleep', process.env.DISCLAUDE_E2E_DOCKER_IMAGE!, '600');
        serviceCreated = true;
        await docker('cp', resolve('scripts/browser-use-smoke.sh'), `${service}:/tmp/browser-use-smoke.sh`);
        const runtime = JSON.parse(await docker('exec', service, 'python3', '-c',
          "import json, os, importlib.metadata as m; print(json.dumps({'uid': os.getuid(), 'browserUse': m.version('browser-use'), 'browserHarness': m.version('browser-harness')}))")) as { uid: number; browserUse: string; browserHarness: string };
        expect(runtime.uid).toBe(1001);
        for (const headless of [false, true]) {
          await docker('run', '-d', '--init', '--name', browser, '--network', network,
            '--network-alias', 'browser', '--shm-size=2g', '--memory=4g',
            '-e', `CHROMIUM_HEADLESS=${headless ? 1 : 0}`,
            process.env.DISCLAUDE_E2E_DOCKER_BROWSER_IMAGE!);
          browserCreated = true;
          let ready = false;
          for (let i = 0; i < 80 && !ready; i++) {
            if (await docker('inspect', '-f', '{{.State.Running}}', browser) !== 'true') {
              throw new Error(`Browser exited: ${await docker('logs', browser)}`);
            }
            ready = await docker('exec', service, 'node', '-e',
              "fetch('http://browser:9222/json/version',{signal:AbortSignal.timeout(1000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))")
              .then(() => true, () => false);
            if (!ready) { await delay(250); }
          }
          expect(ready).toBe(true);
          const outputDir = `/tmp/browser-smoke-${headless ? 'headless' : 'headed'}`;
          const output = await docker('exec',
            '-e', 'SMOKE_CDP_URL=http://browser:9222', '-e', 'SMOKE_PYTHON=python3',
            '-e', 'SMOKE_ASSERT_PROCESS_COUNT=1', '-e', `SMOKE_OUT_DIR=${outputDir}`,
            service, 'bash', '/tmp/browser-use-smoke.sh');
          expect(output).toContain('result: 8 passed, 0 failed');
          expect(output).toContain('case 2b: no self-spawned Chrome (process count 0 unchanged)');
          expect(output).toContain('owned target removed before endpoint switch');
          expect(output).toContain('case 6: dead BU_CDP_URL fails hard');
          const png = await docker('exec', service, 'node', '-e',
            `console.log(require('fs').readFileSync(${JSON.stringify(`${outputDir}/smoke-shot.png`)}).subarray(0,8).toString('hex'))`);
          expect(png).toBe('89504e470d0a1a0a');
          console.info('DOCKER_BROWSER_SMOKE_ACCEPTANCE', JSON.stringify({
            mode: headless ? 'headless' : 'headed-Xvfb', passed: 8, ...runtime,
            serviceChromeProcesses: 0, targetCleanup: true, daemonCleanup: true, png: true,
          }));
          await docker('stop', '--time', '15', browser);
          expect(await docker('inspect', '-f', '{{.State.ExitCode}}', browser)).toBe('0');
          await docker('rm', browser); browserCreated = false;
        }
      } catch (error) {
        if (browserCreated) { console.error(await docker('logs', '--tail', '80', browser).catch(() => 'Browser logs unavailable')); }
        throw error;
      } finally {
        if (browserCreated) { await docker('rm', '-f', browser).catch(() => {}); }
        if (serviceCreated) { await docker('rm', '-f', service).catch(() => {}); }
        if (networkCreated) { await docker('network', 'rm', network).catch(() => {}); }
      }
    }, 360_000,
  );
});
