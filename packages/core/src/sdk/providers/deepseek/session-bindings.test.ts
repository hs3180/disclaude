import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DshSessionBindings } from './session-bindings.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-bindings-'));
  homes.push(home);
  return {
    home,
    bindings: new DshSessionBindings(home),
    directory: join(home, 'disclaude/session-bindings'),
  };
}

describe('DSH durable conversation references', () => {
  it('resumes an uncertain opening after restart without a fresh-session fallback', () => {
    const f = fixture();
    const first = f.bindings.reserve('chat', '/project');
    expect(first.resume).toBe(false);
    f.bindings.opening(first);
    const resumed = new DshSessionBindings(f.home).reserve('chat', '/project');
    expect(resumed).toMatchObject({ sessionId: first.sessionId, resume: true });
    expect(statSync(join(f.directory, `${first.scope}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(f.directory).mode & 0o777).toBe(0o700);
  });

  it('isolates chats and Project working directories without writing anonymous references', () => {
    const f = fixture();
    const first = f.bindings.reserve('chat', '/project-one');
    expect(f.bindings.reserve('chat', '/project-two').sessionId).not.toBe(first.sessionId);
    expect(f.bindings.reserve('other-chat', '/project-one').sessionId).not.toBe(first.sessionId);
    const count = readdirSync(f.directory).length;
    expect(f.bindings.reserve(undefined, '/project-one').scope).toBeUndefined();
    expect(readdirSync(f.directory)).toHaveLength(count);
  });

  it('reset preserves native history and ignores late acknowledgments from the old query', () => {
    const f = fixture();
    const history = join(f.home, 'sessions/history.jsonl');
    mkdirSync(join(f.home, 'sessions'));
    writeFileSync(history, 'owned native history');
    const old = f.bindings.reserve('chat', '/project');
    const other = f.bindings.reserve('other-chat', '/project');
    f.bindings.forget('chat');
    const replacement = f.bindings.reserve('chat', '/project');
    f.bindings.opened(old);
    expect(f.bindings.reserve('chat', '/project')).toEqual(replacement);
    expect(replacement.sessionId).not.toBe(old.sessionId);
    expect(f.bindings.reserve('other-chat', '/project')).toEqual(other);
    expect(readFileSync(history, 'utf8')).toBe('owned native history');
  });

  it('fails closed on corrupt or mismatched references and does not replace their evidence', () => {
    const f = fixture();
    const binding = f.bindings.reserve('chat', '/project');
    const file = join(f.directory, `${binding.scope}.json`);
    const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, cwd: '/foreign-project' }));
    expect(() => f.bindings.reserve('chat', '/project')).toThrow('scope mismatch');
    writeFileSync(file, JSON.stringify({ ...record, state: 'invalid' }));
    expect(() => f.bindings.reserve('chat', '/project')).toThrow('repair the owned reference');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ state: 'invalid' });
  });
});
