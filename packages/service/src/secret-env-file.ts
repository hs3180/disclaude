import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';

/** Explicit host-owned file, loaded before core config imports. No interpolation or shell evaluation. */
export function loadSecretEnvFile(file: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!file) {return;}
  let fd: number;
  try {fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);}
  catch {throw new Error('Cannot open the external secret environment file');}
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('DISCLAUDE_SECRET_ENV_FILE must be a regular owner-only file (0600 or 0400), at most 1 MiB');
    }
    const parsed: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [index, line] of readFileSync(fd, 'utf8').split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {continue;}
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) {throw new Error(`Invalid secret environment entry at line ${index + 1}; use KEY=VALUE`);}
      const [, key, raw] = match;
      let value = raw;
      if (/^["']/.test(raw)) {
        if (raw.length < 2 || raw.at(-1) !== raw[0]) {throw new Error(`Invalid secret environment quoting at line ${index + 1}`);}
        value = raw.slice(1, -1);
      }
      parsed[key] = value;
    }
    // Parse completely before mutating. The inherited environment, including an
    // explicitly empty value, wins over the file. Config env is never a fallback.
    for (const [key, value] of Object.entries(parsed)) {if (env[key] === undefined) {env[key] = value;}}
  } finally {closeSync(fd);}
}
