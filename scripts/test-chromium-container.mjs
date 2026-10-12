#!/usr/bin/env node
/** Opt-in real Docker browser acceptance. Requires Docker and Node >=22 WebSocket. */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID, createHash, createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

assert.equal(typeof WebSocket, 'function', 'Use Node >=22 for this opt-in CDP test');
const image = process.argv[2] || 'disclaude-chromium:060-test';
const profilePath = process.env.CHROMIUM_CDP_PROFILE_DIR || '/data/chrome-profile';
assert(profilePath.startsWith('/'), 'CHROMIUM_CDP_PROFILE_DIR must be an absolute container path');
const name = `disclaude-browser-test-${randomUUID().slice(0, 8)}`;
const volume = `${name}-profile`;
const redact = value => String(value).replace(/(generated VNC password: )\S+/g, '$1<redacted>')
  .replace(/(CHROMIUM_VNC_PASSWORD=)\S+/g, '$1<redacted>');
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${redact(result.error?.message || result.stderr || result.stdout)}`);
  }
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const vncListener = createServer();
await new Promise(resolve => vncListener.listen(0, '127.0.0.1', resolve));
const vncPort = vncListener.address().port;
await new Promise(resolve => vncListener.close(resolve));
const internalPort = port === 9221 ? 9220 : 9221;
const endpoint = `http://127.0.0.1:${port}`;
const evidence = [];
const interfaces = networkInterfaces();
const lanAddress = [...(interfaces.en0 || interfaces.eth0 || []), ...Object.values(interfaces).flat()]
  .find(item => item?.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))?.address;
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

async function start(headless, { password, vncEnabled, bind = '0.0.0.0' } = {}) {
  docker('run', '-d', '--init', '--name', name, '--shm-size=2g', '--memory=4g',
    '-e', `CDP_PORT=${port}`, '-e', `CDP_INTERNAL_PORT=${internalPort}`,
    '-e', `CHROMIUM_HEADLESS=${headless ? 1 : 0}`,
    '-e', `CHROMIUM_CDP_PROFILE_DIR=${profilePath}`,
    ...(password !== undefined ? ['-e', `CHROMIUM_VNC_PASSWORD=${password}`] : []),
    ...(vncEnabled !== undefined ? ['-e', `CHROMIUM_VNC_ENABLED=${vncEnabled}`] : []),
    ...(process.env.CHROMIUM_ACCEPT_LANG ? ['-e', `CHROMIUM_ACCEPT_LANG=${acceptLanguages}`] : []), '-e', `TZ=${process.env.TZ || 'Asia/Shanghai'}`, '-v', `${volume}:${profilePath}`,
    '-p', `127.0.0.1:${port}:${port}`, '-p', `${bind}:${vncPort}:6080`, image);
  created = true;
  let last;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch (error) { last = error; }
    if (docker('inspect', '-f', '{{.State.Running}}', name) !== 'true') {
      throw new Error(`Container exited: ${redact(docker('logs', name))}`);
    }
    await delay(200);
  }
  throw new Error(`CDP readiness timeout: ${last?.message}`);
}

/** Native RFB check: require VNC authentication and read an actual framebuffer. */
async function authenticateVnc(password, accepted = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${vncPort}/websockify`, ['binary']);
  ws.binaryType = 'arraybuffer';
  let buffer = Buffer.alloc(0), wake;
  ws.addEventListener('message', event => {
    buffer = Buffer.concat([buffer, Buffer.from(event.data)]);
    wake?.();
  });
  const read = async count => {
    while (buffer.length < count) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('VNC response timeout')), 5000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
    const result = buffer.subarray(0, count); buffer = buffer.subarray(count); return result;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('VNC connection timeout')), 5000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('VNC connection failed')); }, { once: true });
    });
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    ws.send(Buffer.from('RFB 003.008\n'));
    const count = (await read(1))[0]; assert(count > 0);
    const types = [...await read(count)];
    assert(types.includes(2), 'VNC password authentication missing');
    assert(!types.includes(1), 'Unauthenticated VNC access advertised');
    ws.send(Buffer.from([2]));
    const challenge = await read(16);
    // VNC reverses the eight password bytes' bits before DES. Repeating that
    // key for EDE3 is equivalent to DES and works without OpenSSL legacy mode.
    const key = Buffer.from(password).map(byte => {
      let reversed = 0;
      for (let i = 0; i < 8; i++) { reversed = (reversed << 1) | (byte & 1); byte >>>= 1; }
      return reversed;
    });
    assert.equal(key.length, 8);
    const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    ws.send(Buffer.concat([cipher.update(challenge), cipher.final()]));
    const status = (await read(4)).readUInt32BE();
    if (!accepted) { assert.notEqual(status, 0, 'Wrong password accepted'); return { denied: true }; }
    assert.equal(status, 0, 'Configured password rejected');
    ws.send(Buffer.from([1]));
    const init = await read(24);
    const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
    assert(width > 0 && height > 0);
    await read(init.readUInt32BE(20));
    ws.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // raw framebuffer encoding
    ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 32, 0, 32]));
    const update = await read(4); assert.equal(update[0], 0); assert(update.readUInt16BE(2) > 0);
    const rect = await read(12); assert.equal(rect.readInt32BE(8), 0);
    const pixels = await read(rect.readUInt16BE(4) * rect.readUInt16BE(6) * init[4] / 8);
    assert(pixels.length > 0);
    return { securityTypes: types, width, height, framebufferBytes: pixels.length };
  } finally { wake = undefined; ws.close(); }
}

async function probeVnc({ enabled = true, password, previous, bind = '0.0.0.0', denyWrong = false } = {}) {
  const bindings = JSON.parse(docker('inspect', '-f', '{{json .HostConfig.PortBindings}}', name));
  assert.equal(bindings[`${port}/tcp`][0].HostIp, '127.0.0.1');
  assert.equal(bindings['6080/tcp'][0].HostIp, bind);
  const logs = docker('logs', name); // Password is used locally and never emitted.
  if (!enabled) {
    const processes = docker('exec', name, 'ps', '-eo', 'comm');
    assert(!/^x11vnc$/m.test(processes) && !/^websockify$/m.test(processes));
    const response = await fetch(`http://127.0.0.1:${vncPort}/vnc.html`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    assert(!response?.ok);
    evidence.push({ vnc: 'skipped', headlessInfoLogged: logs.includes('INFO: headless Chromium skips VNC/noVNC') });
    return;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`http://127.0.0.1:${vncPort}/vnc.html`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) { assert((await response.text()).includes('noVNC')); break; }
    assert(attempt < 29, 'noVNC page did not become ready'); await delay(200);
  }
  const generated = logs.match(/INFO: generated VNC password: (\S+)/)?.[1];
  if (password) { assert(!generated, 'Explicit password was logged'); }
  else { assert(typeof generated === 'string' && /^[!-~]{8}$/.test(generated), 'Valid generated password missing'); password = generated; }
  if (previous) { assert(password !== previous, 'Generated password did not rotate on recreation'); }
  assert.equal(docker('exec', name, 'sh', '-c', 'stat -c %a /tmp/disclaude-vnc-password.*'), '600');
  const rfb = await authenticateVnc(password);
  let lanHttp;
  if (lanAddress) {
    const response = await fetch(`http://${lanAddress}:${vncPort}/vnc.html`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    lanHttp = response?.ok === true;
    assert.equal(lanHttp, bind === '0.0.0.0', 'Host non-loopback reachability does not match the published bind');
  }
  if (denyWrong) { await authenticateVnc('!badPass', false); }
  evidence.push({ vnc: 'authenticated', password: generated ? 'generated' : 'explicit', passwordLogged: !!generated,
    rotated: !!previous, wrongPasswordDenied: denyWrong || undefined, bind, lanHttp, ...rfb });
  return password;
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
  const firstPassword = await probeVnc({ denyWrong: true });
  docker('stop', '-t', '15', name); docker('rm', name); created = false;
  await probe(await start(false), false, false);
  await probeVnc({ previous: firstPassword });
  docker('exec', name, 'pkill', '-TERM', '-x', 'nginx');
  for (let i = 0; i < 30 && docker('inspect', '-f', '{{.State.Running}}', name) === 'true'; i++) await delay(200);
  assert.equal(docker('inspect', '-f', '{{.State.Running}}', name), 'false', 'supervisor survived proxy failure');
  assert.notEqual(docker('inspect', '-f', '{{.State.ExitCode}}', name), '0');
  docker('rm', name); created = false;
  await probe(await start(true), false, true);
  await probeVnc({ enabled: false });
  assert(docker('logs', name).includes('INFO: headless Chromium skips VNC/noVNC'));
  docker('stop', '-t', '15', name); docker('rm', name); created = false;
  const fixedPassword = randomBytes(6).toString('base64');
  await probe(await start(false, { password: fixedPassword, bind: '127.0.0.1' }), false, false);
  await probeVnc({ password: fixedPassword, bind: '127.0.0.1' });
  docker('stop', '-t', '15', name); docker('rm', name); created = false;
  await probe(await start(false, { vncEnabled: 0 }), false, false);
  await probeVnc({ enabled: false });
  docker('stop', '-t', '15', name); docker('rm', name); created = false;
  docker('run', '-d', '--init', '--name', name, '-e', 'CHROMIUM_VNC_PASSWORD=short', image); created = true;
  for (let i = 0; i < 30 && docker('inspect', '-f', '{{.State.Running}}', name) === 'true'; i++) await delay(100);
  assert.equal(docker('inspect', '-f', '{{.State.ExitCode}}', name), '1');
  assert(docker('logs', name).includes('CHROMIUM_VNC_PASSWORD must be exactly 8 printable ASCII characters'));
  evidence.push({ invalidExplicitPasswordRejected: true });
  const articleRetrieved = evidence.find(item => 'articleRetrieved' in item)?.articleRetrieved;
  const ok = !articleUrl || articleRetrieved === true;
  console.log(JSON.stringify({ ok, lifecycleOk: true, ...(articleUrl ? { articleRetrieved } : {}), platform: docker('info', '--format', '{{.OSType}}/{{.Architecture}}'),
    image, supervisorFailure: 'pass', evidence }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  if (created) { try { docker('rm', '-f', name); } catch { /* Keep original error. */ } }
  if (volumeCreated) { try { docker('volume', 'rm', volume); } catch { /* Test volume name is printed by Docker for cleanup. */ } }
}
