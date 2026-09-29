import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs utility has no declaration file.
import { collectSetupSelection, parseSetupArgs } from '../scripts/chromium-setup.mjs';

describe('Chromium setup arguments', () => {
  it('does not expose a profile-copy option', () => {
    expect(() => parseSetupArgs(['--copy-profile-from', '/profiles/old']))
      .toThrow('Unknown setup option: --copy-profile-from');
  });

  it('does not prompt to copy a profile when selecting a new persistent path', async () => {
    const prompts: string[] = [];
    const ask = async (prompt: string) => { prompts.push(prompt); return ''; };
    const profile = '/var/lib/disclaude/custom-profile';
    const selection = await collectSetupSelection({ '--binary': process.execPath }, {
      CHROMIUM_CDP_PROFILE_DIR: profile,
    }, ask);

    expect(selection.CHROMIUM_CDP_PROFILE_DIR).toBe(profile);
    expect(prompts.some(prompt => /copy.*profile/i.test(prompt))).toBe(false);
  });
});
