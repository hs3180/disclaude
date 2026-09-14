import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectBrowser } from './client.mjs';
import { launchBrowser } from './managed-browser.mjs';
import { connect } from './cdp.mjs';
const output = resolve(process.argv[2] || './harness-evidence'); await mkdir(output, { recursive: true });
await rm(resolve(output,'failure.json'),{force:true});
const runtime = await mkdtemp('/tmp/dcbs-');
const profile = resolve(runtime, 'profile');
const socket = resolve(runtime, 'browser.sock');
await rm(resolve(output,'summary.json'), {force:true});
const journal = resolve(output, 'events.ndjson'); await writeFile(journal, '');
const binary = process.env.DISCLAUDE_CHROMIUM_BINARY;
if (!binary) throw new Error('Set DISCLAUDE_CHROMIUM_BINARY to an independent Chromium executable');
let browser, service, admin, ready; const clients = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const persistence = { required: process.env.DISCLAUDE_BROWSER_REQUIRE_PERSISTENCE === '1', retained: null, scope: 'browser-restart', storage: 'system-default' };
const check = text => { checks.push(text); console.log('PASS '+text); };
const acquire = async () => {
  const client = await connectBrowser(socket); clients.push(client);
  assert.equal((await client.request('acquire')).state, 'queued');
  return client;
};
const run = async (client, script) => {
  const result = await client.request('execute', { script });
  assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
};
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await exited; clearTimeout(timer);
}
try {
  const managed = process.env.DISCLAUDE_BROWSER_MANAGED === '1';
  if (!managed) browser = spawn(binary, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir='+profile, '--no-first-run', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; !managed && i < 100; i++) {
    try { port = (await readFile(resolve(profile,'DevToolsActivePort'), 'utf8')).split('\n')[0]; if (port) break; } catch {}
    if (browser.exitCode !== null) throw new Error('Chromium exited during startup');
    await delay(100);
  }
  if (!managed) assert(port, 'Chromium endpoint discovery failed');
  let endpoint = managed ? '' : `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, [new URL('./service.mjs', import.meta.url).pathname], {
    env: { ...process.env, BU_CDP_URL: endpoint, DISCLAUDE_CHROMIUM_BINARY: managed ? binary : '', DISCLAUDE_CHROMIUM_PROFILE: profile, DISCLAUDE_CHROMIUM_HEADLESS: '1', DISCLAUDE_BROWSER_SOCKET: socket,
      DISCLAUDE_BROWSER_EVENTS: journal, DISCLAUDE_BROWSER_WORKSPACE: output,
    }, stdio: ['ignore','pipe','pipe'] });
  let stderr = '', stdout = ''; service.stderr.on('data', d => stderr += d);
  ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service readiness timeout: '+stderr)), 15000);
    service.once('exit', () => { clearTimeout(timer); reject(new Error('Service exited: '+stderr)); });
    service.stdout.on('data', d => { stdout += d; if (stdout.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(stdout.split('\n')[0])); } });
  });
  if (managed) endpoint = `http://127.0.0.1:${(await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]}`;
  const info = await (await fetch(endpoint+'/json/version')).json(); admin = await connect(info.webSocketDebuggerUrl);
  assert.equal(ready.managed, managed);
  check(managed ? 'service launches Chromium on port 0 and discovers its endpoint' : 'service attaches to configured Chromium endpoint');
  const abandoned = await acquire(); abandoned.close();
  const statusClient = await connectBrowser(socket); clients.push(statusClient);
  await assert.rejects(statusClient.request('not-a-method'), /Unknown method/);
  assert((await statusClient.request('status')).state);
  const a = await acquire(); await a.request('wait');
  const b = await acquire(); let bHeld = false;
  const bWait = b.request('wait').then(result => { bHeld = true; return result; });
  bWait.catch(() => {});
  await run(a, "js(\"document.body.innerHTML='<h1>Shared harness</h1><input id=name><p id=result>initial</p>'\")\nfill_input('#name','A saved')\njs(\"document.querySelector('#result').textContent=document.querySelector('#name').value\")\n");
  assert.equal(bHeld, false);
  assert.equal(await run(a,"print(js(\"document.querySelector('#result').textContent\"))"), 'A saved');
  await a.request('release'); await bWait;
  assert.equal(await run(b,"print(js(\"document.querySelector('#result').textContent\"))"), 'A saved');
  await assert.rejects(a.request('execute',{script:'print(1)'}), /not current/);
  assert.equal((await a.request('release')).released, false);
  await run(b,"fill_input('#name','B saved')\njs(\"document.querySelector('#result').textContent=document.querySelector('#name').value\")\nprint(capture_screenshot(path='shared-harness.png'))");
  await b.request('release');
  check('real browser-use helpers share state across two queued clients; stale client cannot interfere');
  check('cancelled allocation and invalid IPC method do not poison the next request');

  const dying = await acquire(); await dying.request('wait');
  const successor = await acquire(); const successorWait = successor.request('wait'); successorWait.catch(() => {});
  const unknown = dying.request('execute',{script:"import time\ntime.sleep(20)\njs(\"document.querySelector('#result').textContent='must-not-run'\")"});
  const unknownCheck = assert.rejects(unknown,/closed/);
  await delay(300); dying.close(); await unknownCheck;
  await successorWait;
  assert.equal(await run(successor,"print(js(\"document.querySelector('#result').textContent\"))"), 'B saved');
  await successor.request('release');
  check('caller disconnect cancels running CLI and harness; queued client successfully takes control');

  const crashed = await acquire(); await crashed.request('wait');
  const afterCrash = await acquire(); const afterCrashWait = afterCrash.request('wait'); afterCrashWait.catch(() => {});
  const events = (await readFile(journal,'utf8')).trim().split('\n').map(JSON.parse);
  const daemon = events.filter(e=>e.type==='daemon-started').at(-1);
  assert(daemon?.pid>1); process.kill(daemon.pid,'SIGKILL');
  await afterCrashWait;
  assert.equal(await run(afterCrash,"print(js(\"document.querySelector('#result').textContent\"))"),'B saved');
  await afterCrash.request('release');
  check('owned harness daemon death releases control; next client creates a healthy existing-daemon session');

  const holder = await acquire(); await holder.request('wait');
  const cancelled = await acquire(); cancelled.close();
  const last = await acquire(); const lastWait = last.request('wait'); lastWait.catch(() => {});
  await holder.request('release'); await lastWait;
  assert.equal(await run(last,"print(js(\"document.querySelector('#result').textContent\"))"),'B saved');
  await last.request('release');
  check('queued client cancellation does not block a later caller');

  const expiring = await acquire(); await expiring.request('wait');
  const afterExpiry = await acquire(); await afterExpiry.request('wait');
  assert.equal(await run(afterExpiry,"print(js(\"document.querySelector('#result').textContent\"))"),'B saved');
  await afterExpiry.request('release');
  check('silent holder expires and waiting IPC client successfully operates');

  const cliResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./bin/browser-use', import.meta.url).pathname], {
      env: { ...process.env, BU_CDP_URL: '', BU_CDP_WS: '', DISCLAUDE_BROWSER_SOCKET: socket     }, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.once('error', reject); child.once('exit', code => resolve({code,stdout,stderr}));
    child.stdin.end("import time\ntime.sleep(6)\nprint(js(\"document.querySelector('#result').textContent\"))");
  });
  assert.equal(cliResult.code,0,cliResult.stderr); assert.equal(cliResult.stdout.trim(),'B saved');
  check('stdin CLI uses socket only; heartbeat sustains a script beyond the lease TTL');

  const taskDir = resolve(output,'task-cwd'); await mkdir(taskDir,{recursive:true});
  const scoped = await acquire(); await scoped.request('wait');
  const scopedResult = await scoped.request('execute', {cwd:taskDir,script:"import pathlib\npathlib.Path('cwd-proof.txt').write_text('owned task artifact')\nprint(capture_screenshot(path='task.png'))"});
  assert.equal(scopedResult.code,0,scopedResult.stderr);
  assert.equal(await readFile(resolve(taskDir,'cwd-proof.txt'),'utf8'),'owned task artifact');
  assert((await readFile(resolve(taskDir,'task.png'))).length>8);
  await assert.rejects(scoped.request('execute',{cwd:'relative',script:'print(1)'}),/absolute directory/);
  await scoped.request('release');
  check('caller working directory controls task artifact paths; invalid cwd is rejected');

  for(let i=0;i<10;i++) {
    const client = await acquire(); await client.request('wait');
    assert.equal(await run(client,"print(js(\"document.querySelector('#result').textContent\"))"), i ? `round-${i-1}` : 'B saved');
    await run(client,`js("document.querySelector('#result').textContent='round-${i}'")`);
    await client.request('release'); client.close();
  }
  check('10 repeated real harness handoffs preserve one shared page');
  const opening = await acquire(); await opening.request('wait');
  const opened = await run(opening,"tid=cdp('Target.createTarget',url='about:blank',background=True)['targetId']\nswitch_tab(tid)\njs(\"document.body.innerHTML='<h1>handoff new tab</h1>'\")\nprint(tid)");
  await opening.request('release');
  const resumed = await acquire(); await resumed.request('wait');
  assert.equal(await run(resumed,'print(current_tab()["targetId"])'),opened);
  await run(resumed,'close_tab(current_tab()["targetId"])');
  await resumed.request('release');
  const afterClose = await acquire(); await afterClose.request('wait');
  assert.equal(await run(afterClose,'print(bool(current_tab()["targetId"]))'),'True');
  await afterClose.request('release');
  check('changed current tab survives handoff; closing the current tab does not strand the next caller');
  assert.equal((await admin.call('Target.getTargetInfo',{targetId:ready.target})).targetInfo.attached,false);
  const png=await readFile(resolve(output,'shared-harness.png')); assert(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  if (managed) {
    const persister = await acquire(); await persister.request('wait');
    await run(persister, "import time\nassert cdp('Network.setCookie',name='ipc_lab',value='persisted',url='https://lab.example.test/',expires=time.time()+3600)['success']");
    assert((await admin.call('Storage.getCookies')).cookies.some(cookie=>cookie.name==='ipc_lab' && cookie.value==='persisted'), 'cookie missing before release');
    await persister.request('release');
    assert((await admin.call('Storage.getCookies')).cookies.some(cookie=>cookie.name==='ipc_lab' && cookie.value==='persisted'), 'cookie missing after release');
    for (const client of clients) client.close();
    await admin.close(); admin = null;
    await stop(service); service = null; ready = null;
    const restored = await launchBrowser({binary,profile,headless:true}); browser = restored.child;
    const restoredInfo = await (await fetch(restored.endpoint+'/json/version')).json();
    admin = await connect(restoredInfo.webSocketDebuggerUrl);
    persistence.retained = (await admin.call('Storage.getCookies')).cookies.some(cookie=>cookie.name==='ipc_lab' && cookie.value==='persisted');
    if (persistence.required) assert(persistence.retained, 'required cookie persistence unavailable after browser restart');
    console.log('CAPABILITY '+JSON.stringify({persistence}));
    if (persistence.retained) check('managed service shutdown flushes cookies; reopening the same profile retains them');
    else console.log('INFO browser-restart cookie retention unavailable; normal browser control remains supported');
  }
  await writeFile(resolve(output,'summary.json'),JSON.stringify({ok:true,platform:`${process.platform}/${process.arch}`,browser:info.Browser,checks,persistence},null,2));
} catch (error) {
  await writeFile(resolve(output,'failure.json'),JSON.stringify({ok:false,error:error.message,checks,persistence},null,2));
  throw error;
} finally {
  for(const client of clients) client.close();
  if (ready && admin) await admin.call('Target.closeTarget',{targetId:ready.target});
  await admin?.close(); await stop(service); await stop(browser); await rm(runtime,{recursive:true,force:true});
}
