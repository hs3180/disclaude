/**
 * Smoke tests for scripts/launchd.mjs — macOS launchd management.
 *
 * Covers plist generation format, helper functions, command dispatch,
 * and error-handling paths.  External commands (launchctl, npm run build,
 * tail) and filesystem writes are mocked so the tests run on any OS.
 *
 * @see Issue #2894 — add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

/**
 * Helper: reset all mocks between tests.
 */
function resetMocks() {
  vi.mocked(execSync).mockReset();
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(existsSync).mockReset().mockReturnValue(false);
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(rmSync).mockReset();
}

// ---------------------------------------------------------------------------
// Dynamic import (ESM .mjs) — re-imported after each mock reset
// ---------------------------------------------------------------------------

// We store the module reference here and reload before each test block.
// Because the module has no top-level side-effects after the refactor
// (the main() guard prevents auto-run when imported), we can safely
// import once and reuse.

let mod: typeof import('../../scripts/launchd.mjs');

beforeEach(async () => {
  resetMocks();
  // Default: `which node` succeeds
  vi.mocked(execSync).mockImplementation((cmd: string) => {
    if (cmd === 'which node') return '/usr/local/bin/node\n';
    return '';
  });
  // Force re-import to pick up fresh mocks
  vi.resetModules();
  mod = await import('../../scripts/launchd.mjs');
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('should export LABEL as com.disclaude.primary', () => {
    expect(mod.LABEL).toBe('com.disclaude.primary');
  });

  it('should derive PLIST_FILENAME from LABEL', () => {
    expect(mod.PLIST_FILENAME).toBe(`${mod.LABEL}.plist`);
  });

  it('should place plist in ~/Library/LaunchAgents', () => {
    expect(mod.PLIST_PATH).toContain('Library/LaunchAgents');
    expect(mod.PLIST_PATH).toContain(mod.PLIST_FILENAME);
  });

  it('should define stdout and stderr log paths', () => {
    expect(mod.STDOUT_LOG).toMatch(/disclaude.*\.log/);
    expect(mod.STDERR_LOG).toMatch(/disclaude.*\.log/);
  });
});

// ---------------------------------------------------------------------------
// getNodePath
// ---------------------------------------------------------------------------

describe('getNodePath', () => {
  it('should return trimmed node path from `which node`', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/opt/homebrew/bin/node\n';
      return '';
    });

    expect(mod.getNodePath()).toBe('/opt/homebrew/bin/node');
  });

  it('should call process.exit(1) when node is not found', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found');
    });

    expect(() => mod.getNodePath()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// run helper
// ---------------------------------------------------------------------------

describe('run', () => {
  it('should execute command and return output', () => {
    vi.mocked(execSync).mockReturnValue('ok\n');
    const result = mod.run('echo ok');
    expect(result).toBe('ok\n');
  });

  it('should throw on failure by default', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => mod.run('false')).toThrow('boom');
  });

  it('should return null on failure when allowFail is set', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('boom');
    });
    const result = mod.run('false', { allowFail: true, silent: true });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensureLaunchAgentsDir
// ---------------------------------------------------------------------------

describe('ensureLaunchAgentsDir', () => {
  it('should create directory when it does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    mod.ensureLaunchAgentsDir();
    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('Library/LaunchAgents'),
      { recursive: true },
    );
  });

  it('should not create directory when it already exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mod.ensureLaunchAgentsDir();
    expect(mkdirSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// generatePlist
// ---------------------------------------------------------------------------

describe('generatePlist', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node\n';
      return '';
    });
  });

  it('should write a plist file', () => {
    mod.generatePlist();
    expect(writeFileSync).toHaveBeenCalledTimes(1);
    const [path, content] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toContain('com.disclaude.primary.plist');
    expect(typeof content).toBe('string');
  });

  it('should produce valid plist XML header', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain('<!DOCTYPE plist');
    expect(content).toContain('<plist version="1.0">');
  });

  it('should include correct Label', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>Label</key>');
    expect(content).toContain('<string>com.disclaude.primary</string>');
  });

  it('should include ProgramArguments with node path and entry point', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>ProgramArguments</key>');
    expect(content).toContain('<string>/usr/local/bin/node</string>');
    expect(content).toContain('packages/primary-node/dist/cli.js');
    expect(content).toContain('<string>start</string>');
  });

  it('should include WorkingDirectory', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>WorkingDirectory</key>');
  });

  it('should set RunAtLoad and KeepAlive to true', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>RunAtLoad</key>');
    expect(content).toMatch(/<true\/>/); // at least one <true/>
    expect(content).toContain('<key>KeepAlive</key>');
  });

  it('should include StandardOutPath and StandardErrorPath', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>StandardOutPath</key>');
    expect(content).toContain('<key>StandardErrorPath</key>');
  });

  it('should include EnvironmentVariables with PATH, HOME, NODE_ENV', () => {
    mod.generatePlist();
    const content = vi.mocked(writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain('<key>EnvironmentVariables</key>');
    expect(content).toContain('<key>PATH</key>');
    expect(content).toContain('<key>HOME</key>');
    expect(content).toContain('<key>NODE_ENV</key>');
    expect(content).toContain('<string>production</string>');
  });

  it('should ensure LaunchAgents directory exists', () => {
    mod.generatePlist();
    expect(existsSync).toHaveBeenCalledWith(expect.stringContaining('Library/LaunchAgents'));
  });
});

// ---------------------------------------------------------------------------
// loadPlist
// ---------------------------------------------------------------------------

describe('loadPlist', () => {
  it('should load plist when it exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mod.loadPlist();
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('launchctl load'),
      expect.anything(),
    );
  });

  it('should exit when plist does not exist', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => mod.loadPlist()).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// unloadPlist
// ---------------------------------------------------------------------------

describe('unloadPlist', () => {
  it('should unload plist when it exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mod.unloadPlist();
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('launchctl unload'),
      expect.anything(),
    );
  });

  it('should skip when plist does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    mod.unloadPlist();
    // execSync may have been called for other things, but not for unload
    const calls = vi.mocked(execSync).mock.calls;
    const unloadCalls = calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('launchctl unload'),
    );
    expect(unloadCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cmdUninstall
// ---------------------------------------------------------------------------

describe('cmdUninstall', () => {
  it('should unload and remove plist file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mod.cmdUninstall();
    expect(rmSync).toHaveBeenCalledWith(
      expect.stringContaining('com.disclaude.primary.plist'),
    );
  });
});

// ---------------------------------------------------------------------------
// main (CLI dispatch)
// ---------------------------------------------------------------------------

describe('main', () => {
  it('should show usage and exit when no command is given', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    expect(() => mod.main(['node', 'launchd.mjs'])).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('should show usage and exit for unknown command', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    expect(() => mod.main(['node', 'launchd.mjs', 'foobar'])).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('should dispatch generate command', () => {
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node\n';
      return '';
    });
    // Should not throw
    mod.main(['node', 'launchd.mjs', 'generate']);
    expect(writeFileSync).toHaveBeenCalled();
  });

  it('should dispatch stop command (calls unloadPlist)', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    // stop just calls unloadPlist — which is a no-op if plist doesn't exist
    mod.main(['node', 'launchd.mjs', 'stop']);
    // No crash = success
  });
});

// ---------------------------------------------------------------------------
// commands map
// ---------------------------------------------------------------------------

describe('commands map', () => {
  it('should define all expected commands', () => {
    const expected = ['generate', 'install', 'uninstall', 'start', 'stop', 'restart', 'logs', 'status'];
    for (const cmd of expected) {
      expect(mod.commands).toHaveProperty(cmd);
      expect(typeof mod.commands[cmd as keyof typeof mod.commands]).toBe('function');
    }
  });
});
