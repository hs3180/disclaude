/** Refuse foreign profile ownership and known major-version downgrades. */
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { isDescendant } from './browser-service-state.mjs';

export function assertChromiumProfileAvailable(profile, ownerPid) {
  const lock = join(profile, 'SingletonLock');
  let stat;
  try { stat = lstatSync(lock); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isSymbolicLink()) throw new Error('Browser profile has an unrecognized lock; inspect its owner before retrying. No lock was removed');
  const target = readlinkSync(lock), match = /^(.*)-(\d+)$/.exec(target);
  const pid = match ? Number(match[2]) : undefined;
  if (!match || match[1] !== hostname() || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Browser profile lock belongs to another host or has unknown ownership; profile preserved');
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw new Error('Browser profile lock owner cannot be verified; profile preserved'); }
  if (!alive) throw new Error('Browser profile has a stale lock marker; inspect it before retrying. No lock was removed');
  if (!ownerPid || !isDescendant(pid, ownerPid)) throw new Error(`Browser profile is in use by another process (${pid}); stop that browser explicitly before selecting this profile`);
}

export function assertChromiumProfileVersion(profile, browserVersion) {
  const file = join(profile, 'Last Version');
  let last;
  try {
    if (statSync(file).size > 4096) throw new Error('Browser profile version marker is too large; profile preserved');
    last = readFileSync(file, 'utf8').trim();
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const previous = /^(\d+)\.\d+\.\d+\.\d+$/.exec(last);
  const selected = /(?:^|[^\d])(\d+)\.\d+\.\d+\.\d+(?:\D|$)/.exec(browserVersion || '');
  if (!previous || !selected) throw new Error('Cannot compare profile and candidate browser versions; profile preserved');
  if (Number(selected[1]) < Number(previous[1])) throw new Error(`Browser profile was last used by ${last}; candidate ${browserVersion} is a major-version downgrade. Select a compatible browser or a different profile`);
}
