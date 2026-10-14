import { describe, expect, it } from 'vitest';
import { dshProcessEnv } from './dsh-environment.js';

describe('DSH child locale', () => {
  it.each([
    ['darwin', 'en_US.UTF-8'],
    ['linux', 'C.UTF-8'],
  ] as const)('supplies a platform UTF-8 locale when %s has no locale', (platform, fallback) => {
    const env = Object.freeze({ PATH: '/runtime/bin', DSH_HOME: '/native/home' });
    expect(dshProcessEnv(env, platform)).toEqual({ ...env, LC_ALL: fallback });
    expect(env).not.toHaveProperty('LC_ALL');
  });

  it.each([
    { LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'C', LANG: 'POSIX' },
    { LC_CTYPE: 'UTF-8', LANG: 'C' },
    { LANG: 'zh_CN.UTF-8' },
    { LC_ALL: 'C.utf8@custom' },
  ])('preserves an effective UTF-8 locale and its precedence: %j', (env) => {
    expect(dshProcessEnv(env, 'linux')).toEqual(env);
  });

  it.each([
    { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' },
    { LC_CTYPE: 'POSIX', LANG: 'zh_CN.UTF-8' },
  ])('uses a declared UTF-8 locale when a higher priority override is non-UTF-8: %j', (env) => {
    expect(dshProcessEnv(env, 'linux').LC_ALL).toBe('zh_CN.UTF-8');
    expect(env).not.toHaveProperty('LC_ALL', 'zh_CN.UTF-8');
  });

  it.each(['C', 'POSIX', 'en_US.ISO-8859-1', '   '])(
    'replaces the non-UTF-8 effective locale %j',
    (locale) => {
      expect(dshProcessEnv({ LC_ALL: locale }, 'linux').LC_ALL).toBe('C.UTF-8');
    }
  );

  it('leaves the Windows encoding setup to its native PowerShell profile', () => {
    const env = { LC_ALL: 'C', PATH: 'native-bin' };
    expect(dshProcessEnv(env, 'win32')).toEqual(env);
  });
});
