/**
 * Tests for scripts/launchd.mjs — macOS launchd management.
 *
 * Issue #2894: Add test coverage for scripts/launchd.mjs.
 *
 * All tests mock external dependencies (child_process, fs, os) to avoid
 * real system side effects. The focus is on plist generation format,
 * command routing, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (hoisted before module import)
// ---------------------------------------------------------------------------

const mockExecSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn(() => false);
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

const TEST_HOME = '/test/home';

vi.mock('node:os', () => ({
  homedir: () => TEST_HOME,
}));

// Mock process.exit to prevent test termination
const mockExit = vi.fn((_code?: number) => undefined) as never;
const originalExit = process.exit;

// ---------------------------------------------------------------------------
// Import module under test (after mocks are set up)
// ---------------------------------------------------------------------------

const launchd = await import('./launchd.mjs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('launchd constants', () => {
  it('should have correct label', () => {
    expect(launchd.LABEL).toBe('com.disclaude.primary');
  });

  it('should have correct plist filename', () => {
    expect(launchd.PLIST_FILENAME).toBe('com.disclaude.primary.plist');
  });

  it('should resolve plist path under LaunchAgents', () => {
    expect(launchd.PLIST_PATH).toBe(`${TEST_HOME}/Library/LaunchAgents/com.disclaude.primary.plist`);
  });

  it('should resolve log directory under home Library', () => {
    expect(launchd.LOG_DIR).toBe(`${TEST_HOME}/Library/Logs/disclaude`);
  });

  it('should resolve stderr log path', () => {
    expect(launchd.STDERR_LOG).toBe(`${TEST_HOME}/Library/Logs/disclaude/launchd-stderr.log`);
  });

  it('should resolve app log path', () => {
    expect(launchd.APP_LOG).toBe(`${TEST_HOME}/Library/Logs/disclaude/disclaude-combined.log`);
  });

  it('should resolve CLI entry to dist/cli.js', () => {
    expect(launchd.CLI_ENTRY).toContain('packages/primary-node/dist/cli.js');
  });
});

describe('getNodePath', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    process.exit = mockExit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('should return trimmed node path', () => {
    mockExecSync.mockReturnValue('  /usr/local/bin/node  \n');
    expect(launchd.getNodePath()).toBe('/usr/local/bin/node');
    expect(mockExecSync).toHaveBeenCalledWith('which node', { encoding: 'utf-8' });
  });

  it('should exit with code 1 when node is not found', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    launchd.getNodePath();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('run', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('should execute command and return output', () => {
    mockExecSync.mockReturnValue('output');
    const result = launchd.run('echo hello');
    expect(result).toBe('output');
  });

  it('should pass silent option as pipe stdio', () => {
    mockExecSync.mockReturnValue('');
    launchd.run('echo hello', { silent: true });
    expect(mockExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({ stdio: 'pipe' }));
  });

  it('should use inherit stdio when not silent', () => {
    mockExecSync.mockReturnValue('');
    launchd.run('echo hello');
    expect(mockExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({ stdio: 'inherit' }));
  });

  it('should throw on command failure by default', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    expect(() => launchd.run('bad-command')).toThrow('command failed');
  });

  it('should return null on failure when allowFail is true', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    const result = launchd.run('bad-command', { allowFail: true });
    expect(result).toBeNull();
  });
});

describe('ensureLaunchAgentsDir', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
  });

  it('should create directory if it does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    launchd.ensureLaunchAgentsDir();
    expect(mockMkdirSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/LaunchAgents`,
      { recursive: true },
    );
  });

  it('should not create directory if it already exists', () => {
    mockExistsSync.mockReturnValue(true);
    launchd.ensureLaunchAgentsDir();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });
});

describe('ensureLogDir', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
  });

  it('should create log directory with restrictive permissions (0o700)', () => {
    mockExistsSync.mockReturnValue(false);
    launchd.ensureLogDir();
    expect(mockMkdirSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/Logs/disclaude`,
      { recursive: true, mode: 0o700 },
    );
  });

  it('should not create directory if it already exists', () => {
    mockExistsSync.mockReturnValue(true);
    launchd.ensureLogDir();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });
});

describe('getCaffeinatePath', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('should return caffeinate path when available', () => {
    mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');
    expect(launchd.getCaffeinatePath()).toBe('/usr/bin/caffeinate');
  });

  it('should return null when caffeinate is not available', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(launchd.getCaffeinatePath()).toBeNull();
  });
});

describe('buildProgramArguments', () => {
  it('should include caffeinate when available', () => {
    const args = launchd.buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
    expect(args).toEqual([
      '/usr/bin/caffeinate', '-s',
      '/usr/local/bin/node', expect.stringContaining('cli.js'), 'start',
    ]);
  });

  it('should skip caffeinate when not available', () => {
    const args = launchd.buildProgramArguments('/usr/local/bin/node', null);
    expect(args).toEqual([
      '/usr/local/bin/node', expect.stringContaining('cli.js'), 'start',
    ]);
  });

  it('should always end with node <cli_entry> start', () => {
    const args = launchd.buildProgramArguments('/opt/homebrew/bin/node', '/usr/bin/caffeinate');
    const lastThree = args.slice(-3);
    expect(lastThree[0]).toBe('/opt/homebrew/bin/node');
    expect(lastThree[1]).toContain('cli.js');
    expect(lastThree[2]).toBe('start');
  });
});

describe('generatePlist', () => {
  let capturedPlist: string;

  beforeEach(() => {
    mockExecSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    capturedPlist = '';

    // Mock node and caffeinate detection
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node\n';
      if (cmd === 'which caffeinate') return '/usr/bin/caffeinate\n';
      return '';
    });

    // Capture plist content
    mockWriteFileSync.mockImplementation((_path: string, content: string) => {
      capturedPlist = content;
    });

    mockExistsSync.mockReturnValue(false);
  });

  it('should write plist to correct path', () => {
    launchd.generatePlist();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      `${TEST_HOME}/Library/LaunchAgents/com.disclaude.primary.plist`,
      expect.any(String),
      'utf-8',
    );
  });

  it('should generate valid XML header', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(capturedPlist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
  });

  it('should contain correct Label', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>Label</key>');
    expect(capturedPlist).toContain('<string>com.disclaude.primary</string>');
  });

  it('should contain ProgramArguments with caffeinate and node', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>ProgramArguments</key>');
    expect(capturedPlist).toContain('<string>/usr/bin/caffeinate</string>');
    expect(capturedPlist).toContain('<string>-s</string>');
    expect(capturedPlist).toContain('<string>/usr/local/bin/node</string>');
    expect(capturedPlist).toContain('<string>start</string>');
  });

  it('should skip caffeinate when not available', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node\n';
      if (cmd === 'which caffeinate') throw new Error('not found');
      return '';
    });

    launchd.generatePlist();
    expect(capturedPlist).not.toContain('<string>/usr/bin/caffeinate</string>');
    expect(capturedPlist).toContain('<string>/usr/local/bin/node</string>');
  });

  it('should contain RunAtLoad true', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>RunAtLoad</key>');
    expect(capturedPlist).toContain('<true/>');
  });

  it('should contain KeepAlive true', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>KeepAlive</key>');
    expect(capturedPlist).toContain('<true/>');
  });

  it('should contain StandardErrorPath', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>StandardErrorPath</key>');
    expect(capturedPlist).toContain(`${TEST_HOME}/Library/Logs/disclaude/launchd-stderr.log`);
  });

  it('should contain environment variables', () => {
    launchd.generatePlist();
    expect(capturedPlist).toContain('<key>EnvironmentVariables</key>');
    expect(capturedPlist).toContain('<key>PATH</key>');
    expect(capturedPlist).toContain('<key>HOME</key>');
    expect(capturedPlist).toContain(`<string>${TEST_HOME}</string>`);
    expect(capturedPlist).toContain('<key>NODE_ENV</key>');
    expect(capturedPlist).toContain('<string>production</string>');
    expect(capturedPlist).toContain('<key>LOG_TO_FILE</key>');
    expect(capturedPlist).toContain('<string>true</string>');
    expect(capturedPlist).toContain('<key>LOG_DIR</key>');
  });

  it('should not contain StandardOutPath (removed in Issue #2934)', () => {
    launchd.generatePlist();
    expect(capturedPlist).not.toContain('StandardOutPath');
  });

  it('should ensure LaunchAgents and log directories exist', () => {
    launchd.generatePlist();
    // mkdirSync called for both directories (both don't exist)
    expect(mockMkdirSync).toHaveBeenCalledTimes(2);
  });
});

describe('loadPlist', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExecSync.mockReset();
    process.exit = mockExit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  it('should load plist with launchctl', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    launchd.loadPlist();
    expect(mockExecSync).toHaveBeenCalledWith(
      `launchctl load ${TEST_HOME}/Library/LaunchAgents/com.disclaude.primary.plist`,
      expect.objectContaining({ encoding: 'utf-8', stdio: 'inherit' }),
    );
  });

  it('should exit with code 1 when plist does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    launchd.loadPlist();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('unloadPlist', () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExecSync.mockReset();
  });

  it('should unload plist with launchctl', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('');
    launchd.unloadPlist();
    expect(mockExecSync).toHaveBeenCalledWith(
      `launchctl unload ${TEST_HOME}/Library/LaunchAgents/com.disclaude.primary.plist`,
      expect.objectContaining({ allowFail: true, silent: true }),
    );
  });

  it('should do nothing when plist does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    launchd.unloadPlist();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('buildProject', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('should run npm run build', () => {
    mockExecSync.mockReturnValue('');
    launchd.buildProject();
    expect(mockExecSync).toHaveBeenCalledWith('npm run build', expect.objectContaining({}));
  });
});
