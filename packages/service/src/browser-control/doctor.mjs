import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchBrowser } from './managed-browser.mjs';
import { connect } from './cdp.mjs';

/** Probe an explicitly selected executable with disposable state, never a live profile. */
export async function diagnoseBrowser({ binary, headless = false, signal }) {
  if (!binary || !isAbsolute(binary)) throw new Error('doctor requires --binary with an absolute executable path');
  await access(binary, constants.X_OK);
  const executable = await realpath(binary);
  const profile = await mkdtemp(join(tmpdir(), 'disclaude-browser-doctor-'));
  const marker = randomUUID();
  const report = { executable, platform: process.platform, arch: process.arch,
    mode: headless ? 'headless' : 'headed', usable: false, cookiePersistence: 'not-tested',
    profile: 'temporary', cycles: [] };
  let browser, client;
  const checkCancelled = () => { if (signal?.aborted) throw new Error('Browser diagnosis cancelled'); };
  const stop = async () => {
    try {
      if (client) {
        // Browser.close may disconnect before its acknowledgement arrives.
        await client.call('Browser.close').catch(() => {});
        await client.close();
      }
    } finally {
      client = undefined;
      if (browser) await browser.stop({ graceful: true });
      browser = undefined;
    }
  };
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      checkCancelled();
      browser = await launchBrowser({ binary: executable, profile, headless, signal });
      const info = await (await fetch(`${browser.endpoint}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
      client = await connect(info.webSocketDebuggerUrl);
      checkCancelled();
      const version = await client.call('Browser.getVersion');
      const { targetId } = await client.call('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await client.call('Target.attachToTarget', { targetId, flatten: true });
      await client.call('Page.navigate', { url: 'data:text/html,<title>disclaude browser diagnosis</title><input id="probe">' }, sessionId);
      let dom;
      for (let attempt = 0; attempt < 30; attempt++) {
        checkCancelled();
        dom = await client.call('Runtime.evaluate', { expression: `(() => { const p=document.querySelector('#probe'); if(!p)return null; p.value=${JSON.stringify(marker)}; return p.value; })()`, returnByValue: true }, sessionId);
        if (dom.result.value === marker) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (dom.result.value !== marker) throw new Error('Browser navigation/input probe failed');
      const screenshot = await client.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      if (!Buffer.from(screenshot.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Browser screenshot probe failed');
      if (cycle === 0) {
        const cookie = await client.call('Network.setCookie', { name: 'disclaude_doctor', value: marker,
          url: 'https://disclaude-doctor.example.test/', expires: Math.floor(Date.now() / 1000) + 3600 }, sessionId);
        if (!cookie.success) throw new Error('Browser could not set a temporary test cookie');
      }
      const { cookies } = await client.call('Network.getCookies', { urls: ['https://disclaude-doctor.example.test/'] }, sessionId);
      const retained = cookies.some(cookie => cookie.name === 'disclaude_doctor' && cookie.value === marker);
      if (cycle === 0 && !retained) throw new Error('Browser could not read its running-session test cookie');
      if (cycle === 1) report.cookiePersistence = retained ? 'retained' : 'not-retained';
      report.cycles.push({ browser: version.product, navigation: true, input: true, screenshot: true, runningCookie: retained });
      await stop();
    }
    checkCancelled();
    report.usable = true;
    return report;
  } finally {
    await stop();
    await rm(profile, { recursive: true, force: true });
  }
}
