/**
 * Unit tests for the research doc watch registry (T-089 / #5197).
 *
 * Covers: explicit registration/unregistration, persistence layout, strict
 * register() validation, tolerant list() over agent-written files, and the
 * registration cap.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResearchDocWatchRegistry, type ResearchDocWatchRegistration } from './doc-watch-registry.js';

const tempDirs: string[] = [];

function createWatchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'research-watch-'));
  tempDirs.push(dir);
  return dir;
}

function createRegistration(overrides?: Partial<ResearchDocWatchRegistration>): ResearchDocWatchRegistration {
  return {
    docToken: 'doxcnAbc123',
    docType: 'docx',
    chatId: 'oc_research_chat',
    projectName: 'quarterly-report',
    registeredAt: '2026-11-06T00:00:00.000Z',
    identity: 'user',
    ...overrides,
  };
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('ResearchDocWatchRegistry', () => {
  it('registers, persists per-doc files, and lists them back', async () => {
    const watchDir = createWatchDir();
    const registry = new ResearchDocWatchRegistry({ watchDir });
    const entry = createRegistration();

    const result = await registry.register(entry);
    expect(result.ok).toBe(true);

    const file = join(watchDir, 'docs', 'doxcnAbc123.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(entry);

    expect(await registry.list()).toEqual([entry]);
    expect(await registry.get('doxcnAbc123')).toEqual(entry);
  });

  it('re-registering overwrites the same document mapping', async () => {
    const registry = new ResearchDocWatchRegistry({ watchDir: createWatchDir() });
    await registry.register(createRegistration({ chatId: 'oc_first' }));
    const updated = await registry.register(createRegistration({ chatId: 'oc_second', projectName: undefined }));
    expect(updated.ok).toBe(true);
    const registrations = await registry.list();
    expect(registrations).toHaveLength(1);
    expect(registrations[0].chatId).toBe('oc_second');
  });

  it('rejects invalid registrations without writing', async () => {
    const watchDir = createWatchDir();
    const registry = new ResearchDocWatchRegistry({ watchDir });
    const invalid: Array<Partial<ResearchDocWatchRegistration>> = [
      { docToken: '../escape' },
      { docToken: '' },
      { chatId: 'x' },
      { chatId: 'bad chat!' },
      { identity: 'app' as ResearchDocWatchRegistration['identity'] },
      { registeredAt: 'not-a-date' },
      { docType: '' },
    ];
    for (const overrides of invalid) {
      const result = await registry.register(createRegistration(overrides));
      expect(result.ok).toBe(false);
    }
    expect(await registry.list()).toEqual([]);
    expect(existsSync(join(watchDir, 'docs'))).toBe(false);
  });

  it('enforces the registration cap but overwrites existing entries within it', async () => {
    const registry = new ResearchDocWatchRegistry({ watchDir: createWatchDir(), maxRegistrations: 1 });
    expect((await registry.register(createRegistration())).ok).toBe(true);
    const second = await registry.register(createRegistration({ docToken: 'doxcnSecond' }));
    expect(second.ok).toBe(false);
    // Same token still allowed — it replaces, not adds.
    expect((await registry.register(createRegistration({ chatId: 'oc_other' }))).ok).toBe(true);
    expect(await registry.list()).toHaveLength(1);
  });

  it('unregisters and stops listing the document', async () => {
    const registry = new ResearchDocWatchRegistry({ watchDir: createWatchDir() });
    await registry.register(createRegistration());
    expect(await registry.unregister('doxcnAbc123')).toBe(true);
    expect(await registry.list()).toEqual([]);
    // Idempotent for unknown/invalid tokens.
    expect(await registry.unregister('doxcnAbc123')).toBe(true);
    expect(await registry.unregister('../nope')).toBe(false);
  });

  it('skips corrupt or invalid agent-written files instead of throwing', async () => {
    const watchDir = createWatchDir();
    const docsDir = join(watchDir, 'docs');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'doxcnGood.json'), JSON.stringify(createRegistration({ docToken: 'doxcnGood' })), 'utf8');
    writeFileSync(join(docsDir, 'doxcnBroken.json'), '{not json', 'utf8');
    writeFileSync(join(docsDir, 'doxcnBadSchema.json'), JSON.stringify({ docToken: 'x' }), 'utf8');
    writeFileSync(join(docsDir, 'not-json.txt'), 'ignored', 'utf8');

    const registry = new ResearchDocWatchRegistry({ watchDir });
    const registrations = await registry.list();
    expect(registrations.map(reg => reg.docToken)).toEqual(['doxcnGood']);
  });

  it('list() returns empty for a missing directory (nothing is watched by default)', async () => {
    const registry = new ResearchDocWatchRegistry({ watchDir: createWatchDir() });
    expect(await registry.list()).toEqual([]);
  });
});
