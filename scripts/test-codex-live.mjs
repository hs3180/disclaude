import { CodexAgentProvider } from '../packages/core/dist/sdk/providers/codex/provider.js';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) {
  console.error(
    'Usage: node scripts/test-codex-live.mjs --output <directory> (uses authenticated Codex; optional DIS' +
      'CLAUDE_TEST_MODEL)'
  );
  process.exit(2);
}
const output = resolve(process.argv[outputIndex + 1]);
mkdirSync(output, { recursive: true });
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const model = process.env.DISCLAUDE_TEST_MODEL ?? 'gpt-5.6-sol';
const cwd = mkdtempSync(join(tmpdir(), 'disclaude-control-'));
const provider = new CodexAgentProvider({
  transport: 'app-server',
  sandboxOverride: 'workspace-write',
  builtinsDir: cwd,
  execTimeoutMs: 90000,
});
const records = [];
for (const mode of ['tool', 'steer', 'cancel', 'resume']) {
  let stream,
    controlled = false;
  const row = { mode, events: [] };
  const started = Date.now();
  const timer = setTimeout(() => {
    row.timeout = true;
    stream?.handle.close();
  }, 90000);
  try {
    stream = provider.queryStream(
      (async function* () {
        yield {
          role: 'user',
          content:
            mode === 'tool'
              ? 'Use a shell tool to write exactly RELEASE_TOOL_OK into release-proof.txt in the current directory and read it back. Reply only RELEASE_TOOL_OK. Do not access other directories or network.'
              : mode === 'resume'
                ? 'Respond with exactly RESUMED_OK. Do not use tools.'
                : 'Run a shell command that sleeps for 10 seconds. After it completes, reply with ORIGINAL_PLAN. Stay in this directory and do not use network.',
        };
      })(),
      {
        cwd,
        sessionKey: 'control-test',
        model,
        permissionMode: 'bypassPermissions',
        settingSources: [],
      }
    );
    for await (const event of stream.iterator) {
      row.events.push(event);
      if (
        !controlled &&
        ['steer', 'cancel'].includes(mode) &&
        (mode === 'cancel' ? event.type === 'tool_use' : event.type === 'status')
      ) {
        controlled = true;
        if (mode === 'steer') {
          row.ack = await stream.handle.steer(
            'Change the final reply to exactly STEERED_OK. Do not say ORIGINAL_PLAN.'
          );
        } else {
          row.cancelAtMs = Date.now() - started;
          stream.handle.cancel();
        }
      }
    }
    row.elapsedMs = Date.now() - started;
    const texts = row.events
      .filter((e) => e.type === 'text')
      .map((e) => e.content)
      .join('\n');
    row.pass =
      mode === 'tool'
        ? existsSync(join(cwd, 'release-proof.txt')) &&
          readFileSync(join(cwd, 'release-proof.txt'), 'utf8').trim() === 'RELEASE_TOOL_OK' &&
          texts.includes('RELEASE_TOOL_OK')
        : mode === 'steer'
          ? !!row.ack && texts.includes('STEERED_OK') && !texts.includes('ORIGINAL_PLAN')
          : mode === 'resume'
            ? texts.includes('RESUMED_OK')
            : controlled && !row.events.some((e) => e.type === 'result');
    if (
      row.timeout ||
      row.events.some(
        (e) =>
          e.type === 'error' &&
          !(mode === 'cancel' && e.content === 'codex app-server stream cancelled')
      )
    ) {
      row.pass = false;
    }
  } catch (e) {
    row.error = e.message;
    row.pass = false;
  } finally {
    clearTimeout(timer);
    stream?.handle.close();
    records.push(row);
    console.log(JSON.stringify({ mode, pass: row.pass, error: row.error }));
  }
}
provider.dispose();
writeFileSync(
  join(output, 'codex-live.json'),
  JSON.stringify({ candidate, model, cwd, records }, null, 2)
);
process.exitCode = records.every((r) => r.pass) ? 0 : 1;
