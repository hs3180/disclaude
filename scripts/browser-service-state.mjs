import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Keep backups in memory for one command; a lock prevents competing CLI updates.
export function replaceChromiumFile(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Restore configuration and the previously loaded service after failed activation. */
export async function transitionChromium({ paths, wasLoaded, prepare, stop, start, verify, verifyPrevious }) {
  const backups = paths.map(path => {
    try { return { path, bytes: readFileSync(path), mode: statSync(path).mode & 0o777 }; }
    catch (error) { if (error.code === 'ENOENT') return { path }; throw error; }
  });
  let touchedService = false;
  try {
    await prepare();
    if (wasLoaded) { touchedService = true; await stop(); }
    touchedService = true;
    await start();
    return await verify();
  } catch (failure) {
    const recovery = [];
    if (touchedService) {
      try { await stop(); } catch (error) { recovery.push(error.message); }
    }
    for (const backup of backups) {
      try {
        if (backup.bytes) replaceChromiumFile(backup.path, backup.bytes, backup.mode);
        else rmSync(backup.path, { force: true });
      } catch (error) { recovery.push(error.message); }
    }
    if (touchedService && wasLoaded && !recovery.length) {
      try { await start(); await verifyPrevious(); }
      catch (error) { recovery.push(error.message); }
    }
    throw new Error(`${failure.message}; ${recovery.length
      ? `recovery incomplete: ${recovery.join('; ')}`
      : touchedService && wasLoaded ? 'previous service restored and verified' : 'previous configuration preserved'}`);
  }
}

export function chromiumListenerPids(port) {
  try {
    return [...new Set(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\s+/).map(Number).filter(Number.isSafeInteger))];
  } catch (error) { if (error.status === 1) return []; throw error; }
}

export function isDescendant(pid, parent) {
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    if (pid === parent) return true;
    try { pid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); }
    catch { return false; }
  }
  return false;
}

export async function waitChromiumReady({ address, port }, serviceState, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let previous, stable = 0, last = 'service has no listener';
  while (Date.now() < deadline) {
    const { pid } = serviceState();
    const listeners = chromiumListenerPids(port);
    if (pid && listeners.length && listeners.every(listener => isDescendant(listener, pid))) {
      try {
        const response = await fetch(`http://${address}:${port}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
        const version = await response.json();
        if (!response.ok || typeof version.Browser !== 'string' || !/^ws:\/\//.test(version.webSocketDebuggerUrl)) throw new Error('invalid CDP discovery response');
        const identity = `${pid}:${listeners.join(',')}:${version.webSocketDebuggerUrl}`;
        stable = identity === previous ? stable + 1 : 1;
        previous = identity;
        if (stable >= 3) return { pid, endpoint: `http://${address}:${port}`, browser: version.Browser };
      } catch (error) { stable = 0; last = error.message; }
    } else { stable = 0; last = 'CDP listener does not belong to the selected service'; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Chromium readiness failed: ${last}`);
}

