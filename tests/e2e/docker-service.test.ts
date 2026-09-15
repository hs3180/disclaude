import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec('docker', args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();

describe('production Docker service image', () => {
  it.skipIf(!process.env.DISCLAUDE_E2E_DOCKER_IMAGE)('starts, initializes both dsh profiles, preserves uploaded files across recreation, and stops cleanly', async () => {
    const image = process.env.DISCLAUDE_E2E_DOCKER_IMAGE!;
    const suffix = randomUUID().slice(0, 8);
    const container = `disclaude-e2e-${suffix}`, volume = `disclaude-e2e-data-${suffix}`;
    const token = randomUUID();
    let createdVolume = false, createdContainer = false;
    const config = {
      agent: { agentBackend: 'deepseek', provider: 'anthropic', model: 'deepseek-flash' },
      deepseek: { apiKey: 'offline-container-test-placeholder', mode: 'standard' },
      workspace: { dir: '/data/workspace' },
      channels: { feishu: { enabled: false }, rest: { enabled: true, host: '127.0.0.1', port: 13000, fileStorageDir: '/data/workspace/files' } },
      logging: { level: 'info' },
    };
    const inside = (code: string) => docker('exec', container, 'node', '--input-type=module', '-e', code);
    const dataOperation = (code: string) => docker('run', '--rm', '--entrypoint', 'node', '-v', `${volume}:/data`, image, '--input-type=module', '-e', code);
    const request = async (port: number, path: string, method = 'GET', body?: unknown, authenticated = false) => {
      const options = { method, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      return JSON.parse(await inside(`const r = await fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)}, ${JSON.stringify(options)}); console.log(JSON.stringify({status:r.status,body:await r.json()}));`)) as { status: number; body: Record<string, unknown> };
    };
    try {
      await docker('volume', 'create', volume); createdVolume = true;
      await dataOperation(`import fs from 'node:fs'; fs.writeFileSync('/data/config.json', ${JSON.stringify(JSON.stringify(config))}); fs.writeFileSync('/data/workspace/keep.txt', 'workspace retained'); fs.writeFileSync('/data/codex/keep.txt', 'codex retained');`);
      let fileId = '';
      const content = Buffer.from('container recreation must preserve this uploaded file').toString('base64');
      for (let attempt = 0; attempt < 2; attempt++) {
        await docker('run', '-d', '--name', container, '--health-interval=1s', '--health-start-period=1s', '--health-retries=5',
          '-v', `${volume}:/data`, '-e', 'DISCLAUDE_CONFIG_PATH=/data/config.json', '-e', 'LOCKFILE_PATH=/data/service.pid',
          image, 'disclaude', 'start', '--api-port', '19200', '--api-token', token);
        createdContainer = true;
        let ready = false;
        for (let i = 0; i < 80 && !ready; i++) {
          const state = JSON.parse(await docker('inspect', '--format', '{{json .State}}', container)) as { Running: boolean; Health?: { Status: string } };
          if (!state.Running) { throw new Error(`Service exited before readiness: ${await docker('logs', '--tail', '80', container)}`); }
          try { ready = state.Health?.Status === 'healthy' && (await request(19200, '/api/status')).body.status === 'ok'; } catch { /* Wait for actual API readiness. */ }
          if (!ready) { await delay(500); }
        }
        expect(ready, await docker('logs', '--tail', '30', container)).toBe(true);
        expect((await request(13000, '/api/health')).body.status).toBe('ok');
        expect((await request(19200, '/api/send-message', 'POST', {})).status).toBe(401);
        expect((await request(19200, '/api/send-message', 'POST', {}, true)).status).toBe(400);
        const runtime = JSON.parse(await inside(`import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; const pkg=JSON.parse(fs.readFileSync('/app/package.json')); console.log(JSON.stringify({uid:process.getuid(),node:process.version,bin:Object.keys(pkg.bin),legacy:fs.existsSync('/app/packages/primary-node'),dsh:execFileSync('dsh',['--version'],{encoding:'utf8'}).trim(),codex:execFileSync('codex',['--version'],{encoding:'utf8'}).trim()}));`)) as { uid: number; node: string; bin: string[]; legacy: boolean; dsh: string; codex: string };
        expect(runtime.uid).toBe(1001); expect(runtime.node).toMatch(/^v22\./u);
        expect(runtime.bin).toEqual(['disclaude']); expect(runtime.legacy).toBe(false);
        expect(runtime.dsh).toContain('0.1.2'); expect(runtime.codex).toContain('codex-cli');
        if (attempt === 0) {
          // Real SDK initialization, without a model prompt or external credentials.
          for (const profile of ['sdk', 'sdk-minimal']) {
            const initialized = await inside(`import {DshStdioTransport} from '/app/packages/core/dist/sdk/providers/deepseek/dsh-transport.js'; const t=new DshStdioTransport({args:['--profile',${JSON.stringify(profile)}],cwd:'/data/workspace',env:{...process.env,DEEPSEEK_API_KEY:'offline-container-test-placeholder'},requestTimeoutMs:20000}); try {await t.request('initialize',{cwd:'/data/workspace',provider:'deepseek-official',model:'deepseek-flash'}); console.log('INITIALIZED');} finally {t.close();}`);
            expect(initialized).toContain('INITIALIZED');
          }
          const uploaded = await request(13000, '/api/files/upload', 'POST', { fileName: 'retained.txt', content, mimeType: 'text/plain', chatId: 'docker-e2e-chat' });
          expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200); expect(uploaded.body.success).toBe(true);
          fileId = (uploaded.body.file as { id: string }).id;
          expect(fileId).toBeTruthy();
        }
        const downloaded = await request(13000, `/api/files/${fileId}/download`);
        expect(downloaded.status).toBe(200); expect(downloaded.body.content).toBe(content);
        expect(await inside(`import fs from 'node:fs'; console.log(fs.readFileSync('/data/workspace/keep.txt','utf8')+' / '+fs.readFileSync('/data/codex/keep.txt','utf8'));`)).toBe('workspace retained / codex retained');
        await docker('stop', '--time', '20', container);
        expect(Number(await docker('inspect', '--format', '{{.State.ExitCode}}', container))).toBe(0);
        await docker('rm', container); createdContainer = false;
        expect(await dataOperation(`import fs from 'node:fs'; console.log(fs.existsSync('/data/service.pid'));`)).toBe('false');
        if (attempt === 0) {
          await dataOperation(`import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync('/data/config.json')); c.deepseek.mode='minimal'; fs.writeFileSync('/data/config.json',JSON.stringify(c));`);
        }
        console.info('DOCKER_SERVICE_ACCEPTANCE', JSON.stringify({ attempt, mode: attempt ? 'minimal' : 'standard', ...runtime, uploadRetained: true, cleanExit: true }));
      }
    } catch (error) {
      if (createdContainer) { console.error(await docker('logs', '--tail', '100', container).catch(() => 'Container logs unavailable')); }
      throw error;
    } finally {
      if (createdContainer) { await docker('rm', '-f', container).catch(() => {}); }
      if (createdVolume) { await docker('volume', 'rm', volume).catch(() => {}); }
    }
  }, 240_000);
});
