import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ClaudeSDKProvider } from '../packages/core/dist/sdk/providers/claude/provider.js';
import { PiAgentProvider } from '../packages/core/dist/sdk/providers/pi/provider.js';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (
  !['--backend', '--env-file', '--model', '--output'].every(
    (name) => process.argv.includes(name) && arg(name) && !arg(name).startsWith('--')
  )
) {
  console.error(
    'Usage: node scripts/test-agent-live.mjs --backend <claude|pi> --env-file <path> --model <model> --output <directory>'
  );
  process.exit(2);
}
const backend = arg('--backend');
if (!['claude', 'pi'].includes(backend)) throw new Error('Backend must be claude or pi');
const output = arg('--output');
fs.mkdirSync(output, { recursive: true });
const config = parseEnv(fs.readFileSync(arg('--env-file'), 'utf8'));
const env = { ...process.env };
for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) if (config[k]) env[k] = config[k];
const model = arg('--model');
const cwd = fs.mkdtempSync(join(tmpdir(), 'disclaude-deepseek-acceptance-'));
env.ANTHROPIC_API_KEY = env.DEEPSEEK_API_KEY;
env.ANTHROPIC_BASE_URL = env.DEEPSEEK_BASE_URL.replace(/\/$/, '') + '/anthropic';
delete env.CLAUDE_CODE_OAUTH_TOKEN;
env.ANTHROPIC_AUTH_TOKEN = env.DEEPSEEK_API_KEY;
env.CLAUDE_CODE_MAX_RETRIES = '0';
const provider = backend === 'claude' ? new ClaudeSDKProvider() : new PiAgentProvider();
const records = [];
const marker = 'MEMORY_' + crypto.randomUUID().replaceAll('-', '');
const redact = (s) => {
  for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'])
    if (env[k]) s = s.split(env[k]).join(`[REDACTED_${k}]`);
  return s;
};
for (const mode of ['basic', 'tool', 'multi-turn', 'cancel', 'after-cancel']) {
  const row = { mode, events: [] };
  let stream;
  let wake;
  const firstDone = new Promise((r) => {
    wake = r;
  });
  const start = Date.now();
  let controlled = false;
  const timer = setTimeout(() => {
    row.timeout = true;
    wake();
    stream?.handle.close();
  }, 120000);
  try {
    stream = provider.queryStream(
      (async function* () {
        yield {
          role: 'user',
          content:
            mode === 'basic'
              ? 'Reply exactly DEEPSEEK_050_OK. Do not use tools.'
              : mode === 'tool'
                ? 'Use a shell tool to write exactly DEEPSEEK_TOOL_OK to release-proof.txt in the current directory, then read it back. Reply only DEEPSEEK_TOOL_OK. Stay in this directory; do not use network.'
                : mode === 'multi-turn'
                  ? `Remember this marker for the next question: ${marker}. Reply only STORED. Do not use tools.`
                  : mode === 'cancel'
                    ? 'Use a shell tool to sleep for 15 seconds, then reply SLEEP_FINISHED. Stay in this directory. Do not use network.'
                    : 'Reply exactly AFTER_CANCEL_OK. Do not use tools.',
        };
        if (mode === 'multi-turn') {
          await firstDone;
          yield {
            role: 'user',
            content:
              'What was the marker I asked you to remember? Reply only with that marker. Do not use tools.',
          };
        }
      })(),
      {
        cwd,
        model,
        includePartialMessages: true,
        settingSources: [],
        env,
        permissionMode: 'bypassPermissions',
        systemPrompt:
          'You are an isolated release-test agent. Follow each test instruction exactly. Do not send any channel messages or access files outside the working directory.',
        sessionKey: mode === 'after-cancel' ? 'live-cancel' : `live-${mode}`,
      }
    );
    for await (const e of stream.iterator) {
      row.events.push(e);
      if (e.type === 'result') wake();
      if (mode === 'cancel' && e.type === 'tool_use' && !controlled) {
        controlled = true;
        row.cancelAtMs = Date.now() - start;
        stream.handle.cancel();
      }
    }
    const text = row.events
      .filter((e) => e.type === 'text')
      .map((e) => e.content)
      .join('');
    const success = row.events.filter((e) => e.type === 'result').length;
    row.pass =
      mode === 'basic'
        ? success === 1 && text.includes('DEEPSEEK_050_OK')
        : mode === 'tool'
          ? success === 1 &&
            row.events.some((e) => e.type === 'tool_use') &&
            row.events.some((e) => e.type === 'tool_result') &&
            fs.existsSync(join(cwd, 'release-proof.txt')) &&
            fs.readFileSync(join(cwd, 'release-proof.txt'), 'utf8').trim() === 'DEEPSEEK_TOOL_OK'
          : mode === 'multi-turn'
            ? success === 2 && text.includes(marker)
            : mode === 'cancel'
              ? controlled &&
                !text.includes('SLEEP_FINISHED') &&
                Date.now() - start - row.cancelAtMs < 10000
              : success === 1 && text.includes('AFTER_CANCEL_OK');
    if (row.timeout || row.events.some((e) => e.type === 'error')) row.pass = false;
  } catch (e) {
    row.error = e.message;
    row.pass = false;
  } finally {
    clearTimeout(timer);
    wake();
    stream?.handle.close();
    row.elapsedMs = Date.now() - start;
    records.push(row);
    console.log(
      redact(
        JSON.stringify({
          mode,
          pass: row.pass,
          elapsedMs: row.elapsedMs,
          error: row.error,
          errors: row.events.filter((e) => e.type === 'error'),
        })
      )
    );
  }
}
provider.dispose();
const result = {
  backend,
  dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  model,
  cwd,
  records,
};
fs.writeFileSync(join(output, `${backend}-live.json`), redact(JSON.stringify(result, null, 2)), {
  mode: 0o600,
});
process.exitCode = records.every((r) => r.pass) ? 0 : 1;
