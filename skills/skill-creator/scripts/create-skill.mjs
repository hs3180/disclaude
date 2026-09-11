#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [name, parent, description, command, ...extra] = process.argv.slice(2);
if (!name || !parent || !description || !command || extra.length ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63 ||
    /[\r\n\0]/.test(description + command)) {
  console.error('Usage: node create-skill.mjs <name> <parent-directory> <description> <external-executable>');
  process.exit(1);
}

const target = resolve(parent, name);
const executable = `'${command.replaceAll("'", "'\\''")}'`;
const content = `---
name: ${name}
description: ${JSON.stringify(description)}
allowed-tools: [Read, Bash]
---

# ${name}

${description}

## External runtime

This skill uses the externally installed executable ${JSON.stringify(command)}.
Inspect its supported commands before choosing arguments:

~~~sh
${executable} --help
~~~

Run only operations needed for the user's request. Read the external tool's
authentication instructions when access is required. If the executable or
authorization is missing, report the missing prerequisite; do not claim success.

The agent and external provider skill choose the authentication exchange,
permissions, refresh and storage. Disclaude does not supply provider credentials.
Use a configured private handoff for user-supplied secret input; do not ask for
it in ordinary chat. A workspace .runtime-env is shared across sessions and
agents, so it is not a task-private credential store.

## Results

Report the requested result with the tool's success/failure status. Keep private
handoff payloads out of ordinary messages and tool results. For mutating actions,
check the user's authorization and the tool's documented outcome.
`;

try {
  mkdirSync(resolve(parent), { recursive: true });
  // Refuse an existing directory rather than overwriting an installed skill.
  mkdirSync(target);
  writeFileSync(join(target, 'SKILL.md'), content, { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, path: target }));
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Skill directory already exists' : 'Could not create skill');
  process.exitCode = 1;
}
