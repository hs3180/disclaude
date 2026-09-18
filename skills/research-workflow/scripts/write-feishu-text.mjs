#!/usr/bin/env node
/** One explicit document write via an argument array. Never evaluates content in a shell. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export function writeArguments(input) {
  if (!input || typeof input.documentId !== 'string' || !/^[A-Za-z0-9]+$/.test(input.documentId) ||
    !['user', 'bot'].includes(input.identity) || !['str_replace', 'append'].includes(input.command) ||
    typeof input.content !== 'string' || !input.content.length) throw new Error('invalid_write_input');
  const args = ['docs', '+update', '--doc', input.documentId, '--as', input.identity,
    '--command', input.command, '--doc-format', 'markdown', '--content', input.content];
  if (input.command === 'str_replace') {
    if (typeof input.pattern !== 'string' || !input.pattern.length) throw new Error('replacement_pattern_required');
    args.push('--pattern', input.pattern);
  }
  if (input.revision !== undefined) {
    if (typeof input.revision !== 'string' || !/^\d+$/.test(input.revision)) throw new Error('invalid_revision');
    args.push('--revision-id', input.revision);
  }
  return args;
}

export async function writeFeishuText(input, run = execute) {
  const args = writeArguments(input);
  const { stdout } = await run('lark-cli', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await writeFeishuText(JSON.parse(readFileSync(0, 'utf8')))));
  } catch {
    console.error(JSON.stringify({ ok: false, error: 'write_failed_or_unknown_read_back_before_retry' }));
    process.exitCode = 1;
  }
}
