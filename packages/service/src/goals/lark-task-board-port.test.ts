import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLarkTaskBoardPort } from './lark-task-board-port.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const target = { baseToken: 'actualBase', tableId: 'tblActual', recordId: 'recActual' };
const schema = { columns: { task: { field_id: 'fldTask', field_type: 'text', physical_type: 'string' },
  note: { field_id: 'fldNote', field_type: 'formula', physical_type: 'string' },
  status: { field_id: 'fldStatus', field_type: 'select', physical_type: 'list' } } };
async function fixture(mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'lark-board-port-')); roots.push(root);
  const bin = join(root, 'bin'); await mkdir(bin); const calls = join(root, 'calls.ndjson');
  // Real execFile/argv/artifact handling, with a private executable that cannot
  // reach the actual lark CLI, auth state or network.
  await writeFile(join(bin, 'lark-cli'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),flag=name=>args[args.indexOf(name)+1];
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cwd:process.cwd()})+'\\n');
const mode=${JSON.stringify(mode)};
if(mode==='cli-error'){process.stderr.write('private credential detail must not escape');process.exit(1);}
if(args[1]==='+record-get'){
  const out=flag('--output');
  const row={record_id:mode==='wrong-record'?'recOther':flag('--record-id'),task:'task-A',status:['todo']};
  if(mode==='empty-text'||mode==='after-empty-write'){row.task=null;}
  if(mode==='empty-formula'){row.task='task-A';row.note=null;}
  fs.writeFileSync(out,JSON.stringify(row)+'\\n');
  if(mode!=='no-sidecar'){
    fs.writeFileSync(out+'.manifest.json',mode==='corrupt-sidecar'?'not json':JSON.stringify(${JSON.stringify(schema)}));
  }
  process.stdout.write(JSON.stringify({base_token:flag('--base-token'),table_id:flag('--table-id'),
    records_count:mode==='extra-record'?2:1,has_more:false}));
}else{
  process.stdout.write(JSON.stringify({ok:mode!=='bad-ack',identity:mode==='wrong-identity'?'bot':'user'}));
}
`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  return { root, calls, port: createLarkTaskBoardPort(target, ['task', 'status']) };
}

it('uses exact argv, fixed coordinates, user identity and a private bounded record artifact', async () => {
  const f = await fixture(); expect(await f.port.read()).toEqual({ recordId: target.recordId, fields: { task: 'task-A', status: ['todo'] } });
  await f.port.patch({ status: ['running; $(not-a-shell)'] });
  const calls = (await readFile(f.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; cwd: string });
  expect(calls).toHaveLength(2);
  expect(calls[0].args).toEqual(['base', '+record-get', '--as', 'user', '--base-token', target.baseToken,
    '--table-id', target.tableId, '--record-id', target.recordId, '--field-id', 'task', '--field-id', 'status',
    '--format', 'ndjson', '--output', './record.ndjson']);
  expect(JSON.parse(calls[1].args.at(-1)!)).toEqual({ status: ['running; $(not-a-shell)'] });
  for (const call of calls) { await expect(access(call.cwd)).rejects.toThrow(); }
});

it.each(['wrong-record', 'extra-record', 'cli-error'])('refuses an unconfirmed fixed record: %s', async mode => {
  const f = await fixture(mode); await expect(f.port.read()).rejects.toThrow();
});

it.each(['bad-ack', 'wrong-identity', 'cli-error'])('refuses an unconfirmed user write receipt: %s', async mode => {
  const f = await fixture(mode); await expect(f.port.patch({ status: ['running'] })).rejects.toThrow();
  if (mode === 'cli-error') { await expect(f.port.patch({ status: ['running'] })).rejects.not.toThrow('private credential'); }
});

it('pins the target/field projection and rejects arbitrary record or field writes', async () => {
  const f = await fixture(); await expect(f.port.patch({ other: 'overwrite' })).rejects.toThrow('fixed field');
  expect(() => createLarkTaskBoardPort({ ...target, recordId: 'not-a-record' }, ['task'])).toThrow();
  expect(() => createLarkTaskBoardPort({ ...target, baseToken: 'base;command' }, ['task'])).toThrow();
});

it('normalizes a schema-proved empty text cell to the empty string it was written as', async () => {
  const f = await fixture('empty-text'); expect(await f.port.read()).toEqual({ recordId: target.recordId, fields: { task: '', status: ['todo'] } });
  // The original failure: a written '' read back as null left the write unconfirmed.
  const g = await fixture('after-empty-write'); await g.port.patch({ task: '' });
  expect(await g.port.read()).toEqual({ recordId: target.recordId, fields: { task: '', status: ['todo'] } });
});

it('keeps null that the column schema does not prove is plain text', async () => {
  await fixture('empty-formula'); const port = createLarkTaskBoardPort(target, ['task', 'status', 'note']);
  expect(await port.read()).toEqual({ recordId: target.recordId, fields: { task: 'task-A', status: ['todo'], note: null } });
  const g = await fixture('no-sidecar');
  expect(await g.port.read()).toEqual({ recordId: target.recordId, fields: { task: 'task-A', status: ['todo'] } });
});

it('refuses a present but unreadable column schema artifact', async () => {
  const f = await fixture('corrupt-sidecar'); await expect(f.port.read()).rejects.toThrow('column schema');
});
