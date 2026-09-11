import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// npm's global Git dependency preparation can inherit global/prefix settings,
// installing the clone itself globally instead of its workspace dependencies.
// Bootstrap only that temporary Git preparation, with explicitly local scope.
if (process.env._PACOTE_NO_PREPARE_ && !existsSync(join(root, 'node_modules/typescript/bin/tsc'))) {
  if (!process.env.npm_execpath) throw new Error('Git preparation requires npm_execpath');
  const result = spawnSync(process.execPath, [
    process.env.npm_execpath, 'install', '--global=false', '--prefix', root,
    '--ignore-scripts', '--include=dev', '--include=optional', '--no-audit', '--no-fund',
  ], { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Git consumers do not need developer hooks. Production installs may not have
// Husky at all; absence must not make installation fail.
if (!process.env._PACOTE_NO_PREPARE_ && process.env.HUSKY !== '0' && !process.env.CI && existsSync(join(root, '.git'))) {
  const huskyPath = join(root, 'node_modules/husky/index.js');
  if (existsSync(huskyPath)) {
    const { default: husky } = await import(huskyPath);
    const message = husky();
    if (message) console.error(message);
  }
}
