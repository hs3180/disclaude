import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskRecordStore } from './task-record-store.js';

describe('TaskRecordStore', () => {
  it('creates and appends monthly records in a plain workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-store-'));
    try {
      const store = new TaskRecordStore(workspace);
      const filePath = await store.append('2026-09', '## 2026-09-03 Example\n\n- **Type**: test');
      expect(filePath).toBe(path.join(workspace, 'task-records', '2026-09.md'));
      await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('# Task Records');
      await expect(fs.readFile(filePath, 'utf8')).resolves.toContain('**Type**: test');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('reads monthly records and tails the legacy archive without writing to it', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'task-record-store-'));
    try {
      const legacyDir = path.join(workspace, '.claude', 'task-records');
      const legacyFile = path.join(workspace, '.claude', 'task-records.md');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(path.join(legacyDir, '2026-08.md'), 'legacy monthly', 'utf8');
      await fs.writeFile(legacyFile, Array.from({ length: 4 }, (_, i) => `line-${i}`).join('\n'), 'utf8');

      const store = new TaskRecordStore(workspace);
      await expect(store.readRecent(['2026-08'], 2)).resolves.toContain('legacy monthly');
      await expect(store.readRecent(['2026-08'], 2)).resolves.toContain('line-3');
      await expect(fs.stat(path.join(workspace, 'task-records'))).rejects.toThrow();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
