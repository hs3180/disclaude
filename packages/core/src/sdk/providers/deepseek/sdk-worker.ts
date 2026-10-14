/** Opt-in library bootstrap in an owned Node process; no dsh executable. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import { dshSdkModules } from './sdk-bootstrap.js';

const [, , overlay] = process.argv;
if (!overlay) { throw new Error('DSH Node SDK worker requires an owned profile overlay'); }
const modules = dshSdkModules();
const directory = mkdtempSync(join(tmpdir(), 'disclaude-dsh-sdk-'));
const config = join(directory, 'cordis.json');
writeFileSync(config, '[]\n', { mode: 0o600 });
let context: Context | undefined;
let closing: Promise<void> | undefined;
const close = (): Promise<void> => closing ??= (async () => {
  try { await context?.fiber.dispose(); }
  finally { rmSync(directory, { recursive: true }); }
})();
process.stdin.once('end', () => { void close().catch(() => { process.exitCode = 1; }); });
process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
try {
  await boot('disclaude-node-sdk', config, [
    ...loadOverlayPatches('disclaude-node-sdk', fileURLToPath(modules.bundle)),
    { id: 'sdk-app-startup', disabled: true },
    { insert: [{ id: 'disclaude-sdk-attachments', name: modules.attachments }] },
    ...loadOverlayPatches('disclaude-node-sdk', overlay),
  ], async ctx => {
    context = ctx;
    if (closing) {
      await ctx.fiber.dispose();
      throw new Error('DSH Node SDK startup cancelled');
    }
    ctx.provide('sdkAppStartup', { accepted: true });
  }, modules.moduleBase);
} catch (error) {
  await close();
  throw error;
}
