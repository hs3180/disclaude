import { constants, openSync, closeSync, fstatSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

// Both wrapper and real CLI inherit the locked open-file description. Killing
// the wrapper must NOT release the lock while the CLI is still running.
// Never unlink/replace the inode or explicitly LOCK_UN the shared descriptor.
function lockCommand(wait) {
  if (process.platform === 'darwin') return ['/usr/bin/lockf', ['-s', ...(wait ? [] : ['-t', '0']), '3']];
  if (process.platform === 'linux') return ['/usr/bin/flock', ['-x', ...(wait ? [] : ['-n', '-E', '75']), '3']];
  throw new Error('Coordinated browser commands require macOS lockf or Linux flock');
}

export function openCommandLock(path) {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
    closeSync(fd);
    throw new Error('Browser command lock must be a private, owned regular file');
  }
  return fd;
}

export function tryCommandLock(fd) {
  const [command, args] = lockCommand(false);
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status === 75) return false;
  if (result.status !== 0) throw new Error(`Browser command lock failed: ${result.stderr || result.signal || result.status}`);
  return true;
}

export function waitCommandLock(fd, signal) {
  const [command, args] = lockCommand(true);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe', fd], signal });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.once('error', reject);
    child.once('exit', (code, terminated) => code === 0 ? resolve() : reject(new Error(
      `Browser command lock interrupted: ${stderr || terminated || code}`,
    )));
  });
}
