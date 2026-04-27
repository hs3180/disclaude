/**
 * Tests for scripts/launchd.mjs — macOS launchd management script.
 *
 * Covers plist generation format, command dispatch, error handling,
 * and helper functions with mocked filesystem and child_process.
 *
 * @see Issue #2894 — add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const mockExecSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();
const mockHomedir = vi.fn(() => '/Users/testuser');

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => mockHomedir(),
}));

// Import after mocks are in place
const launchd = await import('../../scripts/launchd.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the plist XML content from the most recent writeFileSync call. */
function getWrittenPlist(): string {
  const calls = mockWriteFileSync.mock.calls;
  const lastCall = calls[calls.length - 1];
  return lastCall ? (lastCall[1] as string) : '';
}

/** Check that a plist string contains a given key-value pair. */
function plistContains(plist: string, key: string, value: string): boolean {
  return plist.includes(`<key>${key}</key>`) && plist.includes(`<string>${value}</string>`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock: `which node` returns a fake path
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node\n';
      return '';
    });

    // Default: LaunchAgents dir and plist both "exist"
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe('constants', () => {
    it('should expose LABEL as com.disclaude.primary', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('should derive PLIST_PATH from homedir', () => {
      expect(launchd.PLIST_PATH).toContain('Library/LaunchAgents/com.disclaude.primary.plist');
    });

    it('should set STDOUT_LOG and STDERR_LOG under /tmp', () => {
      expect(launchd.STDOUT_LOG).toBe('/tmp/disclaude-stdout.log');
      expect(launchd.STDERR_LOG).toBe('/tmp/disclaude-stderr.log');
    });
  });

  // -------------------------------------------------------------------------
  // getNodePath
  // -------------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return the trimmed node path', () => {
      mockExecSync.mockReturnValue('  /usr/local/bin/node\n  ');
      const result = launchd.getNodePath();
      expect(result).toBe('/usr/local/bin/node');
      expect(mockExecSync).toHaveBeenCalledWith('which node', { encoding: 'utf-8' });
    });

    it('should call process.exit when node is not found', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      expect(() => launchd.getNodePath()).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // run helper
  // -------------------------------------------------------------------------

  describe('run', () => {
    it('should execute command and return output', () => {
      mockExecSync.mockReturnValue('output');
      const result = launchd.run('echo hello');
      expect(result).toBe('output');
    });

    it('should pass silent option as pipe stdio', () => {
      mockExecSync.mockReturnValue('');
      launchd.run('echo hello', { silent: true });
      expect(mockExecSync).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('should throw on failure when allowFail is not set', () => {
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

  // -------------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -------------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should create directory with recursive:true if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/LaunchAgents'),
        { recursive: true },
      );
    });
  });

  // -------------------------------------------------------------------------
  // generatePlist — the primary value test
  // -------------------------------------------------------------------------

  describe('generatePlist', () => {
    it('should generate a valid plist XML with correct structure', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      mockExistsSync.mockReturnValue(true);

      launchd.generatePlist();

      const plist = getWrittenPlist();

      // XML declaration
      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<!DOCTYPE plist');
      expect(plist).toContain('<plist version="1.0">');
      expect(plist).toContain('</plist>');

      // Label
      expect(plistContains(plist, 'Label', 'com.disclaude.primary')).toBe(true);

      // ProgramArguments
      expect(plist).toContain('<key>ProgramArguments</key>');
      expect(plist).toContain('<array>');
      expect(plist).toContain('<string>/usr/local/bin/node</string>');
      expect(plist).toContain('<string>start</string>');

      // WorkingDirectory
      expect(plist).toContain('<key>WorkingDirectory</key>');

      // RunAtLoad and KeepAlive
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<true/>');
      expect(plist).toContain('<key>KeepAlive</key>');

      // Log paths
      expect(plistContains(plist, 'StandardOutPath', '/tmp/disclaude-stdout.log')).toBe(true);
      expect(plistContains(plist, 'StandardErrorPath', '/tmp/disclaude-stderr.log')).toBe(true);

      // Environment variables
      expect(plist).toContain('<key>EnvironmentVariables</key>');
      expect(plistContains(plist, 'NODE_ENV', 'production')).toBe(true);
      expect(plist).toContain('<key>HOME</key>');
    });

    it('should write plist to the correct path', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      launchd.generatePlist();

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('com.disclaude.primary.plist'),
        expect.any(String),
        'utf-8',
      );
    });

    it('should ensure LaunchAgents directory exists before writing', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      mockExistsSync.mockReturnValue(false);

      launchd.generatePlist();

      expect(mockMkdirSync).toHaveBeenCalled();
    });

    it('should use custom node path from which node', () => {
      mockExecSync.mockReturnValue('/opt/homebrew/bin/node\n');
      launchd.generatePlist();

      const plist = getWrittenPlist();
      expect(plist).toContain('<string>/opt/homebrew/bin/node</string>');
    });

    it('should include the CLI entry point path', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      launchd.generatePlist();

      const plist = getWrittenPlist();
      expect(plist).toContain('packages/primary-node/dist/cli.js');
    });
  });

  // -------------------------------------------------------------------------
  // loadPlist
  // -------------------------------------------------------------------------

  describe('loadPlist', () => {
    it('should load the plist via launchctl when file exists', () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue('');

      launchd.loadPlist();

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      );
    });

    it('should exit with error when plist file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      expect(() => launchd.loadPlist()).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // unloadPlist
  // -------------------------------------------------------------------------

  describe('unloadPlist', () => {
    it('should unload the plist via launchctl when file exists', () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue('');

      launchd.unloadPlist();

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
    });

    it('should be a no-op when plist file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.unloadPlist();
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // build
  // -------------------------------------------------------------------------

  describe('build', () => {
    it('should run npm run build with cwd set to project root', () => {
      mockExecSync.mockReturnValue('');
      launchd.build();
      expect(mockExecSync).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      // Verify cwd resolves to the parent of the script's directory
      const call = mockExecSync.mock.calls[0] as [string, { cwd: string }];
      expect(call[1].cwd).toBe(launchd.PROJECT_ROOT);
    });
  });

  // -------------------------------------------------------------------------
  // Command functions
  // -------------------------------------------------------------------------

  describe('cmdGenerate', () => {
    it('should call generatePlist', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      launchd.cmdGenerate();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe('cmdInstall', () => {
    it('should generate plist and load it', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        return '';
      });
      mockExistsSync.mockReturnValue(true);

      launchd.cmdInstall();

      // Should have written plist and loaded it
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      );
    });
  });

  describe('cmdUninstall', () => {
    it('should unload and remove plist file', () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue('');

      launchd.cmdUninstall();

      expect(mockRmSync).toHaveBeenCalledWith(
        expect.stringContaining('com.disclaude.primary.plist'),
      );
    });

    it('should not remove plist if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      launchd.cmdUninstall();

      expect(mockRmSync).not.toHaveBeenCalled();
    });
  });

  describe('cmdStart', () => {
    it('should build, generate plist, and load', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        return '';
      });
      mockExistsSync.mockReturnValue(true);

      launchd.cmdStart();

      // build + which node + launchctl load
      expect(mockExecSync).toHaveBeenCalledWith('npm run build', expect.any(Object));
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      );
    });
  });

  describe('cmdStop', () => {
    it('should unload the service', () => {
      mockExistsSync.mockReturnValue(true);
      mockExecSync.mockReturnValue('');

      launchd.cmdStop();

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
    });
  });

  describe('cmdRestart', () => {
    it('should unload, build, generate, and load', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        return '';
      });
      mockExistsSync.mockReturnValue(true);

      launchd.cmdRestart();

      // unload + build + generate + load
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
      expect(mockExecSync).toHaveBeenCalledWith('npm run build', expect.any(Object));
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      );
    });
  });

  describe('cmdStatus', () => {
    it('should show loaded status when service is running', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('launchctl list')) return '12345  0  com.disclaude.primary\n';
        return '';
      });

      launchd.cmdStatus();

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('com.disclaude.primary'));
    });

    it('should show not-loaded status when service is not running', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('launchctl list')) return null;
        return '';
      });

      launchd.cmdStatus();

      expect(console.log).toHaveBeenCalledWith('Service is NOT loaded.');
    });
  });
});
