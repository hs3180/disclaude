import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

describe('container Chromium configuration', () => {
  it.each([
    [{ CDP_PORT: '0' }, 'integers'],
    [{ CDP_PORT: '65536' }, 'integers'],
    [{ CDP_PORT: '9222junk' }, 'integers'],
    [{ CDP_PORT: '09222', CDP_INTERNAL_PORT: '9222' }, 'must differ'],
    [{ CHROMIUM_HEADLESS: 'maybe' }, 'must be 0 or 1'],
    [{ CHROMIUM_VNC_ENABLED: 'maybe' }, 'CHROMIUM_VNC_ENABLED must be 0 or 1'],
    [{ CHROMIUM_VNC_ENABLED: '1', CHROMIUM_VNC_PASSWORD: 'short' }, 'CHROMIUM_VNC_PASSWORD must be exactly 8 printable ASCII characters'],
    [{ CHROMIUM_CDP_PROFILE_DIR: 'relative' }, 'must be absolute'],
  ])('fails invalid inputs before launching dependencies: %j', (overrides, message) => {
    const result = spawnSync('bash', [resolve('docker/start-chromium.sh')], { encoding: 'utf8', env: {
      PATH: process.env.PATH, CDP_PORT: '9222', CDP_INTERNAL_PORT: '9221', ...overrides,
    } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain('bundled Chromium executable not found');
  });

  it('skips VNC in headless mode without rejecting the enabled default', () => {
    const result = spawnSync('/bin/bash', [resolve('docker/start-chromium.sh')], { encoding: 'utf8', env: {
      PATH: '', CHROMIUM_HEADLESS: '1', CHROMIUM_VNC_ENABLED: '1',
    } });
    // An empty dependency path stops before touching host browser resources.
    // Configuration must first accept the headless skip rather than fail on VNC.
    expect(result.stderr).toContain('INFO: headless Chromium skips VNC/noVNC');
    expect(result.stderr).not.toContain('requires headed Chromium');
    expect(result.stderr).not.toContain('CHROMIUM_VNC_PASSWORD must');
  });

  it('validates an explicit VNC password when enablement is omitted', () => {
    const result = spawnSync('bash', [resolve('docker/start-chromium.sh')], { encoding: 'utf8', env: {
      PATH: process.env.PATH, CHROMIUM_VNC_PASSWORD: 'short',
    } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHROMIUM_VNC_PASSWORD must be exactly 8 printable ASCII characters');
    expect(result.stderr).not.toContain('bundled Chromium executable not found');
  });

  it('keeps source checkout Compose configured and excludes it from npm artifacts', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    expect(manifest.files).not.toContain('docker/');
    const compose = yaml.load(readFileSync(resolve('docker-compose.yml'), 'utf8')) as any;
    const browser = compose.services.chromium;
    expect(browser.init).toBe(true);
    expect(browser.volumes).toContainEqual({
      type: 'volume', source: 'chromium_profile', target: '${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}',
    });
    expect(browser.environment).toContain('CHROMIUM_CDP_PROFILE_DIR=${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}');
    expect(compose.volumes).toHaveProperty('chromium_profile');
    expect(readFileSync(join(browser.build.context, browser.build.dockerfile), 'utf8')).toContain('COPY start-chromium.sh');
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    expect(launcher).toContain('CHROMIUM_CDP_PROFILE_DIR=${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}');
    expect(launcher).toContain('"--user-data-dir=$CHROMIUM_CDP_PROFILE_DIR"');
    const acceptance = readFileSync(resolve('scripts/test-chromium-container.mjs'), 'utf8');
    expect(acceptance).toContain("'-v', `${volume}:${profilePath}`");
    expect(acceptance).toContain("'-e', `CHROMIUM_CDP_PROFILE_DIR=${profilePath}`");
    expect(browser.ports).toEqual([
      '127.0.0.1:${CDP_PORT:-9222}:${CDP_PORT:-9222}',
      '${CHROMIUM_VNC_BIND:-0.0.0.0}:${CHROMIUM_VNC_HOST_PORT:-6080}:6080',
    ]);
  });

  it('keeps Chromium automation exposure disabled in the container launcher', () => {
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    expect(launcher).toContain('--disable-blink-features=AutomationControlled');
  });

  // Extracted from the real launcher so the probe is tested verbatim (#5652):
  // retail Google Chrome first, bundled Playwright Chromium as fallback.
  const probe = readFileSync(resolve('docker/start-chromium.sh'), 'utf8')
    .match(/^select_browser_binary\(\) \{[\s\S]*?^\}/m)![0];
  const runProbe = (retail: string, glob: string) => {
    const result = spawnSync('bash', ['-c', `${probe}\nselect_browser_binary "$PROBE_RETAIL" "$PROBE_GLOB"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PROBE_RETAIL: retail, PROBE_GLOB: glob },
    });
    return { status: result.status, stdout: (result.stdout ?? '').trimEnd(), stderr: result.stderr ?? '' };
  };
  const makeFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-chromium-probe-'));
    const playwrightBinary = join(root, 'chromium-1234', 'chrome-linux', 'chrome');
    mkdirSync(dirname(playwrightBinary), { recursive: true });
    writeFileSync(playwrightBinary, '');
    chmodSync(playwrightBinary, 0o755);
    return { root, playwrightBinary };
  };

  it('prefers the retail Google Chrome binary when the deb layer is present', () => {
    const { root, playwrightBinary } = makeFixture();
    try {
      const retail = join(root, 'opt', 'google', 'chrome', 'chrome');
      mkdirSync(dirname(retail), { recursive: true });
      writeFileSync(retail, '');
      chmodSync(retail, 0o755);
      const result = runProbe(retail, join(root, 'chromium-*', 'chrome-linux*', 'chrome'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(retail);
      expect(result.stderr).toContain('INFO: using retail Google Chrome binary');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the bundled Playwright Chromium without the retail deb', () => {
    const { root, playwrightBinary } = makeFixture();
    try {
      const result = runProbe(join(root, 'opt', 'google', 'chrome', 'chrome'), join(root, 'chromium-*', 'chrome-linux*', 'chrome'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(playwrightBinary);
      expect(result.stderr).not.toContain('retail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores a non-executable retail binary and keeps Playwright behavior unchanged', () => {
    const { root, playwrightBinary } = makeFixture();
    try {
      const retail = join(root, 'opt', 'google', 'chrome', 'chrome');
      mkdirSync(dirname(retail), { recursive: true });
      writeFileSync(retail, '');
      chmodSync(retail, 0o644);
      const result = runProbe(retail, join(root, 'chromium-*', 'chrome-linux*', 'chrome'));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(playwrightBinary);
      expect(result.stderr).not.toContain('retail');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails with the original fatal message when no executable browser exists', () => {
    const { root } = makeFixture();
    rmSync(join(root, 'chromium-1234'), { recursive: true, force: true });
    try {
      const result = runProbe(join(root, 'opt', 'google', 'chrome', 'chrome'), join(root, 'chromium-*', 'chrome-linux*', 'chrome'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FATAL: bundled Chromium executable not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes the password-protected headed view by default', () => {
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    const dockerfile = readFileSync(resolve('docker/Dockerfile.chromium'), 'utf8');
    const override = yaml.load(readFileSync(resolve('docker-compose.chromium-vnc.yml'), 'utf8')) as any;
    const compose = yaml.load(readFileSync(resolve('docker-compose.yml'), 'utf8')) as any;
    expect(compose.services.chromium.environment).toContain('CHROMIUM_VNC_ENABLED=${CHROMIUM_VNC_ENABLED:-1}');
    expect(compose.services.chromium.environment).toContain('CHROMIUM_VNC_PASSWORD=${CHROMIUM_VNC_PASSWORD:-}');
    expect(launcher).toContain('x11vnc');
    expect(launcher).toContain('websockify --web=/usr/share/novnc');
    expect(dockerfile).toContain('x11vnc novnc websockify');
    expect(override.services.chromium.environment.CHROMIUM_VNC_ENABLED).toBe('1');
    expect(override.services.chromium.environment.CHROMIUM_VNC_PASSWORD).toBe('${CHROMIUM_VNC_PASSWORD:-}');
    expect(override.services.chromium.ports).toEqual([
      '${CHROMIUM_VNC_BIND:-0.0.0.0}:${CHROMIUM_VNC_HOST_PORT:-6080}:6080',
    ]);
  });
});
