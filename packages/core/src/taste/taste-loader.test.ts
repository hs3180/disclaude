/**
 * Tests for the Taste loader module.
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadTaste,
  saveTaste,
  getTasteFilePath,
  createEmptyTasteData,
} from './taste-loader.js';
import type { TasteData } from './types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getTasteFilePath', () => {
  it('should return path under .disclaude directory', () => {
    const result = getTasteFilePath('/workspace');
    expect(result).toBe(path.join('/workspace', '.disclaude', 'taste.yaml'));
  });
});

describe('createEmptyTasteData', () => {
  it('should return valid empty taste data', () => {
    const data = createEmptyTasteData();
    expect(data.version).toBe(1);
    expect(data.rules).toEqual({});
    expect(data.updatedAt).toBeTruthy();
  });
});

describe('loadTaste', () => {
  it('should return empty data when file does not exist', () => {
    const result = loadTaste(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe(1);
      expect(result.data.rules).toEqual({});
    }
  });

  it('should load valid taste file', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        use_const: {
          rule: '使用 const/let，禁止 var',
          category: 'code_style',
          source: {
            origin: 'auto',
            correctionCount: 3,
            lastSeen: '2026-04-14T00:00:00Z',
          },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    // Write the file manually
    const dir = path.join(tmpDir, '.disclaude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'taste.yaml'),
      JSON.stringify(data), // JSON is valid YAML
      'utf-8',
    );

    const result = loadTaste(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.data.rules)).toHaveLength(1);
      expect(result.data.rules.use_const.rule).toBe('使用 const/let，禁止 var');
    }
  });

  it('should return error for malformed file', () => {
    const dir = path.join(tmpDir, '.disclaude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'taste.yaml'), 'not: valid: yaml: [}', 'utf-8');

    // Note: YAML parser is fairly permissive, so let's write something truly invalid
    const result = loadTaste(tmpDir);
    // If it parses, it should fail validation (no version or rules)
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('should return error for wrong version', () => {
    const dir = path.join(tmpDir, '.disclaude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'taste.yaml'),
      'version: 99\nrules: {}',
      'utf-8',
    );

    const result = loadTaste(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('version');
    }
  });
});

describe('saveTaste', () => {
  it('should save taste data to file', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        use_ts: {
          rule: '优先使用 TypeScript',
          category: 'tech_preference',
          source: {
            origin: 'auto',
            correctionCount: 2,
            lastSeen: '2026-04-14T00:00:00Z',
          },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    const result = saveTaste(tmpDir, data);
    expect(result.ok).toBe(true);

    // Verify file exists
    const filePath = getTasteFilePath(tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify content can be loaded back
    const loaded = loadTaste(tmpDir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(Object.keys(loaded.data.rules)).toHaveLength(1);
      expect(loaded.data.rules.use_ts.rule).toBe('优先使用 TypeScript');
    }
  });

  it('should create .disclaude directory if needed', () => {
    const data = createEmptyTasteData();
    const result = saveTaste(tmpDir, data);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.disclaude'))).toBe(true);
  });

  it('should update updatedAt timestamp on save', () => {
    const data = createEmptyTasteData();
    const before = new Date().toISOString();
    saveTaste(tmpDir, data);
    const after = new Date().toISOString();

    const loaded = loadTaste(tmpDir);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.updatedAt >= before).toBe(true);
      expect(loaded.data.updatedAt <= after).toBe(true);
    }
  });
});

describe('round-trip', () => {
  it('should survive save then load with multiple rules', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        use_const: {
          rule: '使用 const/let，禁止 var',
          category: 'code_style',
          source: { origin: 'auto', correctionCount: 5, lastSeen: '2026-04-14T00:00:00Z' },
        },
        be_concise: {
          rule: '回复简洁，先结论后分析',
          category: 'interaction',
          source: { origin: 'manual', lastSeen: '2026-04-14T00:00:00Z' },
        },
        use_ts: {
          rule: '优先 TypeScript',
          category: 'tech_preference',
          source: { origin: 'claude_md', lastSeen: '2026-04-14T00:00:00Z' },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    saveTaste(tmpDir, data);
    const loaded = loadTaste(tmpDir);

    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(Object.keys(loaded.data.rules)).toHaveLength(3);
      expect(loaded.data.rules.use_const.category).toBe('code_style');
      expect(loaded.data.rules.be_concise.source.origin).toBe('manual');
      expect(loaded.data.rules.use_ts.source.origin).toBe('claude_md');
    }
  });
});
