// Issue #5619: verifiable install/update path for the launchd application
// service. `disclaude service <cmd> --dry-run` (and the direct
// `scripts/launchd.mjs service <cmd> --dry-run` form) must print the plist
// that would be written and the launchctl commands that would run — without
// writing files or executing launchctl. On non-macOS hosts the mutating
// commands must fail closed without --dry-run so a stray invocation can
// never touch a real service. This file runs on Linux CI exactly that way.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHD_SCRIPT = join(ROOT, 'scripts/launchd.mjs');
const UNIFIED_CLI = join(ROOT, 'bin/disclaude.js');

const CONFIG_YAML = [
  'launchd:',
  '  entry: /opt/disclaude/bin/disclaude.js',
  '  apiPort: 8400',
  '  apiToken: cfg-secret',
  '  env:',
  '    FEISHU_REGION: cn',
  'env:',
  '  MY_TOOL_HOME: /opt/my-tool',
  '',
].join('\n');

async function runServiceCommand(
  target: string,
  args: string[],
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [target, ...args], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

function isolatedHome(): { home: string; configPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'launchd-dryrun-'));
  mkdirSync(join(home, '.disclaude'), { recursive: true });
  const configPath = join(home, '.disclaude', 'disclaude.config.yaml');
  writeFileSync(configPath, CONFIG_YAML);
  return { home, configPath };
}

function assertNothingWritten(home: string) {
  // Neither the plist target directory nor the log directory may appear.
  expect(existsSync(join(home, 'Library', 'LaunchAgents'))).toBe(false);
  expect(existsSync(join(home, 'Library', 'Logs'))).toBe(false);
}

describe('launchd service commands with --dry-run (#5619)', () => {
  it('install --dry-run prints the config-driven plist and the bootstrap command, writing nothing', async () => {
    const { home, configPath } = isolatedHome();
    try {
      const { code, stdout } = await runServiceCommand(
        LAUNCHD_SCRIPT,
        ['service', 'install', '--dry-run'],
        { HOME: home, DISCLAUDE_CONFIG_PATH: configPath }
      );
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('[dry-run]');
      expect(stdout).toContain(`would run: launchctl bootstrap gui/${process.getuid()} ${join(home, 'Library', 'LaunchAgents', 'com.disclaude.service.plist')}`);
      // Plist reproduces the production service: configured entry, fixed
      // port from the config, explicit --config, config env block.
      expect(stdout).toContain('<string>/opt/disclaude/bin/disclaude.js</string>');
      expect(stdout).toContain('<string>--api-port</string>');
      expect(stdout).toContain('<string>8400</string>');
      expect(stdout).not.toContain('<string>0</string>');
      expect(stdout).toContain(`--config`);
      expect(stdout).toContain(configPath);
      expect(stdout).toContain('<key>FEISHU_REGION</key>');
      expect(stdout).toContain('<key>MY_TOOL_HOME</key>');
      expect(stdout).toContain('no launchctl commands executed');
      assertNothingWritten(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('stop --dry-run prints the bootout command and executes nothing', async () => {
    const { home } = isolatedHome();
    try {
      const { code, stdout } = await runServiceCommand(
        LAUNCHD_SCRIPT,
        ['service', 'stop', '--dry-run'],
        { HOME: home }
      );
      expect(code, stdout).toBe(0);
      expect(stdout).toContain(`would run: launchctl bootout gui/${process.getuid()}/com.disclaude.service`);
      expect(stdout).toContain('no launchctl commands executed');
      assertNothingWritten(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('status --dry-run reports the label and plist path without launchctl', async () => {
    const { home } = isolatedHome();
    try {
      const { code, stdout } = await runServiceCommand(
        LAUNCHD_SCRIPT,
        ['service', 'status', '--dry-run'],
        { HOME: home }
      );
      expect(code, stdout).toBe(0);
      expect(stdout).toContain(`would run: launchctl print gui/${process.getuid()}/com.disclaude.service`);
      expect(stdout).toContain('com.disclaude.service.plist');
      assertNothingWritten(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('routes `disclaude service status --dry-run` through the unified CLI', async () => {
    const { home } = isolatedHome();
    try {
      const { code, stdout, stderr } = await runServiceCommand(
        UNIFIED_CLI,
        ['service', 'status', '--dry-run'],
        { HOME: home }
      );
      expect(code, stderr).toBe(0);
      expect(stdout).toContain(`would run: launchctl print gui/${process.getuid()}/com.disclaude.service`);
      assertNothingWritten(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('fails closed outside macOS without --dry-run, leaving nothing behind', async () => {
    const { home, configPath } = isolatedHome();
    try {
      const { code, stdout, stderr } = await runServiceCommand(
        LAUNCHD_SCRIPT,
        ['service', 'install'],
        { HOME: home, DISCLAUDE_CONFIG_PATH: configPath }
      );
      expect(code).not.toBe(0);
      expect(stderr).toContain('requires macOS');
      expect(stderr).toContain('--dry-run');
      expect(stdout).not.toContain('launchctl bootstrap');
      assertNothingWritten(home);
      expect(readdirSync(home).sort()).toEqual(['.disclaude']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('generate --dry-run previews the plist without writing LaunchAgents', async () => {
    const { home, configPath } = isolatedHome();
    try {
      const { code, stdout } = await runServiceCommand(
        LAUNCHD_SCRIPT,
        ['generate', '--dry-run'],
        { HOME: home, DISCLAUDE_CONFIG_PATH: configPath }
      );
      expect(code, stdout).toBe(0);
      expect(stdout).toContain('NOT written');
      expect(stdout).toContain('<string>/opt/disclaude/bin/disclaude.js</string>');
      expect(stdout).toContain('<string>8400</string>');
      assertNothingWritten(home);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
