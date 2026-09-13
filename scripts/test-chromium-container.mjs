#!/usr/bin/env node
/** Opt-in real Docker browser acceptance. Requires Docker and Node >=22 WebSocket. */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

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
const cookie = randomUUID();
let created = false;
let volumeCreated = false;

async function start(headless) {
  docker('run', '-d', '--init', '--name', name, '--shm-size=2g', '--memory=4g',
    '-e', `CDP_PORT=${port}`, '-e', `CDP_INTERNAL_PORT=${internalPort}`,
    '-e', `CHROMIUM_HEADLESS=${headless ? 1 : 0}`, '-v', `${volume}:/data/chrome-profile`,
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  let target;
  try {
    target = (await call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
    const session = (await call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
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
    await call('Target.closeTarget', { targetId: target });
    assert(!(await call('Target.getTargets')).targetInfos.some(item => item.targetId === target));
    target = null;
    const processes = docker('exec', name, 'ps', '-eo', 'args');
    assert.equal(/^Xvfb /m.test(processes), !headless);
    assert.equal(processes.includes('--headless=new'), headless);
    evidence.push({ browser: info.Browser, mode: headless ? 'headless' : 'headed-Xvfb',
      cookie: write ? 'written' : 'retained-after-recreation', pngBytes: png.length, targetCleanup: 'pass' });
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
  console.log(JSON.stringify({ ok: true, platform: docker('info', '--format', '{{.OSType}}/{{.Architecture}}'),
    image, supervisorFailure: 'pass', evidence }, null, 2));
} finally {
  if (created) { try { docker('rm', '-f', name); } catch { /* Keep original error. */ } }
  if (volumeCreated) { try { docker('volume', 'rm', volume); } catch { /* Test volume name is printed by Docker for cleanup. */ } }
}
