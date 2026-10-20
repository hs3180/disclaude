import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuth } from './auth.js';
import { DEFAULT_WECHAT_BASE_URL, WeChatStateStore, type WeChatCredentials } from './state-store.js';

const help = `Usage: disclaude wechat <login|status> [options]
Personal WeChat via Tencent iLink (QR login; no public callback server).
  --state-dir PATH   Account directory (default: ~/.disclaude/wechat)
  --qr-file PATH     Write a private QR PNG for remote delivery
  --force            Replace an existing login; stop its listener first
  --import-legacy    Migrate ~/.disclaude/wechat-auth.json without printing secrets
  --check            Verify status with Tencent (read-only)
  --timeout-ms N     Login deadline (default: 480000)
  --help             Show this help
Then enable channels.wechat in the service config; see docs/wechat-channel.md.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, 'qr-file': { type: 'string' }, force: { type: 'boolean' },
    'import-legacy': { type: 'boolean' }, check: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command] = positionals;
  if (values.help || !command) { console.log(help); return; }
  if (!['login', 'status'].includes(command) || positionals.length !== 1) { throw new Error('Expected wechat login or status; use --help'); }
  const store = new WeChatStateStore(values['state-dir'] ? resolve(values['state-dir']) : undefined);
  if (command === 'status') {
    const credentials = await store.loadCredentials();
    if (!credentials) { console.log(JSON.stringify({ configured: false, authenticated: 'not-checked', next: 'disclaude wechat login' })); return; }
    if (values.check) {
      if (!credentials.userId) { throw new Error('Saved login has no user ID; log in again'); }
      await new WeChatApiClient({ baseUrl: credentials.baseUrl, token: credentials.token }).checkSession(credentials.userId);
    }
    console.log(JSON.stringify({ configured: true, authenticated: values.check ? true : 'not-checked', savedAt: credentials.savedAt, baseUrl: credentials.baseUrl }));
    return;
  }
  const timeoutMs = Number(values['timeout-ms'] ?? 480_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) { throw new Error('--timeout-ms must be 1000..900000'); }
  const release = await store.lock();
  try {
    const existing = await store.loadCredentials();
    if (existing && !values.force) { console.log('Login already saved. Use status --check, or login --force after stopping the channel.'); return; }
    if (values['import-legacy']) {
      const legacy = join(homedir(), '.disclaude', 'wechat-auth.json');
      await fs.chmod(legacy, 0o600);
      const credentials = JSON.parse(await fs.readFile(legacy, 'utf8')) as WeChatCredentials;
      if (!credentials.token?.trim() || !credentials.botId) { throw new Error('Legacy login is incomplete'); }
      await store.saveCredentials(credentials);
      console.log('Legacy login migrated privately. Verify with disclaude wechat status --check.');
      return;
    }
    const auth = new WeChatAuth(new WeChatApiClient({ baseUrl: DEFAULT_WECHAT_BASE_URL }));
    const abort = () => auth.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await auth.authenticate({ timeoutMs,
        onQrCode: async (url) => {
          if (values['qr-file']) {
            const file = resolve(values['qr-file']);
            await fs.mkdir(dirname(file), { recursive: true });
            await fs.writeFile(file, await QRCode.toBuffer(url, { width: 400, margin: 2 }), { mode: 0o600 });
            await fs.chmod(file, 0o600);
            console.log(`Scan the QR image with WeChat: ${file}`);
          } else { process.stdout.write(await QRCode.toString(url, { type: 'terminal', small: true })); }
        },
        requestVerifyCode: async (signal) => {
          if (!process.stdin.isTTY) { throw new Error('Pairing requires a private interactive terminal'); }
          const input = createInterface({ input: process.stdin, output: process.stdout });
          try { return (await input.question('Enter the digits shown by WeChat (private terminal only): ', { signal })).trim(); }
          finally { input.close(); }
        },
      });
      if (!result.success || !result.token || !result.botId) { throw new Error(result.error ?? 'WeChat login failed'); }
      await store.saveCredentials({ token: result.token, botId: result.botId, userId: result.userId, baseUrl: result.baseUrl ?? DEFAULT_WECHAT_BASE_URL, savedAt: new Date().toISOString() });
      console.log('WeChat login saved privately. Enable channels.wechat and start the service.');
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } finally { await release(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'WeChat command failed'); process.exitCode = 1; });
