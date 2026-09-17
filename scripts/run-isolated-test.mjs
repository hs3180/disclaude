#!/usr/bin/env node
// POSIX process-group ownership for foreground-only tests. Never use for tests
// installing launchd/systemd jobs, Docker resources, or detached processes.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform === 'win32') throw new Error('Owned test process groups require macOS or Linux');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator === args.length - 1 || args.slice(0, separator).some(a => a !== '--keep-temp')) {
  throw new Error('Usage: node scripts/run-isolated-test.mjs [--keep-temp] -- command [args...]');
}
const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const keep = args.includes('--keep-temp');
const uid = process.getuid();
const registry = join(tmpdir(), `disclaude-owned-tests-v1-${uid}`);
mkdirSync(registry, { recursive: true, mode: 0o700 });
function privateDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) {
    throw new Error(`Refusing non-private test directory: ${path}`);
  }
}
privateDirectory(registry);
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
function remove(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
// Only protocol-owned directories with both owner and process group absent.
// Reaping never sends a signal, and never infers ownership from age or a prefix alone.
for (const name of readdirSync(registry)) {
  if (!/^run-[A-Za-z0-9]+$/.test(name)) continue;
  const root = join(registry, name);
  try {
    privateDirectory(root);
    const marker = join(root, 'owner.json');
    const info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) throw new Error('Invalid owner marker');
    const owner = JSON.parse(readFileSync(marker, 'utf8'));
    if (owner.protocol !== 1 || owner.root !== root || owner.uid !== uid
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
      || !Number.isSafeInteger(owner.pgid) || owner.pgid <= 1) throw new Error('Incomplete owner marker');
    if (owner.keep || alive(owner.pid) || alive(-owner.pgid)) continue;
    remove(root);
    console.log(`OWNED_TEST_REAPED ${root}`);
  } catch (error) {
    if (error.code !== 'ENOENT' || existsSync(root)) console.error(`OWNED_TEST_REAP_SKIPPED ${root}: ${error.message}`);
  }
}
const root = mkdtempSync(join(registry, 'run-'));
const scratch = join(root, 'tmp');
mkdirSync(scratch, { mode: 0o700 });
console.log(`OWNED_TEST_ROOT ${root}`);
// The child cannot run the test before its group is recorded durably enough for
// the next invocation to inspect. An interrupted initialization expires in 30s.
const gate = join(root, 'start');
const launcher = `
const {existsSync}=require('node:fs');
const {spawn}=require('node:child_process');
const [gate,command,...args]=process.argv.slice(1);
const deadline=Date.now()+30000;
const timer=setInterval(()=>{
  if(!existsSync(gate)){if(Date.now()>deadline)process.exit(1);return;}
  clearInterval(timer);
  const child=spawn(command,args,{stdio:'inherit',env:process.env});
  child.on('error',error=>{console.error(error.message);process.exit(1);});
  child.on('exit',(code)=>process.exit(code??1));
},25);
`;
let child;
let stopping = false;
let receivedSignal;
const signalGroup = signal => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error(`OWNED_TEST_SIGNAL_FAILED ${root}: ${error.message}`); }
};
const stop = signal => { receivedSignal ??= signal; stopping = true; signalGroup(signal); };
const onTerm = () => stop('SIGTERM');
const onInt = () => stop('SIGINT');
process.on('SIGTERM', onTerm);
process.on('SIGINT', onInt);
try {
  child = spawn(process.execPath, ['-e', launcher, gate, command, ...commandArgs], {
    detached: true, stdio: 'inherit', env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
  });
  const closed = new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1); });
    child.once('close', code => resolve(code ?? 1));
  });
  if (!child.pid) { process.exitCode = await closed; }
  else {
    const marker = join(root, 'owner.json');
    writeFileSync(`${marker}.new`, JSON.stringify({ protocol: 1, root, uid, pid: process.pid, pgid: child.pid, keep }), { mode: 0o600 });
    renameSync(`${marker}.new`, marker);
    if (stopping) signalGroup(receivedSignal);
    else writeFileSync(gate, '', { mode: 0o600 });
    // Keep observing the same child; signal receipt starts a bounded shutdown.
    let result;
    void closed.then(code => { result = code; });
    while (result === undefined && !stopping) await delay(50);
    if (stopping) {
      process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
    } else process.exitCode = result;
  }
} finally {
  // A foreground test can leave children in its group after its main process
  // exits. Request graceful exit, then retain rather than deleting live files.
  if (child?.pid && alive(-child.pid)) {
    signalGroup('SIGTERM');
    const deadline = Date.now() + 15_000;
    while (alive(-child.pid) && Date.now() < deadline) await delay(100);
  }
  const live = child?.pid && alive(-child.pid);
  if (live || keep) {
    console.error(`OWNED_TEST_RETAINED ${root}: ${live ? 'process group still present' : 'explicit --keep-temp'}; confirm all owned processes have stopped before manual removal`);
    if (live) { process.exitCode ||= 1; child.unref(); }
  } else {
    try { remove(root); console.log(`OWNED_TEST_CLEANUP_OK ${root}`); }
    catch (error) { console.error(`OWNED_TEST_CLEANUP_FAILED ${root}: ${error.message}`); process.exitCode ||= 1; }
  }
  process.removeListener('SIGTERM', onTerm);
  process.removeListener('SIGINT', onInt);
}
