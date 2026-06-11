/**
 * Unit tests for LOOP.md parser.
 *
 * Issue #4039 / #4040: Tests for parsing, querying, and serializing LOOP.md files.
 *
 * Tests cover:
 * - parseLoopMd: full file parsing, section extraction
 * - parseConfig: duration and failure limit parsing
 * - parseTodos: pending/completed/failed checkbox parsing
 * - findNextPending, isAllDone, countByStatus
 * - parseDuration: duration string to milliseconds
 * - serializeLoopMd / writeLoopMd: round-trip serialization
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseLoopMd,
  readLoopMd,
  writeLoopMd,
  serializeLoopMd,
  findNextPending,
  isAllDone,
  countByStatus,
  parseDuration,
  type LoopFile,
} from './loop-parser.js';

// ============================================================================
// Test helpers
// ============================================================================

const SAMPLE_LOOP_MD = `# Refactor Authentication Module

## Configuration
- **max_duration**: 2h
- **max_consecutive_failures**: 3

## Goal
Refactor the auth module to support multiple providers

## Constraints
No breaking changes to existing API

## TODO
- [ ] Extract auth provider interface
- [ ] Implement OAuth2 provider
- [ ] Add provider registry
- [ ] Update tests

## Progress Log
> Agent appends records here
`;

function createSampleLoop(overrides?: Partial<LoopFile>): LoopFile {
  return {
    title: 'Test Task',
    config: { maxDuration: '2h', maxConsecutiveFailures: 3 },
    goal: 'Complete the task',
    constraints: 'No breaking changes',
    todos: [
      { text: 'Step 1', status: 'pending', index: 0 },
      { text: 'Step 2', status: 'pending', index: 1 },
      { text: 'Step 3', status: 'pending', index: 2 },
    ],
    progressLog: '> Started',
    ...overrides,
  };
}

// ============================================================================
// parseLoopMd tests
// ============================================================================

describe('parseLoopMd', () => {
  it('should parse a complete LOOP.md file', () => {
    const result = parseLoopMd(SAMPLE_LOOP_MD);

    expect(result).not.toBeNull();
    expect(result!.title).toBe('Refactor Authentication Module');
    expect(result!.config.maxDuration).toBe('2h');
    expect(result!.config.maxConsecutiveFailures).toBe(3);
    expect(result!.goal).toBe('Refactor the auth module to support multiple providers');
    expect(result!.constraints).toBe('No breaking changes to existing API');
    expect(result!.todos).toHaveLength(4);
    expect(result!.progressLog).toContain('Agent appends records here');
  });

  it('should return null for content without a title', () => {
    const result = parseLoopMd('Some random content\nwithout a heading');
    expect(result).toBeNull();
  });

  it('should parse pending TODO items', () => {
    const result = parseLoopMd(SAMPLE_LOOP_MD);
    const pending = result!.todos.filter(t => t.status === 'pending');
    expect(pending).toHaveLength(4);
    expect(pending[0].text).toBe('Extract auth provider interface');
  });

  it('should parse completed TODO items', () => {
    const content = SAMPLE_LOOP_MD.replace('- [ ] Extract auth provider interface', '- [x] Extract auth provider interface');
    const result = parseLoopMd(content);
    expect(result!.todos[0].status).toBe('completed');
    expect(result!.todos[0].text).toBe('Extract auth provider interface');
  });

  it('should parse failed TODO items', () => {
    const content = SAMPLE_LOOP_MD.replace('- [ ] Extract auth provider interface', '- ~[x]~ Extract auth provider interface');
    const result = parseLoopMd(content);
    expect(result!.todos[0].status).toBe('failed');
    expect(result!.todos[0].text).toBe('Extract auth provider interface');
  });

  it('should use defaults when config section is missing', () => {
    const content = '# Test\n\n## Goal\nDo stuff\n\n## TODO\n- [ ] Step 1';
    const result = parseLoopMd(content);
    expect(result!.config.maxDuration).toBe('2h');
    expect(result!.config.maxConsecutiveFailures).toBe(3);
  });

  it('should handle empty sections', () => {
    const content = '# Test\n\n## Goal\n\n## TODO\n- [ ] Step 1';
    const result = parseLoopMd(content);
    expect(result!.goal).toBe('');
  });

  it('should handle empty TODO section', () => {
    const content = '# Test\n\n## TODO\n\n## Goal\nDone';
    const result = parseLoopMd(content);
    expect(result!.todos).toEqual([]);
  });
});

// ============================================================================
// findNextPending / isAllDone / countByStatus tests
// ============================================================================

describe('findNextPending', () => {
  it('should find the first pending item', () => {
    const {todos} = createSampleLoop();
    todos[0].status = 'completed';
    const next = findNextPending(todos);
    expect(next).not.toBeNull();
    expect(next!.index).toBe(1);
    expect(next!.text).toBe('Step 2');
  });

  it('should return null when all items are completed or failed', () => {
    const {todos} = createSampleLoop();
    todos[0].status = 'completed';
    todos[1].status = 'failed';
    todos[2].status = 'completed';
    expect(findNextPending(todos)).toBeNull();
  });

  it('should return null for empty list', () => {
    expect(findNextPending([])).toBeNull();
  });
});

describe('isAllDone', () => {
  it('should return true when all items are completed or failed', () => {
    const {todos} = createSampleLoop();
    todos[0].status = 'completed';
    todos[1].status = 'failed';
    todos[2].status = 'completed';
    expect(isAllDone(todos)).toBe(true);
  });

  it('should return false when pending items remain', () => {
    const {todos} = createSampleLoop();
    todos[0].status = 'completed';
    expect(isAllDone(todos)).toBe(false);
  });

  it('should return false for empty list', () => {
    expect(isAllDone([])).toBe(false);
  });
});

describe('countByStatus', () => {
  it('should count items by status', () => {
    const {todos} = createSampleLoop();
    todos[0].status = 'completed';
    todos[1].status = 'failed';
    const counts = countByStatus(todos);
    expect(counts).toEqual({ pending: 1, completed: 1, failed: 1 });
  });

  it('should count empty list', () => {
    expect(countByStatus([])).toEqual({ pending: 0, completed: 0, failed: 0 });
  });
});

// ============================================================================
// parseDuration tests
// ============================================================================

describe('parseDuration', () => {
  it('should parse hours', () => {
    expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });

  it('should parse hours and minutes', () => {
    expect(parseDuration('1h30m')).toBe(1.5 * 60 * 60 * 1000);
  });

  it('should parse seconds', () => {
    expect(parseDuration('45s')).toBe(45000);
  });

  it('should parse complex duration', () => {
    expect(parseDuration('1h30m45s')).toBe(1 * 3600000 + 30 * 60000 + 45000);
  });

  it('should return null for invalid format', () => {
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('2 days')).toBeNull();
  });
});

// ============================================================================
// Serialization tests
// ============================================================================

describe('serializeLoopMd', () => {
  it('should produce valid LOOP.md content', () => {
    const loop = createSampleLoop();
    const content = serializeLoopMd(loop);
    expect(content).toContain('# Test Task');
    expect(content).toContain('- **max_duration**: 2h');
    expect(content).toContain('- **max_consecutive_failures**: 3');
    expect(content).toContain('## Goal');
    expect(content).toContain('Complete the task');
    expect(content).toContain('## TODO');
    expect(content).toContain('- [ ] Step 1');
    expect(content).toContain('## Progress Log');
  });

  it('should serialize completed items as [x]', () => {
    const loop = createSampleLoop();
    loop.todos[0].status = 'completed';
    const content = serializeLoopMd(loop);
    expect(content).toContain('- [x] Step 1');
  });

  it('should serialize failed items as ~[x]~', () => {
    const loop = createSampleLoop();
    loop.todos[1].status = 'failed';
    const content = serializeLoopMd(loop);
    expect(content).toContain('- ~[x]~ Step 2');
  });
});

describe('round-trip', () => {
  it('should survive a parse → serialize → parse round-trip', () => {
    const original = parseLoopMd(SAMPLE_LOOP_MD);
    expect(original).not.toBeNull();

    const serialized = serializeLoopMd(original!);
    const reparsed = parseLoopMd(serialized);

    expect(reparsed).not.toBeNull();
    expect(reparsed!.title).toBe(original!.title);
    expect(reparsed!.config.maxDuration).toBe(original!.config.maxDuration);
    expect(reparsed!.config.maxConsecutiveFailures).toBe(original!.config.maxConsecutiveFailures);
    expect(reparsed!.todos).toHaveLength(original!.todos.length);
  });
});

// ============================================================================
// File I/O tests
// ============================================================================

describe('readLoopMd / writeLoopMd', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'loop-parser-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should write and read a LOOP.md file', async () => {
    const filePath = join(tempDir, 'LOOP.md');
    const loop = createSampleLoop();
    await writeLoopMd(filePath, loop);

    const loaded = await readLoopMd(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Test Task');
    expect(loaded!.todos).toHaveLength(3);
  });

  it('should return null when file does not exist', async () => {
    const result = await readLoopMd(join(tempDir, 'nonexistent.md'));
    expect(result).toBeNull();
  });
});
