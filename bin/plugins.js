#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manageDiagnosticsPlugin } from '../packages/core/dist/skills/diagnostics-plugin.js';

const args = process.argv.slice(2);
const help = `Usage: disclaude plugins list [--project-dir PATH]
       disclaude plugins <install|update|remove> diagnostics [--project-dir PATH]

The official diagnostics plugin is optional and diagnoses Disclaude service issues only.
Install/update copies the version bundled with this Disclaude release into the selected
project's .disclaude/plugins/diagnostics. No network, dependencies or service restart.
Default project: current directory. Start a new agent session after changing plugins.
Remove deletes only an unchanged CLI-owned installation; edited or extra files are preserved.
Commands return one JSON result; errors exit nonzero. No global or arbitrary plugin installs.`;

if (args.length === 0 || args[0] === 'help' || args.some((arg) => ['--help', '-h'].includes(arg))) {
  console.log(help);
} else {
  try {
    const command = args.shift();
    if (!['list', 'install', 'update', 'remove'].includes(command)) {
      throw new Error('Unknown plugins command');
    }
    if (command !== 'list' && args.shift() !== 'diagnostics') {
      throw new Error('Only the official diagnostics plugin is supported');
    }
    let project = process.cwd();
    if (args.length) {
      if (args.shift() !== '--project-dir' || !args[0] || args[0].startsWith('--')) {
        throw new Error('Expected --project-dir PATH');
      }
      project = resolve(args.shift());
    }
    if (args.length) {
      throw new Error('Unexpected plugins arguments');
    }
    const builtins = fileURLToPath(new URL('../', import.meta.url));
    console.log(
      JSON.stringify({
        ok: true,
        command,
        data: manageDiagnosticsPlugin(command, project, builtins),
      })
    );
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: { message: error.message } }));
    process.exitCode = 1;
  }
}
