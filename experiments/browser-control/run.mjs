import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connect } from './cdp.mjs';
import { Coordinator } from './coordinator.mjs';
const [endpoint, outputArg] = process.argv.slice(2);
if (!endpoint || !outputArg) throw new Error('Usage: node experiments/browser-control/run.mjs <dedicated-CDP-http-url> <output-dir>');
const output = resolve(outputArg); await mkdir(output, { recursive: true });
const info = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(5000) })).json();
const admin = await connect(info.webSocketDebuggerUrl);
const events = []; const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let target; let coordinator;
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  target = (await admin.call('Target.createTarget', { url: 'about:blank', background: true })).targetId;
  const sid = (await admin.call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
  await admin.call('Runtime.evaluate', { expression: "document.body.innerHTML='<h1>Shared control lab</h1><p id=\"value\">initial</p>'", returnByValue: true }, sid);
  await admin.call('Target.detachFromTarget', { sessionId: sid });
  coordinator = new Coordinator({ workerModule: new URL('./worker.mjs', import.meta.url), url: info.webSocketDebuggerUrl, target, event: e => events.push(e), verifyReclaimed: async () => {
    for (let i = 0; i < 50; i++) {
      if (!(await admin.call('Target.getTargetInfo', { targetId: target })).targetInfo.attached) {
        events.push({ type: 'browser-detached', ms: performance.now() }); return;
      }
      await delay(20);
    }
    throw new Error('Browser still reports a live target session');
  }, ttlMs: 600, hardMs: 2500 });
  const acquire = actor => coordinator.acquire(actor).promise;
  const a = await acquire('A');
  let bGranted = false;
  const bPromise = acquire('B').then(lease => { bGranted = true; return lease; });
  await coordinator.execute(a, 'write', 'A saved');
  await delay(60);
  assert.equal(bGranted, false);
  assert.equal(await coordinator.execute(a, 'read'), 'A saved');
  await coordinator.release(a);
  const b = await bPromise;
  assert.equal(await coordinator.execute(b, 'read'), 'A saved');
  await assert.rejects(coordinator.execute(a, 'write', 'stale overwrite'), /not current/);
  assert.equal(await coordinator.release(a), false);
  assert.throws(() => coordinator.heartbeat(a), /not current/);
  await coordinator.execute(b, 'write', 'B saved');
  assert.equal(await coordinator.execute(b, 'read'), 'B saved');
  const png = Buffer.from((await coordinator.execute(b, 'screenshot')).data, 'base64');
  assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  await writeFile(resolve(output, 'shared-page.png'), png);
  await coordinator.release(b);
  check('queued caller waits; holder works; shared page survives; stale holder cannot disrupt successor');

  for (const fault of ['kill', 'disconnect', 'expiry']) {
    const old = await acquire(`old-${fault}`);
    await coordinator.execute(old, 'write', `before-${fault}`);
    const successor = acquire(`next-${fault}`);
    if (fault !== 'expiry') coordinator.inject(old, fault);
    const next = await successor;
    assert.equal(await coordinator.execute(next, 'read'), `before-${fault}`);
    await assert.rejects(coordinator.execute(old, 'read'), /not current/);
    await coordinator.execute(next, 'write', `after-${fault}`);
    await coordinator.release(next);
    check(`${fault}: queued caller acquires and operates on preserved page`);
  }

  const stalled = await acquire('stalled');
  const inFlight = coordinator.execute(stalled, 'stall');
  const queued = coordinator.execute(stalled, 'write', 'must-not-send');
  // Attach rejection handlers before injecting faults.
  const inFlightCheck = assert.rejects(inFlight, /unknown/);
  const queuedCheck = assert.rejects(queued, /not current/);
  const afterStall = acquire('after-stall');
  const successor = await afterStall; // TTL revokes a worker with an in-flight CDP operation
  await Promise.all([inFlightCheck, queuedCheck]);
  assert.equal(await coordinator.execute(successor, 'read'), 'after-expiry');
  assert(!events.some(e => e.type === 'execute' && e.epoch === stalled.epoch && e.command === 'write'));
  await coordinator.release(successor);
  check('in-flight unknown is not replayed; queued stale operation never reaches CDP');

  const holding = await acquire('holding');
  const cancelled = coordinator.acquire('cancelled');
  const cancelCheck = assert.rejects(cancelled.promise, /cancelled/); cancelled.cancel();
  const timed = coordinator.acquire('timed', { waitMs: 30 });
  await assert.rejects(timed.promise, /wait timeout/); await cancelCheck;
  const remaining = acquire('remaining');
  await coordinator.release(holding);
  await coordinator.release(await remaining);
  assert(!events.some(e => e.type === 'granted' && ['cancelled', 'timed'].includes(e.actor)));
  check('cancelled/timed-out waiters never receive ghost grants or block queue');

  const long = await acquire('heartbeating');
  let heartbeats = 0;
  const pulse = setInterval(() => { try { coordinator.heartbeat(long); heartbeats++; } catch {} }, 100);
  const nextLong = await acquire('after-hard-deadline');
  clearInterval(pulse); assert(heartbeats > 5);
  assert.equal(await coordinator.execute(nextLong, 'read'), 'after-expiry');
  await coordinator.release(nextLong);
  check('heartbeats cannot hold control forever; hard deadline permits successor');

  // Queue the entire batch first: verify FIFO progress and no starvation under contention.
  const requests = Array.from({ length: 100 }, (_, i) => coordinator.acquire(`repeat-${i}`, { waitMs: 30000 }).promise);
  for (let i = 0; i < requests.length; i++) {
    const lease = await requests[i];
    if (i) assert.equal(await coordinator.execute(lease, 'read'), `iteration-${i - 1}`);
    await coordinator.execute(lease, 'write', `iteration-${i}`);
    assert.equal(await coordinator.execute(lease, 'read'), `iteration-${i}`);
    await coordinator.release(lease);
  }
  assert.deepEqual(events.filter(e => e.type === 'granted' && e.actor.startsWith('repeat-')).map(e => e.actor), Array.from({ length: 100 }, (_, i) => `repeat-${i}`));
  check('100 queued requests obtain control FIFO and successfully read/write the same page');
  let active = null;
  for (const event of events) {
    if (event.type === 'granted') { assert.equal(active, null); active = event.epoch; }
    if (event.type === 'execute') assert.equal(event.epoch, active);
    if (event.type === 'reclaimed' && event.epoch === active) active = null;
  }
  assert.equal(active, null);
  assert.equal(events.filter(e => e.type === 'browser-detached').length, events.filter(e => e.type === 'reclaimed').length);
  assert.equal(events.filter(e => e.type === 'granted').length, events.filter(e => e.type === 'worker-exit').length);
  assert((await admin.call('Target.getTargets')).targetInfos.some(t => t.targetId === target));
  const lastInfo = await (await fetch(`${endpoint}/json/version`)).json();
  assert.equal(lastInfo.webSocketDebuggerUrl, info.webSocketDebuggerUrl);
  check('non-overlapping control intervals; every worker exits; shared target and browser identity preserved');
  // Fail the browser-side barrier deliberately: never grant a waiting caller.
  const quarantineHolder = await acquire('quarantine-holder');
  const quarantinedWaiter = acquire('quarantined-waiter');
  const quarantineCheck = assert.rejects(quarantinedWaiter, /unavailable/);
  coordinator.verifyReclaimed = async () => { throw new Error('Injected browser-side reclaim failure'); };
  await coordinator.release(quarantineHolder);
  await quarantineCheck;
  assert(!events.some(e => e.type === 'granted' && e.actor === 'quarantined-waiter'));
  assert.equal(await coordinator.execute(quarantineHolder, 'read').then(() => false, () => true), true);
  assert.equal(coordinator.holder.state, 'quarantined');
  check('failed reclaim barrier reports unavailable and never grants a second controller');
  const grants = events.filter(e => e.type === 'granted');
  const recovery = events.filter(e => e.type === 'reclaimed').map(e => e.ms - events.find(x => x.type === 'revoking' && x.epoch === e.epoch).ms).sort((a,b) => a-b);
  const summary = { ok: true, browser: info.Browser, platform: `${process.platform}/${process.arch}`, checks, grants: grants.length,
    reclaimMs: { max: recovery.at(-1), p95: recovery[Math.floor(recovery.length * .95)] },
    limitation: 'Deterministic callers and child CDP workers; no real model agents, production browser-use adapter, coordinator restart or browser restart test. Cooperative local boundary only.' };
  await writeFile(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await coordinator?.close();
  if (target) {
    await admin.call('Target.closeTarget', { targetId: target });
    for (let i = 0; i < 50; i++) {
      if (!(await admin.call('Target.getTargets')).targetInfos.some(t => t.targetId === target)) break;
      await delay(100);
    }
    assert(!(await admin.call('Target.getTargets')).targetInfos.some(t => t.targetId === target));
  }
  await admin.close();
  await writeFile(resolve(output, 'events.ndjson'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}
