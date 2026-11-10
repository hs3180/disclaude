#!/usr/bin/env node
/** Unified agent harness install/check CLI; thin router into @disclaude/core. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarnessCli } from '../packages/core/dist/harness/cli.js';

// The disclaude install root: where `pi` runtime packages install for
// production Node module resolution, and where `npm -g`/lockfile-less installs
// anchor. bin/ sits directly under the root in both installs and checkouts.
const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const code = await runHarnessCli(process.argv.slice(2), {
    installRoot,
    env: process.env,
  });
  process.exitCode = code;
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    })
  );
  process.exitCode = 1;
}
