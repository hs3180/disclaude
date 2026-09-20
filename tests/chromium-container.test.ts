import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

describe('container Chromium configuration', () => {
  it.each([
    [{ CDP_PORT: '0' }, 'integers'],
    [{ CDP_PORT: '65536' }, 'integers'],
    [{ CDP_PORT: '9222junk' }, 'integers'],
    [{ CDP_PORT: '09222', CDP_INTERNAL_PORT: '9222' }, 'must differ'],
    [{ CHROMIUM_HEADLESS: 'maybe' }, 'must be 0 or 1'],
    [{ CHROMIUM_PROFILE_DIR: 'relative' }, 'must be absolute'],
  ])('fails invalid inputs before launching dependencies: %j', (overrides, message) => {
    const result = spawnSync('bash', [resolve('docker/start-chromium.sh')], { encoding: 'utf8', env: {
      PATH: process.env.PATH, CDP_PORT: '9222', CDP_INTERNAL_PORT: '9221', ...overrides,
    } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('bundled Chromium executable not found');
  });

  it('ships image sources and wires the persistent volume into the compose service', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(manifest.files).toContain('docker/');
    const compose = yaml.load(readFileSync(resolve('docker-compose.yml'), 'utf8')) as any;
    const browser = compose.services.chromium;
    expect(browser.init).toBe(true);
    expect(browser.volumes).toContain('chromium_profile:/data/chrome-profile');
    expect(compose.volumes).toHaveProperty('chromium_profile');
    expect(readFileSync(join(browser.build.context, browser.build.dockerfile), 'utf8')).toContain('COPY start-chromium.sh');
    expect(browser.ports).toEqual(['127.0.0.1:${CDP_PORT:-9222}:${CDP_PORT:-9222}']);
  });

  it('keeps Chromium automation exposure disabled in the container launcher', () => {
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    expect(launcher).toContain('--disable-blink-features=AutomationControlled');
  });
});
