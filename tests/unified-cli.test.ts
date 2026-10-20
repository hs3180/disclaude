import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('channel CLI with inherited service logging', () => {
  it('uses the running distribution even when PATH selects another release and its path contains quotes', () => {
    const root = mkdtempSync(join(tmpdir(), "disclaude candidate's install-"));
    try {
      const helperDir = join(root, 'packages/service/dist/messaging');
      mkdirSync(helperDir, { recursive: true }); mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'package.json'), '{"name":"disclaude","type":"module"}');
      copyFileSync(fileURLToPath(new URL('../packages/service/dist/messaging/channel-cli-invocation.js', import.meta.url)), join(helperDir, 'channel-cli-invocation.js'));
      writeFileSync(join(root, 'bin/disclaude.js'), 'console.log(JSON.stringify({args:process.argv.slice(2)}));');
      const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        import { execFileSync } from 'node:child_process';
        const { runningChannelCliInvocation } = await import(pathToFileURL(${JSON.stringify(join(helperDir, 'channel-cli-invocation.js'))}).href);
        process.stdout.write(execFileSync('/bin/sh', ['-c', runningChannelCliInvocation() + ' help'], { env: { ...process.env, PATH: '/no-global-cli' } }));
      `], { encoding: 'utf8', timeout: 10000 });
      expect(JSON.parse(result).args).toEqual(['channel', 'help']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('can show help, preview and upload a file when the inherited log destination is inaccessible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-cli-log-permissions-'));
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) { body += String(chunk); }
      requests.push({ url: req.url ?? '', body: body ? JSON.parse(body) as Record<string, unknown> : {}, authorization: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/ping' ? { pong: true } : { ok: true, success: true, fileName: 'probe.txt', fileSize: 5 }));
    });
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const blocked = join(root, 'log-path-is-a-file');
      writeFileSync(blocked, 'Not a writable directory');
      const file = join(root, 'probe.txt'); writeFileSync(file, 'probe');
      const config = join(root, 'config.json');
      writeFileSync(config, JSON.stringify({ workspace: { dir: root }, channels: { feishu: { enabled: false } } }));
      const cliEnv = { ...process.env, NODE_ENV: 'production', LOG_TO_FILE: 'true', LOG_DIR: blocked, LOG_LEVEL: 'info',
        ['DISCLAUDE_CONFIG_PATH']: config, ['DISCLAUDE_WORKSPACE_DIR']: root,
        ['DISCLAUDE_API_BASE_URL']: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ['DISCLAUDE_API_TOKEN']: 'offline-test-token' };
      const invoke = async (entry: string, args: string[]) => {
        const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        const [code] = await once(child, 'close');
        expect(code, stderr).toBe(0);
        expect(stderr).not.toMatch(/EACCES|EPERM|ENOTDIR|setupSyncFilePassthrough/);
        return stdout;
      };
      const cli = fileURLToPath(new URL('../bin/disclaude.js', import.meta.url));
      const direct = fileURLToPath(new URL('../packages/channel-cli/dist/cli.js', import.meta.url));
      expect(await invoke(cli, ['channel', 'help'])).toContain('Usage:');
      expect(await invoke(direct, ['send_file', '--help'])).toContain('--file');
      const args = ['send_file', '--chat', 'probe@im.wechat', '--file', file];
      expect(JSON.parse(await invoke(cli, ['channel', ...args, '--dry-run']))).toMatchObject({ ok: true, dryRun: true });
      expect(requests).toHaveLength(0);
      expect(JSON.parse(await invoke(direct, args))).toMatchObject({ ok: true, command: 'send_file' });
      const uploads = requests.filter(req => req.url === '/api/upload-file');
      expect(uploads).toHaveLength(1);
      expect(uploads[0]).toMatchObject({ authorization: 'Bearer offline-test-token', body: { chatId: 'probe@im.wechat', filePath: file } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('installed unified CLI argument forwarding', () => {
  it('matches Docker health checks against the actual public CLI child command line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-cli-health-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      copyFileSync(fileURLToPath(new URL('../bin/disclaude.js', import.meta.url)), join(root, 'bin/disclaude.js'));
      const target = join(root, 'node_modules/@disclaude/service/dist');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, '../package.json'), '{"type":"module"}');
      writeFileSync(join(target, 'cli.js'), 'console.log(process.pid); setInterval(() => {}, 1000);');
      child = spawn(process.execPath, [join(root, 'bin/disclaude.js'), 'start'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const [ready] = await once(child.stdout!, 'data');
      const servicePid = String(ready).trim();
      expect(servicePid).toMatch(/^\d+$/);
      const compose = readFileSync('docker-compose.yml', 'utf8');
      const pattern = compose.match(/test: \["CMD", "pgrep", "-f", "([^"]+)"\]/)?.[1];
      expect(pattern).toBeDefined();
      const matches = execFileSync('pgrep', ['-f', pattern!], { encoding: 'utf8' }).trim().split('\n');
      expect(matches).toContain(servicePid);
    } finally {
      if (child && child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('preserves start for the service parser and keeps channel routing unchanged outside the repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-cli-routing-'));
    try {
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      copyFileSync(fileURLToPath(new URL('../bin/disclaude.js', import.meta.url)), join(root, 'bin/disclaude.js'));
      for (const name of ['service', 'channel-cli']) {
        const target = join(root, 'node_modules/@disclaude', name, 'dist');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, '../package.json'), '{"type":"module"}');
        writeFileSync(join(target, 'cli.js'), 'console.log(JSON.stringify({ok:true,args:process.argv.slice(2)}));');
      }
      for (const [input, forwarded] of [
        [['start', '--config', '/tmp/path with spaces.yaml'], ['start', '--config', '/tmp/path with spaces.yaml']],
        [['channel', 'send_text', '--chat', 'test'], ['send_text', '--chat', 'test']],
      ]) {
        const out = execFileSync(process.execPath, [join(root, 'bin/disclaude.js'), ...input], {
          cwd: join(root, 'outside'), encoding: 'utf8', timeout: 10_000,
        });
        expect(JSON.parse(out).args).toEqual(forwarded);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
