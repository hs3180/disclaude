/**
 * Tests for data source scanner utility.
 *
 * Issue #933: Phase 1 of Intent Convergence Protocol.
 * Tests cover file classification, directory scanning, and summary formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  scanDataSources,
  formatScanSummary,
  type DataScanResult,
  type DataFileCategory,
} from './data-source-scanner.js';

describe('scanDataSources', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should find and classify CSV files as spreadsheets', async () => {
    await fs.writeFile(path.join(tmpDir, 'transactions.csv'), 'date,amount\n2025-01,100');
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].category).toBe('spreadsheet');
    expect(result.files[0].extension).toBe('.csv');
  });

  it('should detect bank statement PDFs by filename pattern', async () => {
    await fs.writeFile(path.join(tmpDir, '招商银行储蓄卡流水.pdf'), 'fake pdf');
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].category).toBe('bank-statement');
    expect(result.files[0].label).toBe('招商银行');
  });

  it('should detect payment platform bills by filename', async () => {
    await fs.writeFile(path.join(tmpDir, '微信支付账单.csv'), 'date,amount');
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].category).toBe('payment-platform');
    expect(result.files[0].label).toBe('微信支付');
  });

  it('should classify generic PDFs as documents', async () => {
    await fs.writeFile(path.join(tmpDir, 'report.pdf'), 'fake pdf');
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].category).toBe('document');
  });

  it('should skip excluded directories', async () => {
    await fs.writeFile(path.join(tmpDir, 'data.csv'), 'a,b');
    const nodeModules = path.join(tmpDir, 'node_modules');
    await fs.mkdir(nodeModules);
    await fs.writeFile(path.join(nodeModules, 'lib.csv'), 'c,d');
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(1);
  });

  it('should respect maxDepth option', async () => {
    await fs.writeFile(path.join(tmpDir, 'root.csv'), 'a');
    const sub = path.join(tmpDir, 'l1', 'l2', 'l3', 'l4');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'deep.csv'), 'b');
    const result = await scanDataSources(tmpDir, { maxDepth: 2 });
    expect(result.totalFiles).toBe(1); // Only root.csv, deep.csv is beyond depth 2
  });

  it('should filter by includeExtensions', async () => {
    await fs.writeFile(path.join(tmpDir, 'data.csv'), 'a');
    await fs.writeFile(path.join(tmpDir, 'report.pdf'), 'fake');
    const result = await scanDataSources(tmpDir, { includeExtensions: ['.csv'] });
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].extension).toBe('.csv');
  });

  it('should return correct summary counts', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.csv'), 'a');
    await fs.writeFile(path.join(tmpDir, 'b.csv'), 'b');
    await fs.writeFile(path.join(tmpDir, 'c.xlsx'), 'c');
    const result = await scanDataSources(tmpDir);
    expect(result.summary['spreadsheet']).toBe(3);
  });

  it('should return empty result for empty directory', async () => {
    const result = await scanDataSources(tmpDir);
    expect(result.totalFiles).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('should handle non-existent directory gracefully', async () => {
    const result = await scanDataSources('/nonexistent/path/12345');
    expect(result.totalFiles).toBe(0);
  });
});

describe('formatScanSummary', () => {
  it('should format empty result', () => {
    const result: DataScanResult = {
      directory: '/test',
      totalFiles: 0,
      files: [],
      summary: {
        'bank-statement': 0,
        'payment-platform': 0,
        'spreadsheet': 0,
        'document': 0,
        'image': 0,
        'audio': 0,
        'archive': 0,
        'database': 0,
        'text': 0,
        'unknown': 0,
      },
    };
    const text = formatScanSummary(result);
    expect(text).toContain('No data files found');
  });

  it('should include category and file details', () => {
    const result: DataScanResult = {
      directory: '/data',
      totalFiles: 2,
      files: [
        {
          filePath: '/data/招商银行储蓄卡流水.pdf',
          extension: '.pdf',
          size: 1024,
          category: 'bank-statement' as DataFileCategory,
          label: '招商银行',
        },
        {
          filePath: '/data/微信支付账单.csv',
          extension: '.csv',
          size: 512,
          category: 'payment-platform' as DataFileCategory,
          label: '微信支付',
        },
      ],
      summary: {
        'bank-statement': 1,
        'payment-platform': 1,
        'spreadsheet': 0,
        'document': 0,
        'image': 0,
        'audio': 0,
        'archive': 0,
        'database': 0,
        'text': 0,
        'unknown': 0,
      },
    };
    const text = formatScanSummary(result);
    expect(text).toContain('**2** data file(s)');
    expect(text).toContain('Bank Statements');
    expect(text).toContain('Payment Platform Bills');
    expect(text).toContain('招商银行');
    expect(text).toContain('微信支付');
    expect(text).toContain('Please confirm');
  });
});
