import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
/** Read only process identity/accounting columns, never command arguments or
 * environment values. Observation failure is explicit rather than fake zero
 * usage. Bounds apply to both runtime and captured output of the ps process.
 */
export async function readProcessGroupResources(groupId) {
    if (process.platform === 'win32' || !Number.isSafeInteger(groupId) || groupId <= 0) {
        return { groupId, available: false };
    }
    try {
        const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,pgid=,rss=,etime=,comm='], {
            timeout: 1000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
        });
        let processCount = 0;
        let rssKiB = 0;
        let oldestAgeSeconds = 0;
        const toolKinds = Object.create(null);
        for (const line of stdout.split('\n')) {
            const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/.exec(line);
            if (!row || Number(row[2]) !== groupId) {
                continue;
            }
            processCount++;
            rssKiB += Number(row[3]);
            const age = row[4].split('-');
            const parts = age.pop().split(':').map(Number);
            const seconds = parts.reduce((total, part) => total * 60 + part, 0) + Number(age[0] ?? 0) * 86400;
            oldestAgeSeconds = Math.max(oldestAgeSeconds, seconds);
            const kind = basename(row[5]).slice(0, 128);
            toolKinds[kind] = (toolKinds[kind] ?? 0) + 1;
        }
        return { groupId, available: true, processCount, rssKiB, oldestAgeSeconds, toolKinds };
    }
    catch {
        return { groupId, available: false };
    }
}
