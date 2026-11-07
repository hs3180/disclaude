import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { manageDiagnosticsPlugin } from './diagnostics-plugin.js';
import {
  assertNoUndeliverableSkillSources,
  undeliverableSkillSourceError,
  type NativeSkillChannel,
} from './native-skill-channel.js';
import { afterEach, describe, expect, it } from 'vitest';

const CHANNEL: NativeSkillChannel = {
  harness: 'test-harness',
  evidence: 'no native skill registration/discovery API (verified against vendored runtime)',
  remedy: 'Run plugins remove diagnostics, or use a backend with a native skills channel.',
};

describe('native skill channel gate (#5717)', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function project(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'native-skill-channel-'));
    directories.push(directory);
    return directory;
  }

  it('passes without a project root or without an explicit installation', async () => {
    const root = await project();
    expect(() => assertNoUndeliverableSkillSources(CHANNEL, undefined)).not.toThrow();
    expect(() => assertNoUndeliverableSkillSources(CHANNEL, root)).not.toThrow();
  });

  it('preserves the explicit-install boundary for a tampered installation', async () => {
    const root = await project();
    manageDiagnosticsPlugin('install', root, resolve('.'));
    await writeFile(
      join(root, '.disclaude', 'plugins', 'diagnostics', 'skills', 'diagnose-logs', 'SKILL.md'),
      '---\ndescription: tampered\n---\nEdited outside the installer.'
    );
    // An edited installation delivers nothing today and must not brick the backend.
    expect(() => assertNoUndeliverableSkillSources(CHANNEL, root)).not.toThrow();
  });

  it('fails fast with an actionable diagnostic for a valid explicit installation', async () => {
    const root = await project();
    manageDiagnosticsPlugin('install', root, resolve('.'));
    expect(() => assertNoUndeliverableSkillSources(CHANNEL, root)).toThrow(
      'test-harness cannot natively load Disclaude-managed skills: no native skill registration/discovery API ' +
        '(verified against vendored runtime). Run plugins remove diagnostics, or use a backend with a native skills ' +
        'channel. No prompt manifest was injected and no model turn was submitted.'
    );
  });

  it('exposes the shared error constructor for backends with custom gating', () => {
    // The Pi backend (#5717 sibling) consumes the same message shape.
    expect(undeliverableSkillSourceError(CHANNEL).message).toContain('No prompt manifest was injected');
    expect(undeliverableSkillSourceError(CHANNEL)).toBeInstanceOf(Error);
  });
});
