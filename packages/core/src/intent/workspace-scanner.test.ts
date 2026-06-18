/**
 * Tests for the Intent module — workspace-scanner
 * Related: #4152
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  categorizeExtension,
  inferData,
  scanWorkspace,
} from './workspace-scanner.js';
import type { WorkspaceFile } from './types.js';

describe('categorizeExtension', () => {
  it('categorizes csv as structured-data', () => {
    expect(categorizeExtension('csv')).toBe('structured-data');
  });

  it('categorizes ts as code', () => {
    expect(categorizeExtension('ts')).toBe('code');
  });

  it('categorizes md as document', () => {
    expect(categorizeExtension('md')).toBe('document');
  });

  it('categorizes unknown extensions as unknown', () => {
    expect(categorizeExtension('xyz')).toBe('unknown');
  });

  it('handles empty extension', () => {
    expect(categorizeExtension('')).toBe('unknown');
  });
});

describe('inferData', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intent-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('infers CSV headers and row count', async () => {
    const csvPath = path.join(tmpDir, 'test.csv');
    await fs.writeFile(csvPath, 'name,age,city\nAlice,30,NYC\nBob,25,LA\n');

    const file: WorkspaceFile = {
      relativePath: 'test.csv',
      extension: 'csv',
      category: 'structured-data',
      size: 50,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeDefined();
    expect(result!.dataType).toBe('table');
    expect(result!.rowCount).toBe(2);
    expect(result!.columns).toEqual(['name', 'age', 'city']);
    expect(result!.confidence).toBeGreaterThan(0.5);
  });

  it('infers TSV with tab separator', async () => {
    const tsvPath = path.join(tmpDir, 'data.tsv');
    await fs.writeFile(tsvPath, 'id\tvalue\n1\thello\n');

    const file: WorkspaceFile = {
      relativePath: 'data.tsv',
      extension: 'tsv',
      category: 'structured-data',
      size: 20,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeDefined();
    expect(result!.dataType).toBe('table');
    expect(result!.rowCount).toBe(1);
    expect(result!.columns).toEqual(['id', 'value']);
  });

  it('infers JSON array with keys', async () => {
    const jsonPath = path.join(tmpDir, 'items.json');
    await fs.writeFile(jsonPath, JSON.stringify([
      { id: 1, name: 'test' },
      { id: 2, name: 'test2' },
    ]));

    const file: WorkspaceFile = {
      relativePath: 'items.json',
      extension: 'json',
      category: 'structured-data',
      size: 60,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeDefined();
    expect(result!.dataType).toBe('array');
    expect(result!.rowCount).toBe(2);
    expect(result!.keys).toEqual(['id', 'name']);
  });

  it('infers JSON object with keys', async () => {
    const jsonPath = path.join(tmpDir, 'config.json');
    await fs.writeFile(jsonPath, JSON.stringify({
      host: 'localhost',
      port: 3000,
      debug: true,
    }));

    const file: WorkspaceFile = {
      relativePath: 'config.json',
      extension: 'json',
      category: 'structured-data',
      size: 50,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeDefined();
    expect(result!.dataType).toBe('key-value');
    expect(result!.keys).toEqual(['host', 'port', 'debug']);
  });

  it('returns undefined for non-data extensions', async () => {
    const file: WorkspaceFile = {
      relativePath: 'readme.md',
      extension: 'md',
      category: 'document',
      size: 100,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeUndefined();
  });

  it('handles CSV with quoted fields', async () => {
    const csvPath = path.join(tmpDir, 'quoted.csv');
    await fs.writeFile(csvPath, 'name,description\n"Smith, John","He said ""hello"""\n');

    const file: WorkspaceFile = {
      relativePath: 'quoted.csv',
      extension: 'csv',
      category: 'structured-data',
      size: 50,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeDefined();
    expect(result!.columns).toEqual(['name', 'description']);
    expect(result!.rowCount).toBe(1);
  });

  it('returns undefined for non-existent file', async () => {
    const file: WorkspaceFile = {
      relativePath: 'nonexistent.csv',
      extension: 'csv',
      category: 'structured-data',
      size: 10,
      modifiedAt: new Date(),
    };

    const result = await inferData(tmpDir, file);
    expect(result).toBeUndefined();
  });
});

describe('scanWorkspace', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('scans workspace and finds files', async () => {
    await fs.writeFile(path.join(tmpDir, 'data.csv'), 'a,b\n1,2\n');
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{}');
    await fs.mkdir(path.join(tmpDir, 'subdir'));
    await fs.writeFile(path.join(tmpDir, 'subdir', 'notes.md'), '# notes');

    const result = await scanWorkspace(tmpDir);
    expect(result.files.length).toBe(3);
    expect(result.dataFiles.length).toBe(2); // csv + json
    expect(result.summary).toContain('3 files');
  });

  it('skips node_modules and hidden directories', async () => {
    await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'node_modules', 'dep.js'), 'export {}');
    await fs.mkdir(path.join(tmpDir, '.hidden'));
    await fs.writeFile(path.join(tmpDir, '.hidden', 'secret'), 'data');
    await fs.writeFile(path.join(tmpDir, 'visible.ts'), 'const x = 1;');

    const result = await scanWorkspace(tmpDir);
    expect(result.files.length).toBe(1);
    expect(result.files[0].relativePath).toBe('visible.ts');
  });

  it('handles empty directory', async () => {
    const result = await scanWorkspace(tmpDir);
    expect(result.files.length).toBe(0);
    expect(result.dataFiles.length).toBe(0);
  });
});
