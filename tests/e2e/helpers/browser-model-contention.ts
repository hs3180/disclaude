import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Retained for the legacy ordinary-agent case until its separate PR is applied.
export class ModelContentionCleanupError extends Error {}

/** Concurrent real chats enter the deployment from an independent process. */
export async function verifyModelContention(root: string, env: NodeJS.ProcessEnv,
  serviceUrl: string, eventFile: string): Promise<void> {
  const socket = env.DISCLAUDE_BROWSER_SOCKET;
  if (!socket) { throw new Error('Contention acceptance requires the deployment socket'); }
  const result = await promisify(execFile)(process.execPath, [
    resolve('scripts/test-browser-contention.mjs'), '--service-url', serviceUrl,
    '--workspace', root, '--socket', socket, '--events', eventFile,
  ], { env, timeout: 240_000, maxBuffer: 1024 * 1024 });
  console.info(result.stdout.trim());
}
