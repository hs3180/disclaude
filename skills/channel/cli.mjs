#!/usr/bin/env node
// Compatibility shim for callers of the historical Skill path.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = resolve(root, 'packages/channel-cli/dist/cli.js');
if (!existsSync(target)) {
  process.stderr.write('channel CLI is not built; run npm run build first\n');
  process.exit(1);
}
const child = spawn(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
child.on('error', (error) => { process.stderr.write(`channel CLI failed: ${error.message}\n`); process.exit(1); });
child.on('exit', (code) => { process.exit(code ?? 1); });
