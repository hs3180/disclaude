import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskBoardPort } from './task-board-projection.js';

const exec = promisify(execFile);
export interface LarkTaskBoardCoordinates { baseToken: string; tableId: string; recordId: string }
/** Optional existing lark-cli, fixed original record and user identity. No
 * embedded credentials, table creation, authentication switch or shell command.
 */
export function createLarkTaskBoardPort(target: LarkTaskBoardCoordinates, fields: readonly string[]): TaskBoardPort {
  const fixed = structuredClone(target), projection = [...new Set(fields)];
  if (![fixed.baseToken, fixed.tableId, fixed.recordId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,512}$/.test(value)) ||
      !fixed.tableId.startsWith('tbl') || !fixed.recordId.startsWith('rec') || !projection.length || projection.length > 20 ||
      projection.some(field => typeof field !== 'string' || !field.trim() || field.length > 512)) { throw new Error('Invalid fixed Lark task record'); }
  const common = ['--as', 'user', '--base-token', fixed.baseToken, '--table-id', fixed.tableId, '--record-id', fixed.recordId];
  const call = async (command: string, args: string[], cwd: string): Promise<Record<string, unknown>> => {
    try {
      const value = await exec('lark-cli', ['base', command, ...common, ...args], { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(value.stdout) as Record<string, unknown>;
    } catch { throw new Error(`Lark task board ${command} was not confirmed; inspect its existing record`); }
  };
  return {
    read: async () => {
      const cwd = await fs.mkdtemp(join(tmpdir(), 'disclaude-task-board-'));
      try {
        const manifest = await call('+record-get', [...projection.flatMap(field => ['--field-id', field]),
          '--format', 'ndjson', '--output', './record.ndjson'], cwd);
        if (manifest.records_count !== 1 || manifest.has_more !== false || manifest.base_token !== fixed.baseToken ||
            manifest.table_id !== fixed.tableId) { throw new Error('Lark task board read did not confirm its fixed record'); }
        const handle = await fs.open(join(cwd, 'record.ndjson'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat(); if (!stat.isFile() || stat.size > 512 * 1024) { throw new Error('Invalid Lark task record artifact'); }
          const rows = (await handle.readFile('utf8')).trim().split('\n').filter(Boolean);
          if (rows.length !== 1) { throw new Error('Lark task record count changed'); }
          const record: unknown = JSON.parse(rows[0]);
          if (!record || typeof record !== 'object' || Array.isArray(record) ||
              (record as Record<string, unknown>).record_id !== fixed.recordId) { throw new Error('Lark task record identity changed'); }
          const { record_id: recordId, ...cells } = record as Record<string, unknown>;
          return { recordId: recordId as string, fields: cells };
        } finally { await handle.close(); }
      } finally { await fs.rm(cwd, { recursive: true, force: true }); }
    },
    patch: async cells => {
      if (!cells || typeof cells !== 'object' || Array.isArray(cells) || !Object.keys(cells).length ||
          Object.keys(cells).some(field => !projection.includes(field))) { throw new Error('Lark task patch exceeds its fixed field projection'); }
      const cwd = await fs.mkdtemp(join(tmpdir(), 'disclaude-task-board-'));
      try {
        const result = await call('+record-upsert', ['--json', JSON.stringify(cells)], cwd);
        if (result.ok !== true || result.identity !== 'user') { throw new Error('Lark task record patch has no successful user receipt'); }
      } finally { await fs.rm(cwd, { recursive: true, force: true }); }
    },
  };
}
