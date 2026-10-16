import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiErrorEvidence, ClaudeTranscriptErrors } from './api-error-evidence.js';

let dir: string;
let file: string;
let tracker: ClaudeTranscriptErrors;
const error = (extra = {}) => `${JSON.stringify({ type: 'assistant', sessionId: 'owned-session', timestamp: new Date().toISOString(), isApiErrorMessage: true,
  apiErrorStatus: 429, apiErrorIsTransient: false, message: { content: 'private-body-canary' }, ...extra })  }\n`;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-api-error-'));
  const project = join(dir, 'projects', 'owned-project');
  await mkdir(project, { recursive: true });
  file = join(project, 'owned-session.jsonl');
  tracker = new ClaudeTranscriptErrors();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('structured API error evidence', () => {
  it('retains only status and explicit transient fields', () => {
    expect(apiErrorEvidence({ apiErrorStatus: 429, apiErrorIsTransient: false, message: 'private-body-canary' }))
      .toEqual({ apiErrorStatus: 429, apiErrorIsTransient: false });
    expect(apiErrorEvidence({ apiErrorStatus: '429', apiErrorIsTransient: 'false' })).toBeUndefined();
  });

  it('reads only new records for the exact session and excludes private content', async () => {
    await writeFile(file, error({ apiErrorStatus: 503, timestamp: '2000-01-01T00:00:00Z' }));
    tracker.bindSession('owned-session', dir, Date.now());
    expect(await tracker.read()).toEqual({ state: 'available' });
    await appendFile(file, `malformed\n${  error({ sessionId: 'another-session' })  }${error()}`);
    expect(await tracker.read()).toEqual({ state: 'available', error: { apiErrorStatus: 429, apiErrorIsTransient: false } });
    expect(await tracker.read()).toEqual({ state: 'available' });
  });

  it('discovers the exact session after file creation and nested API fields', async () => {
    tracker.bindSession('owned-session', dir, 0);
    await writeFile(file, `${JSON.stringify({ type: 'assistant', sessionId: 'owned-session', timestamp: new Date().toISOString(),
      message: { isApiErrorMessage: true, apiErrorStatus: 502, apiErrorIsTransient: true } })  }\n`);
    expect(await tracker.read()).toEqual({ state: 'available', error: { apiErrorStatus: 502, apiErrorIsTransient: true } });
  });

  it('does not classify a recovered API error or a tool result as a failed turn', async () => {
    tracker.bindSession('owned-session', dir, 0);
    await writeFile(file, `${error() + JSON.stringify({ type: 'assistant', sessionId: 'owned-session', timestamp: new Date().toISOString(), message: { content: 'recovered' } })  }\n${
       JSON.stringify({ type: 'user', sessionId: 'owned-session', message: { content: error() } })  }\n`);
    expect(await tracker.read()).toEqual({ state: 'available' });
  });

  it('keeps partial records across reads and bounds memory for large non-error lines', async () => {
    tracker.bindSession('owned-session', dir, 0);
    const line = error();
    await writeFile(file, `${JSON.stringify({ content: 'x'.repeat(400_000) })  }\n${  line.slice(0, 50)}`);
    expect(await tracker.read()).toEqual({ state: 'available' });
    await appendFile(file, line.slice(50));
    expect(await tracker.read()).toEqual({ state: 'available', error: { apiErrorStatus: 429, apiErrorIsTransient: false } });
  });

  it('keeps byte offsets correct when a UTF-8 character is split across writes', async () => {
    tracker.bindSession('owned-session', dir, 0);
    const bytes = Buffer.from(error({ message: { content: '错误' } }));
    const split = bytes.indexOf(Buffer.from('错')) + 1;
    await writeFile(file, bytes.subarray(0, split));
    expect(await tracker.read()).toEqual({ state: 'available' });
    await appendFile(file, bytes.subarray(split));
    expect(await tracker.read()).toEqual({ state: 'available', error: { apiErrorStatus: 429, apiErrorIsTransient: false } });
  });

  it('does not choose among duplicate session IDs in different project directories', async () => {
    await writeFile(file, error());
    const another = join(dir, 'projects', 'another');
    await mkdir(another);
    await writeFile(join(another, 'owned-session.jsonl'), error());
    tracker.bindSession('owned-session', dir, 0);
    expect(await tracker.read()).toEqual({ state: 'unavailable' });
  });

  it('waits for a delayed transcript flush after a failed terminal', async () => {
    tracker.bindSession('owned-session', dir, 0);
    const writing = new Promise<void>((resolve, reject) => setTimeout(() => {
      void writeFile(file, error()).then(resolve, reject);
    }, 25));
    const result = await tracker.readAfterFlush(true, () => false);
    await writing;
    expect(result).toEqual({ state: 'available', error: { apiErrorStatus: 429, apiErrorIsTransient: false } });
  });

  it('rejects unrelated paths and a replaced transcript without reading its contents', async () => {
    tracker.bindSession('../owned-session', dir, 0);
    expect(await tracker.read()).toEqual({ state: 'unavailable' });
    tracker.bindSession('owned-session', join(dir, 'missing-config'), 0);
    expect(await tracker.read()).toEqual({ state: 'unavailable' });
    tracker.reset();
    await writeFile(file, 'old\n');
    tracker.bindSession('owned-session', dir, 0);
    await tracker.read();
    await rename(file, `${file  }.old`);
    await writeFile(file, error());
    expect(await tracker.read()).toEqual({ state: 'unavailable' });
  });
});
