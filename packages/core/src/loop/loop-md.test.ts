/**
 * Tests for the LOOP.md definition-file parser (Issue #4193 part A).
 *
 * Covers frontmatter splitting (present / absent / malformed), field parsing &
 * defaults, duration parsing, the path helper, and round-tripping through a
 * realistic LOOP.md document.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseLoopMd, parseDuration, loopMdPath, readLoopMd, serializeLoopMd, writeLoopMd, LOOP_MD_DIR, LOOP_MD_FILENAME } from './loop-md.js';

describe('parseDuration', () => {
  it('returns the default for null / undefined', () => {
    expect(parseDuration(null, 999)).toBe(999);
    expect(parseDuration(undefined, 999)).toBe(999);
  });

  it('treats a number as milliseconds', () => {
    expect(parseDuration(30000, 1)).toBe(30000);
    expect(parseDuration(0, 1)).toBe(0);
  });

  it('treats a bare-numeric string as milliseconds', () => {
    expect(parseDuration('30000', 1)).toBe(30000);
    expect(parseDuration('  4500  ', 1)).toBe(4500);
  });

  it('parses unit suffixes (ms/s/m/h/d)', () => {
    expect(parseDuration('500ms', 1)).toBe(500);
    expect(parseDuration('45s', 1)).toBe(45_000);
    expect(parseDuration('30m', 1)).toBe(1_800_000);
    expect(parseDuration('2h', 1)).toBe(7_200_000);
    expect(parseDuration('1d', 1)).toBe(86_400_000);
  });

  it('parses fractional + space-padded values', () => {
    expect(parseDuration('1.5h', 1)).toBe(5_400_000);
    expect(parseDuration('2 h', 1)).toBe(7_200_000);
  });

  it('is case-insensitive on the unit', () => {
    expect(parseDuration('2H', 1)).toBe(7_200_000);
    expect(parseDuration('10M', 1)).toBe(600_000);
  });

  it('throws on an unparseable string', () => {
    expect(() => parseDuration('soon', 1)).toThrow(/Invalid duration/);
    expect(() => parseDuration('2y', 1)).toThrow(/Invalid duration/);
  });

  it('returns the default for an empty / whitespace string', () => {
    expect(parseDuration('', 1234)).toBe(1234);
    expect(parseDuration('   ', 1234)).toBe(1234);
  });
});

describe('parseLoopMd — frontmatter presence', () => {
  it('parses a full LOOP.md (frontmatter + prompt body)', () => {
    const doc = `---
name: nightly-research
chatId: oc_abc
workDir: /data/loop-nightly
maxSteps: 5
maxDuration: 2h
stepInterval: 30s
status: running
startedAt: "2026-07-09T00:00:00Z"
---

Read the latest issues and pick one to work on. Commit a PR.`;
    const def = parseLoopMd(doc);
    expect(def.params.name).toBe('nightly-research');
    expect(def.params.chatId).toBe('oc_abc');
    expect(def.params.workDir).toBe('/data/loop-nightly');
    expect(def.params.maxSteps).toBe(5);
    expect(def.params.maxDurationMs).toBe(7_200_000);
    expect(def.params.stepIntervalMs).toBe(30_000);
    expect(def.params.status).toBe('running');
    expect(def.params.startedAt).toBe('2026-07-09T00:00:00Z');
    expect(def.prompt).toBe('Read the latest issues and pick one to work on. Commit a PR.');
  });

  it('accepts a prompt-only document (no frontmatter) with default params', () => {
    const def = parseLoopMd('Just keep working on the task.');
    expect(def.params.name).toBe('');
    expect(def.params.chatId).toBe('');
    expect(def.params.maxSteps).toBe(10);
    expect(def.params.maxDurationMs).toBe(3_600_000);
    expect(def.params.stepIntervalMs).toBe(30_000);
    expect(def.prompt).toBe('Just keep working on the task.');
  });

  it('treats a leading "---" with no closing fence as body (not frontmatter)', () => {
    const def = parseLoopMd('---\nthis is not frontmatter');
    // No valid closing fence → whole doc is body; params default.
    expect(def.params.name).toBe('');
    expect(def.prompt).toContain('this is not frontmatter');
  });

  it('does not let a "---" line in the body truncate the prompt', () => {
    const doc = `---
name: loop
chatId: oc_x
---

First line.

---

Third line after a horizontal rule.`;
    const def = parseLoopMd(doc);
    expect(def.params.name).toBe('loop');
    expect(def.prompt).toContain('First line.');
    expect(def.prompt).toContain('Third line after a horizontal rule.');
  });

  it('trims leading/trailing blank lines from the body', () => {
    const doc = `---
name: loop
chatId: oc_x
---


  the prompt


`;
    const def = parseLoopMd(doc);
    expect(def.prompt).toBe('the prompt');
  });
});

describe('parseLoopMd — fields & defaults', () => {
  it('applies defaults for omitted optional params', () => {
    const def = parseLoopMd(`---
name: minimal
chatId: oc_x
---
do stuff`);
    expect(def.params.maxSteps).toBe(10);
    expect(def.params.maxDurationMs).toBe(3_600_000);
    expect(def.params.stepIntervalMs).toBe(30_000);
    expect(def.params.workDir).toBeUndefined();
    expect(def.params.status).toBeUndefined();
  });

  it('requires "name" when frontmatter is present', () => {
    expect(() => parseLoopMd(`---
chatId: oc_x
---
body`)).toThrow(/name/);
  });

  it('coerces an unquoted numeric chatId to a string with a warning', () => {
    const def = parseLoopMd(`---
name: n
chatId: 12345
---
p`);
    expect(def.params.chatId).toBe('12345');
    expect(typeof def.params.chatId).toBe('string');
  });

  it('coerces an unquoted YAML timestamp to an ISO string', () => {
    // js-yaml parses a bare timestamp as a native Date; asString stringifies it.
    const def = parseLoopMd(`---
name: n
chatId: oc_x
startedAt: 2026-07-09T00:00:00Z
---
p`);
    expect(def.params.startedAt).toBe('2026-07-09T00:00:00.000Z');
    expect(typeof def.params.startedAt).toBe('string');
  });

  it('accepts maxSteps as a string of digits', () => {
    const def = parseLoopMd(`---
name: n
chatId: oc_x
maxSteps: "7"
---
p`);
    expect(def.params.maxSteps).toBe(7);
  });

  it('throws when maxSteps is non-numeric', () => {
    expect(() => parseLoopMd(`---
name: n
chatId: oc_x
maxSteps: many
---
p`)).toThrow(/maxSteps/);
  });

  it('throws when frontmatter is not a mapping', () => {
    expect(() => parseLoopMd(`---
- a
- b
---
p`)).toThrow(/mapping/);
  });

  it('parses an empty frontmatter block (only params default, name required → throws)', () => {
    // Empty frontmatter → no name → throws because name is required when
    // frontmatter is present.
    expect(() => parseLoopMd(`---
---
body`)).toThrow(/name/);
  });
});

describe('loopMdPath', () => {
  it('builds the conventional .disclaude/loop/<name>/LOOP.md path', () => {
    expect(loopMdPath('my-loop', '/data/ws')).toBe(
      `/data/ws/${LOOP_MD_DIR}/my-loop/${LOOP_MD_FILENAME}`,
    );
  });

  it('defaults baseDir to process.cwd()', () => {
    const p = loopMdPath('x');
    expect(p).toBe(`${process.cwd().replace(/\/+$/, '')}/${LOOP_MD_DIR}/x/${LOOP_MD_FILENAME}`);
  });

  it('slugifies an unsafe name', () => {
    expect(loopMdPath('My Loop!!', '/w')).toBe(`/w/${LOOP_MD_DIR}/My-Loop/${LOOP_MD_FILENAME}`);
  });

  it('throws when the name has no safe characters', () => {
    expect(() => loopMdPath('!!!', '/w')).toThrow(/filesystem-safe/);
  });

  it('strips a trailing slash from baseDir', () => {
    expect(loopMdPath('loop', '/w/')).toBe(`/w/${LOOP_MD_DIR}/loop/${LOOP_MD_FILENAME}`);
  });
});

describe('serializeLoopMd / writeLoopMd (Issue #4040 part 1)', () => {
  it('serializeLoopMd round-trips through parseLoopMd (params + prompt preserved)', () => {
    const def = {
      params: { name: 'my-loop', chatId: 'oc_123', maxSteps: 5, maxDurationMs: 7_200_000, stepIntervalMs: 15_000 },
      prompt: 'do the thing each iteration',
    };
    const reparsed = parseLoopMd(serializeLoopMd(def));
    expect(reparsed.params.name).toBe('my-loop');
    expect(reparsed.params.chatId).toBe('oc_123');
    expect(reparsed.params.maxSteps).toBe(5);
    expect(reparsed.params.maxDurationMs).toBe(7_200_000);
    expect(reparsed.params.stepIntervalMs).toBe(15_000);
    expect(reparsed.prompt).toBe('do the thing each iteration');
  });

  it('serializeLoopMd includes optional fields when present, omits them when absent', () => {
    const withOpts = serializeLoopMd({
      params: { name: 'x', chatId: 'oc', maxSteps: 1, maxDurationMs: 1000, stepIntervalMs: 100, workDir: '/wd', status: 'running', startedAt: '2026-07-09T00:00:00Z' },
      prompt: 'p',
    });
    expect(withOpts).toContain('workDir');
    expect(withOpts).toContain('status');
    expect(withOpts).toContain('startedAt');

    const withoutOpts = serializeLoopMd({
      params: { name: 'x', chatId: 'oc', maxSteps: 1, maxDurationMs: 1000, stepIntervalMs: 100 },
      prompt: 'p',
    });
    expect(withoutOpts).not.toContain('workDir');
    expect(withoutOpts).not.toContain('status');
    expect(withoutOpts).not.toContain('startedAt');
  });

  it('writeLoopMd writes a file that readLoopMd reads back (full fs round-trip, creating parent dirs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopmd-write-'));
    const path = join(dir, LOOP_MD_DIR, 'my-loop', LOOP_MD_FILENAME);
    try {
      writeLoopMd(path, {
        params: { name: 'my-loop', chatId: 'oc_abc', maxSteps: 3, maxDurationMs: 3_600_000, stepIntervalMs: 30_000 },
        prompt: 'run me',
      });
      const read = readLoopMd(path);
      expect(read.params.name).toBe('my-loop');
      expect(read.params.chatId).toBe('oc_abc');
      expect(read.params.maxSteps).toBe(3);
      expect(read.params.maxDurationMs).toBe(3_600_000);
      expect(read.params.stepIntervalMs).toBe(30_000);
      expect(read.prompt).toBe('run me');
      expect(read.sourcePath).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
