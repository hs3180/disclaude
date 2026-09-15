import { expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { connect } from '../../../packages/service/src/browser-control/cdp.mjs';

const exec = promisify(execFile);

/** Exercise only an owned service's new target, correlating CDP with its OS process. */
export async function verifyNativeBrowserPage(client: Awaited<ReturnType<typeof connect>>, profile: string, port: number) {
  const processes = await client.call('SystemInfo.getProcessInfo');
  const pid = processes.processInfo.find((entry: { type: string }) => entry.type === 'browser')?.id;
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const { stdout: command } = await exec('ps', ['-ww', '-p', String(pid), '-o', 'args=']);
  expect(command).toContain(`--user-data-dir=${profile}`);
  expect(command).toContain(`--remote-debugging-port=${port}`);
  let targetId: string | undefined;
  try {
    ({ targetId } = await client.call('Target.createTarget', { url: 'about:blank', background: true }));
    const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
    const result = await client.call('Runtime.evaluate', {
      expression: "document.body.innerHTML='<input id=acceptance>'; document.querySelector('#acceptance').value='verified'; document.querySelector('#acceptance').value",
      returnByValue: true,
    }, sessionId);
    expect(result.result.value).toBe('verified');
    const shot = await client.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    expect(Buffer.from(shot.data, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  } finally {
    if (targetId) {
      await client.call('Target.closeTarget', { targetId });
      let present = true;
      for (let i = 0; i < 50 && present; i++) {
        present = (await client.call('Target.getTargets')).targetInfos.some((target: { targetId: string }) => target.targetId === targetId);
        if (present) { await delay(100); }
      }
      expect(present, 'Owned target remains after close').toBe(false);
    }
  }
  return pid;
}
