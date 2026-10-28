import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';

export interface ProjectArtifactIdentity { ref: string; sha256: string; bytes: number }

/** Hash actual bytes from a stable, regular Project file. No model-supplied
 * digest or existence-only check can produce a review/completion receipt.
 * The host must authorize the Project and reference before calling this port.
 */
export async function readProjectArtifact(projectRoot: string, ref: string): Promise<ProjectArtifactIdentity> {
  if (!isAbsolute(projectRoot) || typeof ref !== 'string' || !ref || ref.length > 2048 ||
    isAbsolute(ref) || ref.includes('\0') || ref.includes('\\') || ref.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Expected a relative Project artifact reference');
  }
  try {
    const root = await fs.realpath(projectRoot);
    if (!(await fs.stat(root)).isDirectory()) { throw new Error(); }
    const file = join(root, ref), actual = await fs.realpath(file), inside = relative(root, actual);
    if (actual !== file || !inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) { throw new Error(); }
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) { throw new Error(); }
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs || current.dev !== before.dev || current.ino !== before.ino ||
        current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs || bytes !== Number(before.size) ||
        await fs.realpath(file) !== actual || await fs.realpath(projectRoot) !== root) { throw new Error(); }
      return { ref, sha256: hash.digest('hex'), bytes };
    } finally { await handle.close(); }
  } catch {
    throw new Error('Cannot verify a stable regular Project artifact; preserve its previous submission');
  }
}
