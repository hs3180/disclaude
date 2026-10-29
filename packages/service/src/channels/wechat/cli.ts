import { parseArgs } from 'node:util';
import * as fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { setTimeout as delay } from 'node:timers/promises';
import { WeChatIdentityMismatchError, WeChatRegistry, type WeChatRegistration } from './registry.js';
import { DEFAULT_WECHAT_BASE_URL, WeChatStateStore, type WeChatCredentials } from './state-store.js';
import { inspectRegistryLock, recoverRegistryLock } from './registry-lock-recovery.js';

const help = `Usage: disclaude wechat <login|status|enable ID|disable ID|remove ID|lock-inspect|lock-recover> [options]
Personal WeChat via Tencent iLink (QR login; no public callback server).
  login             Scan to register another account; existing accounts keep serving
  status            List registered IDs; use channel capabilities for live connection health
  lock-inspect      Read registry lock metadata only; save its JSON for recovery
  lock-recover      Quarantine unchanged pre-boot corruption using --snapshot FILE
  --snapshot FILE   JSON from lock-inspect; no lock contents or credentials required
  --state-dir PATH   Registry root (default: ~/.disclaude/wechat)
  --id ID            Existing registered identity for status or login --force
  --qr-file PATH     Write a private QR PNG for remote delivery
  --force            Reauthenticate --id, briefly suspending only that account
  --import-legacy    Migrate ~/.disclaude/wechat-auth.json without printing secrets
  --check            Verify status with Tencent (read-only)
  --timeout-ms N     Login deadline (default: 480000)
  --help             Show this help
Then enable channels.wechat in the service config; see docs/wechat-channel.md.`;

async function withDiagnostics<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  try { return await run(); } finally { process.stdout.write = original; }
}

/** Read-only probe outcome for a registration's saved credentials (#5479). */
interface LoginProbe {
  verified: boolean;
  /** Passed: an account check still proves neither liveness nor delivery (#5478). */
  note?: string;
  /** Probe could not run. */
  reason?: string;
  /** Probe ran and failed. */
  error?: string;
  /** Probe failed because the remote rejected the credentials (-14/401). */
  loginExpired?: boolean;
}

/**
 * Probe a registration's saved credentials once with the same read-only check
 * `status --check` uses (#5479). Never throws: an expired login reports
 * loginExpired, anything else reports the error, a missing user ID reports
 * why the probe cannot run.
 */
async function probeSavedLogin(registry: WeChatRegistry, account: WeChatRegistration): Promise<LoginProbe> {
  try {
    const credentials = await new WeChatStateStore(registry.stateDir(account)).loadCredentials();
    const userId = credentials?.userId;
    if (!credentials || !userId) {
      return { verified: false, reason: 'saved login has no user ID; reauthenticate this registration' };
    }
    await withDiagnostics(async () => {
      const { WeChatApiClient } = await import('./api-client.js');
      await new WeChatApiClient({ baseUrl: credentials.baseUrl, token: credentials.token }).checkSession(userId);
    });
    // A passing account check proves neither login liveness nor delivery (#5478).
    return { verified: true, note: 'account check passed does not prove message delivery' };
  } catch (cause) {
    const expired = (cause as { authExpired?: boolean }).authExpired === true;
    return { verified: false, ...(expired ? { loginExpired: true } : {}),
      error: cause instanceof Error ? cause.message : 'Cannot verify this account' };
  }
}

/**
 * #5479: restoring the saved config after a failed re-login is not restoring
 * the login. Probe the old credentials so a rejected account reads as
 * "needs a scan" — never as "recovered" — and a still-valid one is verified.
 */
async function verifyRestoredLogin(registry: WeChatRegistry, account: WeChatRegistration): Promise<Record<string, unknown>> {
  const probe = await probeSavedLogin(registry, account);
  return { ok: true, restored: account.id, ...probe, next: `disclaude wechat login --id ${account.id} --force` };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, id: { type: 'string' }, 'qr-file': { type: 'string' }, force: { type: 'boolean' },
    'import-legacy': { type: 'boolean' }, check: { type: 'boolean' }, 'timeout-ms': { type: 'string' }, help: { type: 'boolean' }, snapshot: { type: 'string' },
  } });
  const [command] = positionals;
  if (values.help || !command) { console.log(help); return; }
  const registry = new WeChatRegistry(values['state-dir'] ? resolve(values['state-dir']) : undefined);
  if (command === 'lock-inspect' || command === 'lock-recover') {
    if (positionals.length !== 1) { throw new Error('Use wechat --help for registry lock recovery'); }
    if (command === 'lock-inspect') { console.log(JSON.stringify({ ok: true, ...await inspectRegistryLock(registry.dir) })); }
    else {
      if (!values.snapshot) { throw new Error('lock-recover requires --snapshot FILE from lock-inspect'); }
      const stat = await fs.stat(values.snapshot);
      if (!stat.isFile() || stat.size > 16_384) { throw new Error('Invalid lock inspection snapshot'); }
      let snapshot: unknown;
      try { snapshot = JSON.parse(await fs.readFile(values.snapshot, 'utf8')); } catch { throw new Error('Cannot read lock inspection snapshot'); }
      console.log(JSON.stringify({ ok: true, ...await recoverRegistryLock(registry.dir, snapshot) }));
    }
    return;
  }
  if (['enable', 'disable', 'remove'].includes(command)) {
    const [, id] = positionals;
    if (!id || positionals.length !== 2) { throw new Error('Expected a registered ID from wechat status'); }
    if (command === 'remove') { await registry.remove(id); }
    else { await registry.setEnabled(id, command === 'enable'); }
    console.log(JSON.stringify({ ok: true, action: command, id }));
    return;
  }
  if (!['login', 'status'].includes(command) || positionals.length !== 1) { throw new Error('Use wechat --help for supported commands'); }
  const accounts = await registry.list();
  if (values.id && !accounts.some(account => account.id === values.id)) { throw new Error('Unknown WeChat registration'); }
  if (command === 'status') {
    const rows = [];
    for (const account of accounts.filter(item => !values.id || item.id === values.id)) {
      let configured = false;
      let authenticated: boolean | string = 'not-checked';
      let error: string | undefined;
      try {
        const credentials = await new WeChatStateStore(registry.stateDir(account)).loadCredentials();
        configured = !!credentials;
        if (values.check) {
          const userId = credentials?.userId;
          if (!credentials || !userId) { throw new Error('Saved login has no user ID; reauthenticate this registration'); }
          await withDiagnostics(async () => {
            const { WeChatApiClient } = await import('./api-client.js');
            await new WeChatApiClient({ baseUrl: credentials.baseUrl, token: credentials.token }).checkSession(userId);
          });
          authenticated = true;
        }
      } catch (cause) {
        authenticated = false;
        error = cause instanceof Error ? cause.message : 'Cannot read or verify this account';
      }
      rows.push({ id: account.id, channelId: registry.channelId(account), enabled: account.enabled, configured, authenticated,
        ...(error ? { error, next: `disclaude wechat login --id ${account.id} --force` } : {}) });
    }
    const allAuthenticated = rows.length > 0 && rows.every(row => row.authenticated === true);
    console.log(JSON.stringify({ configured: rows.some(row => row.configured),
      authenticated: values.check ? allAuthenticated : 'not-checked',
      // A passing account check reads its own config; it proves neither login liveness nor delivery (#5478).
      ...(values.check && allAuthenticated ? { note: 'account check passed does not prove message delivery' } : {}),
      accounts: rows, ...(!rows.length ? { next: 'disclaude wechat login' } : {}) }));
    if (values.check && (!rows.length || rows.some(row => row.authenticated !== true))) { process.exitCode = 1; }
    return;
  }
  const timeoutMs = Number(values['timeout-ms'] ?? 480_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000) { throw new Error('--timeout-ms must be 1000..900000'); }
  const targetId = values.id ?? (values.force && accounts.length === 1 && accounts[0].legacy ? accounts[0].id : undefined);
  if (values.id && !values.force) { throw new Error('Use login --id ID --force to reauthenticate'); }
  if (values.force && !targetId) { throw new Error('--force requires --id from wechat status'); }
  const target = accounts.find(account => account.id === targetId);
  let restoreGeneration: string | undefined;
  let committed = false;
  if (target) {
    restoreGeneration = (await registry.setEnabled(target.id, false)).generation;
  }
  try {
    if (target) {
      const store = new WeChatStateStore(registry.stateDir(target));
      let idle = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { const release = await store.lock(); await release(); idle = true; break; }
        catch { await delay(50); }
      }
      if (!idle) { throw new Error('Account listener is still stopping; retry login later'); }
    }
    const save = async (credentials: WeChatCredentials) => {
      console.log(JSON.stringify({ stage: 'submitting-credentials' }));
      let account: WeChatRegistration;
      try {
        account = await registry.register(credentials, targetId, restoreGeneration);
      } catch (cause) {
        if (!(cause instanceof WeChatIdentityMismatchError)) { throw cause; }
        // #5480: the scan confirmed a different bot identity, so nothing was
        // saved. Keep refusing to overwrite; explain the identity change and
        // the safe continuation instead of leaving the operator with a scan
        // that just "didn't work". The rollback below restores the target.
        const saved = target ? await new WeChatStateStore(registry.stateDir(target)).loadCredentials() : undefined;
        const sameUser = !!saved?.userId && !!credentials.userId && saved.userId === credentials.userId;
        console.log(JSON.stringify({ ok: false, stage: 'identity-changed', saved: false,
          targetId: cause.targetId, registeredBotId: cause.registeredBotId, scannedBotId: cause.scannedBotId,
          sameUser,
          reason: sameUser ? 'scan confirmed a new bot identity for the same WeChat user'
            : 'scan confirmed an unexpected WeChat identity',
          next: `disclaude wechat login --state-dir ${registry.dir}` }));
        process.exitCode = 1;
        return;
      }
      committed = true;
      // #5479: a committed registration is not a verified login. Probe the
      // just-saved credentials so the report distinguishes the two.
      console.log(JSON.stringify({ stage: 'verifying-connection' }));
      const probe = await probeSavedLogin(registry, account);
      console.log(JSON.stringify({ ok: true, registered: true, id: account.id, channelId: registry.channelId(account), ...probe,
        ...(probe.verified ? {} : { next: `disclaude wechat login --id ${account.id} --force` }) }));
    };
    if (values['import-legacy']) {
      const legacy = join(homedir(), '.disclaude', 'wechat-auth.json');
      await fs.chmod(legacy, 0o600);
      let credentials: WeChatCredentials;
      try { credentials = JSON.parse(await fs.readFile(legacy, 'utf8')) as WeChatCredentials; }
      catch { throw new Error('Cannot read legacy WeChat login; repair it privately before migration'); }
      if (typeof credentials.token !== 'string' || !credentials.token.trim() || typeof credentials.botId !== 'string' || !credentials.botId) { throw new Error('Legacy login is incomplete'); }
      await save({ token: credentials.token, botId: credentials.botId, userId: credentials.userId, baseUrl: credentials.baseUrl ?? DEFAULT_WECHAT_BASE_URL, savedAt: credentials.savedAt ?? new Date().toISOString() });
      return;
    }
    const { WeChatApiClient, WeChatAuth } = await withDiagnostics(async () => ({ ...await import('./api-client.js'), ...await import('./auth.js') }));
    const auth = new WeChatAuth(new WeChatApiClient({ baseUrl: DEFAULT_WECHAT_BASE_URL }));
    const abort = () => auth.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await auth.authenticate({ timeoutMs,
        // #5479: machine-readable progress for remote operators following a
        // --qr-file login; the human QR/terminal output above stays as-is.
        onStage: (stage, detail) => { console.log(JSON.stringify({ stage, ...detail })); },
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
      await save({ token: result.token, botId: result.botId, userId: result.userId, baseUrl: result.baseUrl ?? DEFAULT_WECHAT_BASE_URL, savedAt: new Date().toISOString() });
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } finally {
    if (target?.enabled && !committed) {
      const current = (await registry.list()).find(account => account.id === target.id);
      if (current && current.generation === restoreGeneration && !current.enabled) {
        await registry.setEnabled(target.id, true);
        console.log(JSON.stringify(await verifyRestoredLogin(registry, current)));
      }
    }
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'WeChat command failed'); process.exitCode = 1; });
