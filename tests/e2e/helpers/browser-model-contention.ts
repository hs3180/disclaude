import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

/** Concurrent real chats enter the deployment from an independent process. */
export async function verifyModelContention(root: string, env: NodeJS.ProcessEnv,
  serviceUrl: string): Promise<void> {
  const result = await promisify(execFile)(process.execPath, [
    resolve('scripts/test-browser-contention.mjs'), '--service-url', serviceUrl,
    '--workspace', root,
  ], { env, timeout: 240_000, maxBuffer: 1024 * 1024 }).catch((error: Error & { stdout?: string }) => {
    if (error.stdout) { console.error(error.stdout.trim()); }
    throw error;
  });
  console.info(result.stdout.trim());
}
