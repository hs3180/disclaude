/** Append-only execution history command. Reads one Markdown entry from stdin. */
import * as path from 'node:path';
import { MAX_TASK_RECORD_BYTES, TaskRecordStore } from './task-record-store.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) {
    console.log('Usage: disclaude record-task append YYYY-MM < entry.md\nUses the absolute DISCLAUDE_WORKSPACE_DIR; appends one Markdown entry (up to 64 KiB).');
    return;
  }
  if (args.length !== 2 || args[0] !== 'append') {
    throw new Error('Usage: disclaude record-task append YYYY-MM < entry.md');
  }
  const workspace = process.env.DISCLAUDE_WORKSPACE_DIR;
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('DISCLAUDE_WORKSPACE_DIR must be an absolute workspace path');
  }
  const store = new TaskRecordStore(workspace);
  store.getMonthlyPath(args[1]); // Validate before waiting for stdin.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_TASK_RECORD_BYTES) {
      throw new Error('Task record exceeds 64 KiB');
    }
    chunks.push(bytes);
  }
  const file = await store.append(args[1], Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify({ ok: true, file }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
