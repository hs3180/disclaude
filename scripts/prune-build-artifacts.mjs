import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Remove only TypeScript outputs whose source has been deleted.
 * tsc -b does not remove obsolete outputs, including outputs restored from CI
 * caches. Never follow symlinks or remove directories/unrecognized assets.
 */
export function prunePackageArtifacts(packageDir) {
  const src = join(packageDir, 'src');
  const dist = join(packageDir, 'dist');
  if (!existsSync(src)) throw new Error(`Missing source directory: ${src}`);
  if (!existsSync(dist)) return [];
  if (lstatSync(src).isSymbolicLink() || lstatSync(dist).isSymbolicLink()) {
    throw new Error(`Refusing cleanup of a symlinked source/output tree: ${packageDir}`);
  }
  const removed = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const output = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(output);
      } else if (entry.isFile()) {
        const sourceStem = relative(dist, output).replace(/(?:\.d\.ts|\.js)(?:\.map)?$/, '');
        if (sourceStem === relative(dist, output)) continue;
        if (['.ts', '.tsx', '.js', '.jsx'].some((ext) => existsSync(join(src, sourceStem + ext))))
          continue;
        unlinkSync(output);
        removed.push(output);
      }
    }
  }
  visit(dist);
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages');
  let count = 0;
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packages, entry.name);
    if (!existsSync(join(packageDir, 'tsconfig.json'))) continue;
    count += prunePackageArtifacts(packageDir).length;
  }
  if (count)
    console.error(
      `Removed ${count} obsolete generated build artifacts (rebuildable from source/history).`
    );
}
