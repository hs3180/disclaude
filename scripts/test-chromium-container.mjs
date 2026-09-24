#!/usr/bin/env node
/** Opt-in real Docker browser acceptance. Requires Docker and Node >=22 WebSocket. */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

assert.equal(typeof WebSocket, 'function', 'Use Node >=22 for this opt-in CDP test');
const image = process.argv[2] || 'disclaude-chromium:060-test';
const name = `disclaude-browser-test-${randomUUID().slice(0, 8)}`;
const volume = `${name}-profile`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const internalPort = port === 9221 ? 9220 : 9221;
const endpoint = `http://127.0.0.1:${port}`;
const evidence = [];
// Explicit opt-in: public-site observations are independent of lifecycle assertions.
const articleUrl = process.env.DISCLAUDE_CHROMIUM_ARTICLE_URL;
const acceptLanguages = process.env.CHROMIUM_ACCEPT_LANG || 'en-US,en';
const publicUrl = value => { try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return undefined; } };
const evidenceDir = process.env.DISCLAUDE_CHROMIUM_EVIDENCE_DIR;
if (articleUrl) {
  const url = new URL(articleUrl);
  assert(url.protocol === 'https:' && url.hostname === 'mp.weixin.qq.com' && url.pathname.startsWith('/s'), 'Use a public WeChat article URL');
  assert(evidenceDir, 'Set DISCLAUDE_CHROMIUM_EVIDENCE_DIR for retained site screenshots');
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}

const cookie = randomUUID();
let created = false;
let volumeCreated = false;

async function start(headless) {
  docker('run', '-d', '--init', '--name', name, '--shm-size=2g', '--memory=4g',
    '-e', `CDP_PORT=${port}`, '-e', `CDP_INTERNAL_PORT=${internalPort}`,
    '-e', `CHROMIUM_HEADLESS=${headless ? 1 : 0}`,
    ...(process.env.CHROMIUM_ACCEPT_LANG ? ['-e', `CHROMIUM_ACCEPT_LANG=${acceptLanguages}`] : []), '-e', `TZ=${process.env.TZ || 'Asia/Shanghai'}`, '-v', `${volume}:/data/chrome-profile`,
    '-p', `127.0.0.1:${port}:${port}`, image);
  created = true;
  let last;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch (error) { last = error; }
    if (docker('inspect', '-f', '{{.State.Running}}', name) !== 'true') {
      throw new Error(`Container exited: ${docker('logs', name)}`);
    }
    await delay(200);
  }
  throw new Error(`CDP readiness timeout: ${last?.message}`);
}

async function probe(info, write, headless) {
  // Discovery must advertise the actual reachable host endpoint, not a VM bridge IP.
  assert.equal(new URL(info.webSocketDebuggerUrl).host, `127.0.0.1:${port}`);
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, method === 'Page.captureScreenshot' ? 15000 : 5000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  let target;
  try {
    target = (await call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
    const session = (await call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    const language = await call('Runtime.evaluate', { expression: '({ language: navigator.language, languages: navigator.languages })', returnByValue: true }, session);
    assert.equal(language.result.value.language, acceptLanguages.split(',')[0], 'browser language differs from configured content language');
    // Chromium can reduce the exposed list to its primary language.
    assert.equal(language.result.value.languages[0], acceptLanguages.split(',')[0], 'primary browser language differs from configured content languages');
    if (write) {
      const result = await call('Network.setCookie', { name: 'disclaude_persistence', value: cookie,
        url: 'https://research.example.test/', expires: Math.floor(Date.now() / 1000) + 3600 }, session);
      assert.equal(result.success, true);
    }
    const cookies = await call('Network.getCookies', { urls: ['https://research.example.test/'] }, session);
    assert(cookies.cookies.some(item => item.name === 'disclaude_persistence' && item.value === cookie), 'persistent cookie missing after recreation');
    const dom = await call('Runtime.evaluate', { expression: "document.body.innerHTML='<h1>Container smoke</h1>';document.querySelector('h1').textContent", returnByValue: true }, session);
    assert.equal(dom.result.value, 'Container smoke');
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, session);
    const png = Buffer.from(screenshot.data, 'base64');
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    if (write && articleUrl) {
      const fingerprints = await call('Runtime.evaluate', { expression: `(() => {
        const gl = document.createElement('canvas').getContext('webgl');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return { webdriver: { type: typeof navigator.webdriver, value: navigator.webdriver ?? null },
          languages: navigator.languages, timezoneOffset: new Date().getTimezoneOffset(),
          userAgent: navigator.userAgent, platform: navigator.platform,
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
      })()`, returnByValue: true }, session);
      const sites = [];
      for (const [label, url] of [['fingerprint', 'https://bot.sannysoft.com/'], ['article', articleUrl]]) {
        const navigation = await call('Page.navigate', { url }, session);
        let page;
        for (let attempt = 0; attempt < 60; attempt++) {
          const result = await call('Runtime.evaluate', { expression: `({ url: location.href, title: document.title,
            ready: document.readyState, article: document.querySelector('#js_content')?.innerText?.trim() ?? '',
            text: document.body?.innerText ?? '' })`, returnByValue: true }, session);
          page = result.result.value;
          if (page?.ready === 'complete' && publicUrl(page.url)?.startsWith(`${new URL(url).origin}/`)) break;
          await delay(500);
        }
        writeFileSync(resolve(evidenceDir, `${label}-observation.json`), JSON.stringify({ requestedUrl: url, finalUrl: publicUrl(page?.url), title: page?.title, ready: page?.ready, navigationError: navigation.errorText, articleCharacters: page?.article?.length ?? 0, fingerprints: fingerprints.result.value }, null, 2), { mode: 0o600 });
        const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, session);
        const screenshotPath = resolve(evidenceDir, `${label}.png`);
        writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
        const blocked = /环境异常|访问过于频繁|完成验证|captcha/iu.test(page?.text ?? '');
        sites.push({ label, requestedUrl: url, finalUrl: publicUrl(page?.url), title: page?.title,
          navigationError: navigation.errorText, blocked, articleCharacters: page?.article?.length ?? 0,
          articleSha256: page?.article ? createHash('sha256').update(page.article).digest('hex') : undefined,
          // Retain diagnostics, not the article body or any account/session data.
          diagnostics: label === 'fingerprint' ? page?.text?.slice(0, 5000) : blocked ? 'Site challenge detected' : undefined,
          screenshotPath });
      }
      evidence.push({ mode: 'headed-Xvfb', fingerprints: fingerprints.result.value, sites,
        articleRetrieved: sites.some(site => site.label === 'article' && !site.blocked && site.articleCharacters > 0) });
    }
    await call('Target.closeTarget', { targetId: target });
    // closeTarget acknowledges the request before destruction completes.
    let targetPresent = true;
    for (let attempt = 0; attempt < 50; attempt++) {
      targetPresent = (await call('Target.getTargets')).targetInfos.some(item => item.targetId === target);
      if (!targetPresent) break;
      await delay(100);
    }
    assert.equal(targetPresent, false, 'target remained present after close timeout');
    target = null;
    const processes = docker('exec', name, 'ps', '-eo', 'args');
    assert.equal(/^Xvfb /m.test(processes), !headless);
    assert.equal(processes.includes('--headless=new'), headless);
    evidence.push({ browser: info.Browser, mode: headless ? 'headless' : 'headed-Xvfb',
      languages: language.result.value.languages, cookie: write ? 'written' : 'retained-after-recreation', pngBytes: png.length, targetCleanup: 'pass' });
  } finally {
    if (target) await call('Target.closeTarget', { targetId: target }).catch(() => {});
    ws.close();
    for (const entry of pending.values()) clearTimeout(entry.timer);
  }
}

try {
  docker('volume', 'create', volume); volumeCreated = true;
  await probe(await start(false), true, false);
  docker('stop', '-t', '15', name); docker('rm', name); created = false;
  await probe(await start(false), false, false);
  docker('exec', name, 'pkill', '-TERM', '-x', 'nginx');
  for (let i = 0; i < 30 && docker('inspect', '-f', '{{.State.Running}}', name) === 'true'; i++) await delay(200);
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', name), 'false', 'supervisor survived proxy failure');
  assert.notEqual(docker('inspect', '-f', '{{.State.ExitCode}}', name), '0');
  docker('rm', name); created = false;
  await probe(await start(true), false, true);
  const articleRetrieved = evidence.find(item => 'articleRetrieved' in item)?.articleRetrieved;
  const ok = !articleUrl || articleRetrieved === true;
  console.log(JSON.stringify({ ok, lifecycleOk: true, ...(articleUrl ? { articleRetrieved } : {}), platform: docker('info', '--format', '{{.OSType}}/{{.Architecture}}'),
    image, supervisorFailure: 'pass', evidence }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  if (created) { try { docker('rm', '-f', name); } catch { /* Keep original error. */ } }
  if (volumeCreated) { try { docker('volume', 'rm', volume); } catch { /* Test volume name is printed by Docker for cleanup. */ } }
}
