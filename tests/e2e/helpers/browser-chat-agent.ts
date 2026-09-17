import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

/** Drive a running deployment from a separate process, through its public API. */
export async function verifyChatAgentBrowser(root: string, env: NodeJS.ProcessEnv,
  serviceUrl: string): Promise<void> {
  const socket = env.DISCLAUDE_BROWSER_SOCKET;
  if (!socket) { throw new Error('Browser acceptance requires the deployment socket'); }
  const result = await promisify(execFile)(process.execPath, [
    resolve('scripts/test-browser-chat-agent.mjs'), '--service-url', serviceUrl,
    '--workspace', root, '--socket', socket,
  ], { env, timeout: 180_000, maxBuffer: 1024 * 1024 });
  console.info(result.stdout.trim());
}
