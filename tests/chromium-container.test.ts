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
    expect(result.stderr).not.toContain('retail Google Chrome executable not found');
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
    // #5658 review: the Playwright base-image build arg is gone; the image
    // ships exactly one browser (retail Chrome from the pinned-deb layer).
    expect(browser.build.args ?? {}).toEqual({});
    expect(browser.image).toBe('disclaude-chromium:${CHROMIUM_IMAGE_TAG:-retail}');
    const dockerfile = readFileSync(join(browser.build.context, browser.build.dockerfile), 'utf8');
    expect(dockerfile).toContain('COPY start-chromium.sh');
    expect(dockerfile).toContain('VOLUME ["/data/chrome-profile"]');
    expect(dockerfile).toContain('FROM ubuntu:24.04');
    expect(dockerfile).not.toContain('mcr.microsoft.com/playwright');
    expect(dockerfile).toContain('COPY --from=node:22-bookworm-slim /usr/local/bin/node');
    expect(dockerfile).toContain('test -x /opt/google/chrome/chrome');
    // #5653 review 6646239269: the profile mount source is user-selectable —
    // an absolute host path via CHROMIUM_PROFILE_VOLUME, or the managed named
    // volume by default; the target stays the profile dir Chromium uses.
    expect(browser.volumes).toContainEqual(
      '${CHROMIUM_PROFILE_VOLUME:-chromium_profile}:${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}'
    );
    expect(browser.environment).toContain('CHROMIUM_CDP_PROFILE_DIR=${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}');
    expect(compose.volumes).toHaveProperty('chromium_profile');
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    expect(launcher).toContain('CHROMIUM_CDP_PROFILE_DIR=${CHROMIUM_CDP_PROFILE_DIR:-/data/chrome-profile}');
    expect(launcher).toContain('"--user-data-dir=$CHROMIUM_CDP_PROFILE_DIR"');
    // A bind-mounted profile dir may not permit chmod; startup must not brick.
    expect(launcher).toContain('could not tighten permissions');
    expect(readFileSync(resolve('docs/chromium-container.md'), 'utf8')).toContain('CHROMIUM_PROFILE_VOLUME');
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

  // Extracted from the real launcher so the probe is tested verbatim (#5652,
  // #5658 review): retail-only — no Playwright fallback, fail closed.
  const probe = readFileSync(resolve('docker/start-chromium.sh'), 'utf8')
    .match(/^select_browser_binary\(\) \{[\s\S]*?^\}/m)![0];
  const runProbe = (retail: string) => {
    const result = spawnSync('bash', ['-c', `${probe}\nselect_browser_binary "$PROBE_RETAIL"`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, PROBE_RETAIL: retail },
    });
    return { status: result.status, stdout: (result.stdout ?? '').trimEnd(), stderr: result.stderr ?? '' };
  };
  // Every fixture keeps an executable browser at the legacy fallback location
  // so the "no downgrade" scenarios prove the fallback path is really gone.
  const makeFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-chromium-probe-'));
    const playwrightBinary = join(root, 'ms-playwright', 'chromium-1234', 'chrome-linux', 'chrome');
    mkdirSync(dirname(playwrightBinary), { recursive: true });
    writeFileSync(playwrightBinary, '');
    chmodSync(playwrightBinary, 0o755);
    return { root, playwrightBinary };
  };

  it('selects the retail Google Chrome binary when the deb layer is present', () => {
    const { root } = makeFixture();
    try {
      const retail = join(root, 'opt', 'google', 'chrome', 'chrome');
      mkdirSync(dirname(retail), { recursive: true });
      writeFileSync(retail, '');
      chmodSync(retail, 0o755);
      const result = runProbe(retail);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(retail);
      expect(result.stderr).toContain('INFO: using retail Google Chrome binary');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed without the retail binary even when a bundled Chromium still exists', () => {
    const { root } = makeFixture();
    try {
      const result = runProbe(join(root, 'opt', 'google', 'chrome', 'chrome'));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('FATAL: retail Google Chrome executable not found');
      expect(result.stderr).toContain('no fallback browser');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores a non-executable retail binary instead of downgrading', () => {
    const { root } = makeFixture();
    try {
      const retail = join(root, 'opt', 'google', 'chrome', 'chrome');
      mkdirSync(dirname(retail), { recursive: true });
      writeFileSync(retail, '');
      chmodSync(retail, 0o644);
      const result = runProbe(retail);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('FATAL: retail Google Chrome executable not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when no browser exists at all', () => {
    const { root } = makeFixture();
    rmSync(join(root, 'ms-playwright'), { recursive: true, force: true });
    try {
      const result = runProbe(join(root, 'opt', 'google', 'chrome', 'chrome'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('FATAL: retail Google Chrome executable not found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('launches Chromium with software WebGL, session restore, and UI language flags', () => {
    const launcher = readFileSync(resolve('docker/start-chromium.sh'), 'utf8');
    // Zero-GPU software WebGL for Chrome 132+ (SwiftShader via the ANGLE Vulkan
    // backend); the gles backend blanks on Xvfb, so it must stay absent.
    expect(launcher).toContain('--enable-unsafe-swiftshader');
    expect(launcher).toContain('--use-gl=angle');
    expect(launcher).toContain('--use-angle=vulkan');
    expect(launcher).not.toContain('--use-angle=gles');
    // Chrome must restore the previous session so session-level cookies survive
    // a full container rebuild+recreate (profile dir is a named volume).
    expect(launcher).toContain('--restore-last-session');
    // --accept-lang alone leaves the UI locale at en-US; the UI language must
    // follow the first Accept-Language segment.
    expect(launcher).toContain('"--lang=${CHROMIUM_ACCEPT_LANG%%,*}"');
  });

  it('derives the --lang flag from the first CHROMIUM_ACCEPT_LANG segment', () => {
    const lines = readFileSync(resolve('docker/start-chromium.sh'), 'utf8').split('\n');
    const start = lines.findIndex((line) => line.startsWith('args=('));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(')'));
    expect(end).toBeGreaterThan(start);
    // Eval the real args block from the launcher, not a copy of it.
    const harness = lines.slice(start, end + 1).join('\n') + '\nprintf \'%s\\n\' "${args[@]}"';
    for (const [acceptLang, uiLang] of [
      ['en-US,en', 'en-US'],
      ['zh-CN,zh;q=0.9,en', 'zh-CN'],
      ['ja', 'ja'],
    ] as const) {
      const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8', env: {
        PATH: process.env.PATH, CDP_INTERNAL_PORT: '9221',
        CHROMIUM_CDP_PROFILE_DIR: '/data/chrome-profile', CHROMIUM_ACCEPT_LANG: acceptLang,
      } });
      expect(result.status).toBe(0);
      const argv = (result.stdout ?? '').split('\n');
      expect(argv).toContain('--enable-unsafe-swiftshader');
      expect(argv).toContain('--use-gl=angle');
      expect(argv).toContain('--use-angle=vulkan');
      expect(argv).toContain('--restore-last-session');
      expect(argv).toContain(`--lang=${uiLang}`);
      expect(argv).not.toContain(expect.stringContaining('gles'));
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
