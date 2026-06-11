/**
 * Unit tests for Loop Feedback module.
 *
 * Issue #4017: Tests for file-based feedback propagation between
 * initial conversation and Loop execution agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendFeedback,
  readFeedback,
  readFeedbackSince,
  hasNewFeedback,
  parseFeedbackFromContent,
} from './loop-feedback.js';

// ============================================================================
// Test helpers
// ============================================================================

const SAMPLE_LOOP_MD = `# Test Task

## Configuration
- **max_duration**: 2h
- **max_consecutive_failures**: 3

## Goal
Complete the task

## TODO
- [ ] Step 1
- [ ] Step 2

## Progress Log
> Started at 2026-06-11T10:00:00.000Z
`;

function createSampleLoopWithFeedback(): string {
  return `${SAMPLE_LOOP_MD}
> [Feedback from user — 2026-06-11T10:30:00.000Z]: Focus on competitor B analysis.
> [Feedback from user — 2026-06-11T11:00:00.000Z]: Also include market size data.
`;
}

// ============================================================================
// parseFeedbackFromContent tests
// ============================================================================

describe('parseFeedbackFromContent', () => {
  it('should parse feedback entries from content', () => {
    const content = createSampleLoopWithFeedback();
    const entries = parseFeedbackFromContent(content);

    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe('2026-06-11T10:30:00.000Z');
    expect(entries[0].message).toBe('Focus on competitor B analysis.');
    expect(entries[1].timestamp).toBe('2026-06-11T11:00:00.000Z');
    expect(entries[1].message).toBe('Also include market size data.');
  });

  it('should return empty array when no feedback exists', () => {
    const entries = parseFeedbackFromContent(SAMPLE_LOOP_MD);
    expect(entries).toEqual([]);
  });

  it('should return empty array for empty content', () => {
    const entries = parseFeedbackFromContent('');
    expect(entries).toEqual([]);
  });

  it('should handle single feedback entry', () => {
    const content = `${SAMPLE_LOOP_MD}
> [Feedback from user — 2026-06-11T09:00:00.000Z]: Change direction.
`;
    const entries = parseFeedbackFromContent(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('Change direction.');
  });
});

// ============================================================================
// File I/O tests
// ============================================================================

describe('appendFeedback', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-feedback-'));
    filePath = join(tempDir, 'LOOP.md');
    writeFileSync(filePath, SAMPLE_LOOP_MD, 'utf-8');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should append feedback entry to file', async () => {
    await appendFeedback(filePath, 'Focus on competitor B.');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('[Feedback from user —');
    expect(content).toContain('Focus on competitor B.');
  });

  it('should use provided timestamp', async () => {
    await appendFeedback(filePath, 'Test message', '2026-06-11T12:00:00.000Z');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('2026-06-11T12:00:00.000Z');
  });

  it('should throw for non-existent file', async () => {
    await expect(
      appendFeedback(join(tempDir, 'nope.md'), 'test'),
    ).rejects.toThrow('Cannot read LOOP.md');
  });
});

describe('readFeedback', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-feedback-'));
    filePath = join(tempDir, 'LOOP.md');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should read feedback entries from file', async () => {
    writeFileSync(filePath, createSampleLoopWithFeedback(), 'utf-8');
    const entries = await readFeedback(filePath);

    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('Focus on competitor B analysis.');
  });

  it('should return empty array for file without feedback', async () => {
    writeFileSync(filePath, SAMPLE_LOOP_MD, 'utf-8');
    const entries = await readFeedback(filePath);
    expect(entries).toEqual([]);
  });

  it('should return empty array for non-existent file', async () => {
    const entries = await readFeedback(join(tempDir, 'nope.md'));
    expect(entries).toEqual([]);
  });
});

describe('readFeedbackSince', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-feedback-'));
    filePath = join(tempDir, 'LOOP.md');
    writeFileSync(filePath, createSampleLoopWithFeedback(), 'utf-8');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should return only entries after given timestamp', async () => {
    const entries = await readFeedbackSince(filePath, '2026-06-11T10:45:00.000Z');
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('Also include market size data.');
  });

  it('should return all entries if timestamp is before all feedback', async () => {
    const entries = await readFeedbackSince(filePath, '2026-06-11T09:00:00.000Z');
    expect(entries).toHaveLength(2);
  });

  it('should return empty array if timestamp is after all feedback', async () => {
    const entries = await readFeedbackSince(filePath, '2026-06-12T00:00:00.000Z');
    expect(entries).toEqual([]);
  });
});

describe('hasNewFeedback', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-feedback-'));
    filePath = join(tempDir, 'LOOP.md');
    writeFileSync(filePath, createSampleLoopWithFeedback(), 'utf-8');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should return true when new feedback exists', async () => {
    const result = await hasNewFeedback(filePath, '2026-06-11T10:45:00.000Z');
    expect(result).toBe(true);
  });

  it('should return false when no new feedback', async () => {
    const result = await hasNewFeedback(filePath, '2026-06-12T00:00:00.000Z');
    expect(result).toBe(false);
  });

  it('should return false for non-existent file', async () => {
    const result = await hasNewFeedback(join(tempDir, 'nope.md'), '2026-06-11T00:00:00.000Z');
    expect(result).toBe(false);
  });
});
