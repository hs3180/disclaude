import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const exec = promisify(execFile);
describe('first-run terminal workspace and actual service', () => {
  it.skipIf(process.platform === 'win32')('persists selection and stores files in it across restarts', async () => {
    const result = await exec('python3', [resolve('tests/e2e/helpers/workspace-onboarding.py'), process.execPath, resolve('bin/disclaude.js')], { timeout: 100_000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ realUploadAcrossRestarts: true, cancelNoWrite: true, secondStartNoPrompt: true });
  }, 110_000);
});
