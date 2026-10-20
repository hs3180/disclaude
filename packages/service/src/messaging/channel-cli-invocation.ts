import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pin managed operations to the service installation, independent of shell PATH. */
export function runningChannelCliInvocation(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 7; depth += 1) {
    const cli = join(root, 'bin', 'disclaude.js');
    if (existsSync(cli)) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string };
        if (pkg.name === 'disclaude') {
          const quote = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;
          return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(cli)} channel`;
        }
      } catch { /* Continue to the enclosing distribution root. */ }
    }
    const parent = dirname(root);
    if (parent === root) { break; }
    root = parent;
  }
  return 'disclaude channel';
}
