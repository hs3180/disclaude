import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type ProcessIdentity = { pid: number; parent: number; group: number; owner: number; started: string };
export type OwnedDescendantGroup = Omit<ProcessIdentity, 'parent'>;

async function snapshot(): Promise<ProcessIdentity[]> {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]), owner: Number(row[4]), started: row[5] }] : [];
  });
}

/** Capture ancestry while the app-server is still alive, before reparenting.
 * Only independent groups whose live leader is a descendant are eligible.
 * Unknown/reparented children and a crashed parent cannot be reconstructed.
 */
export async function captureDescendantGroups(parent: number): Promise<OwnedDescendantGroup[]> {
  if (process.platform === 'win32' || !Number.isSafeInteger(parent) || parent <= 0) { return []; }
  const rows = await snapshot();
  const root = rows.find(row => row.pid === parent);
  if (!root) { return []; }
  const descendants = new Set([parent]);
  let previous = 0;
  while (previous !== descendants.size) {
    previous = descendants.size;
    for (const row of rows) { if (descendants.has(row.parent)) { descendants.add(row.pid); } }
  }
  return rows.filter(row => row.pid !== parent && descendants.has(row.pid)
    && row.pid === row.group && row.owner === root.owner);
}

/** Recheck the group leader identity before each escalation. Never signal a
 * reused PID or an unrelated process group, and never inspect argv/environment.
 */
export async function signalDescendantGroups(groups: OwnedDescendantGroup[], signal: NodeJS.Signals): Promise<void> {
  if (!groups.length) { return; }
  const current = await snapshot();
  for (const group of groups) {
    const same = current.find(row => row.pid === group.pid && row.group === group.group
      && row.owner === group.owner && row.started === group.started);
    if (!same) { continue; }
    try { process.kill(-group.group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
  }
}
