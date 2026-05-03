/**
 * Tests for scripts/launchd.mjs — macOS launchd management script.
 *
 * Focuses on plist generation output format, command-argument building,
 * and helper function correctness. External dependencies (child_process,
 * fs, os) are mocked so tests run on any OS.
 *
 * @see Issue #2894 — add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.mock factories are hoisted; all values must be inlined.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/test/home'),
}));

// Import mocked modules so we can reference the mock functions in tests
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

const mockExecSync = execSync as Mock;
const mockWriteFileSync = writeFileSync as Mock;
const mockExistsSync = existsSync as Mock;
const mockMkdirSync = mkdirSync as Mock;
const mockRmSync = rmSync as Mock;
const mockHomedir = homedir as Mock;

// Prevent process.exit from terminating the test runner
// NOTE: Don't use vi.restoreAllMocks() on this — it must persist for all tests
vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
  throw new Error(`process.exit(${code})`);
});

// Suppress console output during tests
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// ---------------------------------------------------------------------------
// Import SUT (after mocks are in place)
// ---------------------------------------------------------------------------

import {
  getNodePath,
  ensureLaunchAgentsDir,
  ensureLogDir,
  getCaffeinatePath,
  buildProgramArguments,
  generatePlist,
  loadPlist,
  unloadPlist,
  cmdUninstall,
  main,
  LABEL,
  PLIST_PATH,
  LOG_DIR,
  STDERR_LOG,
  APP_LOG,
  CLI_ENTRY,
} from '../../scripts/launchd.mjs';

// ---------------------------------------------------------------------------
// Helper: parse plist XML content written by writeFileSync
// ---------------------------------------------------------------------------

function getWrittenPlist(): string {
  const calls = mockWriteFileSync.mock.calls;
  const call = calls.find((c: unknown[]) => c[0] === PLIST_PATH);
  return call ? (call[1] as string) : '';
}

function extractPlistValue(plist: string, key: string): string | null {
  const regex = new RegExp(`<key>${key}</key>\\s*<string>(.*?)</string>`, 's');
  const match = plist.match(regex);
  return match ? match[1] : null;
}

function extractPlistArray(plist: string, key: string): string[] {
  const regex = new RegExp(
    `<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`,
  );
  const match = plist.match(regex);
  if (!match) return [];
  const items = [...match[1].matchAll(/<string>(.*?)<\/string>/g)];
  return items.map((m) => m[1]);
}

function extractPlistBoolean(plist: string, key: string): boolean {
  const regex = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
  const match = plist.match(regex);
  return match ? match[1] === 'true' : false;
}

function extractPlistEnvVar(plist: string, varName: string): string | null {
  const regex = new RegExp(
    `<key>${varName}</key>\\s*<string>(.*?)</string>`,
    's',
  );
  const match = plist.match(regex);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/test/home');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('/usr/local/bin/node');
  });

  afterEach(() => {
    // Use clearAllMocks (not restoreAllMocks) to preserve process.exit mock
    vi.clearAllMocks();
    // Restore default mock returns
    mockHomedir.mockReturnValue('/test/home');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('/usr/local/bin/node');
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('should use correct service label', () => {
      expect(LABEL).toBe('com.disclaude.primary');
    });

    it('should resolve paths under home directory', () => {
      expect(PLIST_PATH).toMatch(/\/test\/home\//);
      expect(LOG_DIR).toMatch(/\/test\/home\/Library\/Logs\/disclaude/);
      expect(STDERR_LOG).toMatch(/launchd-stderr\.log$/);
      expect(APP_LOG).toMatch(/disclaude-combined\.log$/);
    });

    it('should point CLI entry to dist directory', () => {
      expect(CLI_ENTRY).toMatch(/packages\/primary-node\/dist\/cli\.js$/);
    });
  });

  // -----------------------------------------------------------------------
  // getNodePath
  // -----------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return trimmed node path', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');
      expect(getNodePath()).toBe('/usr/local/bin/node');
    });

    it('should exit when node is not found', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => getNodePath()).toThrow('process.exit');
    });
  });

  // -----------------------------------------------------------------------
  // getCaffeinatePath
  // -----------------------------------------------------------------------

  describe('getCaffeinatePath', () => {
    it('should return caffeinate path when available', () => {
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');
      expect(getCaffeinatePath()).toBe('/usr/bin/caffeinate');
    });

    it('should return null when caffeinate is not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(getCaffeinatePath()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // buildProgramArguments
  // -----------------------------------------------------------------------

  describe('buildProgramArguments', () => {
    it('should include caffeinate -s when caffeinate is available', () => {
      const args = buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(args[0]).toBe('/usr/bin/caffeinate');
      expect(args[1]).toBe('-s');
      expect(args[2]).toBe('/usr/local/bin/node');
      expect(args[3]).toMatch(/cli\.js$/);
      expect(args[4]).toBe('start');
    });

    it('should skip caffeinate when not available', () => {
      const args = buildProgramArguments('/usr/local/bin/node', null);
      expect(args).toHaveLength(3);
      expect(args[0]).toBe('/usr/local/bin/node');
      expect(args[1]).toMatch(/cli\.js$/);
      expect(args[2]).toBe('start');
      expect(args).not.toContain('/usr/bin/caffeinate');
      expect(args).not.toContain('-s');
    });
  });

  // -----------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -----------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should create LaunchAgents dir when it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      ensureLaunchAgentsDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/LaunchAgents'),
        { recursive: true },
      );
    });

    it('should not create dir when it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      ensureLaunchAgentsDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // ensureLogDir
  // -----------------------------------------------------------------------

  describe('ensureLogDir', () => {
    it('should create log dir with restrictive permissions (0o700)', () => {
      mockExistsSync.mockReturnValue(false);
      ensureLogDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Logs/disclaude'),
        { recursive: true, mode: 0o700 },
      );
    });

    it('should not create dir when it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      ensureLogDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // generatePlist — the key smoke test for plist XML format
  // -----------------------------------------------------------------------

  describe('generatePlist', () => {
    beforeEach(() => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') return '/usr/bin/caffeinate\n';
        return '';
      });
    });

    it('should write a valid XML plist file', () => {
      generatePlist();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const plist = getWrittenPlist();
      expect(plist).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(plist).toContain('<plist version="1.0">');
    });

    it('should set correct Label', () => {
      generatePlist();
      const plist = getWrittenPlist();
      expect(extractPlistValue(plist, 'Label')).toBe('com.disclaude.primary');
    });

    it('should set correct ProgramArguments with caffeinate', () => {
      generatePlist();
      const plist = getWrittenPlist();
      const args = extractPlistArray(plist, 'ProgramArguments');
      expect(args).toContain('/usr/bin/caffeinate');
      expect(args).toContain('-s');
      expect(args).toContain('/usr/local/bin/node');
      expect(args).toContain('start');
    });

    it('should set ProgramArguments without caffeinate when unavailable', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') throw new Error('not found');
        return '';
      });

      generatePlist();
      const plist = getWrittenPlist();
      const args = extractPlistArray(plist, 'ProgramArguments');
      expect(args).not.toContain('/usr/bin/caffeinate');
      expect(args).not.toContain('-s');
      expect(args[0]).toBe('/usr/local/bin/node');
      expect(args[1]).toMatch(/cli\.js$/);
      expect(args[2]).toBe('start');
    });

    it('should set RunAtLoad to true', () => {
      generatePlist();
      const plist = getWrittenPlist();
      expect(extractPlistBoolean(plist, 'RunAtLoad')).toBe(true);
    });

    it('should set KeepAlive to true', () => {
      generatePlist();
      const plist = getWrittenPlist();
      expect(extractPlistBoolean(plist, 'KeepAlive')).toBe(true);
    });

    it('should set StandardErrorPath to launchd-stderr.log', () => {
      generatePlist();
      const plist = getWrittenPlist();
      const stderrPath = extractPlistValue(plist, 'StandardErrorPath');
      expect(stderrPath).toContain('Library/Logs/disclaude/launchd-stderr.log');
    });

    it('should set correct environment variables', () => {
      const origPath = process.env.PATH;
      process.env.PATH = '/test/path';
      try {
        generatePlist();
        const plist = getWrittenPlist();
        expect(extractPlistEnvVar(plist, 'NODE_ENV')).toBe('production');
        expect(extractPlistEnvVar(plist, 'LOG_TO_FILE')).toBe('true');
        expect(extractPlistEnvVar(plist, 'PATH')).toBe('/test/path');
        expect(extractPlistEnvVar(plist, 'HOME')).toBe('/test/home');
        expect(extractPlistEnvVar(plist, 'LOG_DIR')).toContain('Logs/disclaude');
      } finally {
        process.env.PATH = origPath;
      }
    });

    it('should write plist to PLIST_PATH', () => {
      generatePlist();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        PLIST_PATH,
        expect.any(String),
        'utf-8',
      );
    });

    it('should ensure LaunchAgents and log directories exist', () => {
      // Directories don't exist → generatePlist should create them
      mockExistsSync.mockReturnValue(false);
      generatePlist();
      expect(mockMkdirSync).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // loadPlist
  // -----------------------------------------------------------------------

  describe('loadPlist', () => {
    it('should run launchctl load when plist exists', () => {
      mockExistsSync.mockReturnValue(true);
      loadPlist();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.any(Object),
      );
    });

    it('should exit if plist does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => loadPlist()).toThrow('process.exit');
    });
  });

  // -----------------------------------------------------------------------
  // unloadPlist
  // -----------------------------------------------------------------------

  describe('unloadPlist', () => {
    it('should run launchctl unload when plist exists', () => {
      mockExistsSync.mockReturnValue(true);
      unloadPlist();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
    });

    it('should do nothing when plist does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      unloadPlist();
      // No launchctl command should be issued (only allowFail calls from other functions)
      const launchctlCalls = mockExecSync.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('launchctl'),
      );
      expect(launchctlCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // cmdUninstall
  // -----------------------------------------------------------------------

  describe('cmdUninstall', () => {
    it('should unload and remove plist file', () => {
      mockExistsSync.mockReturnValue(true);
      cmdUninstall();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.any(Object),
      );
      expect(mockRmSync).toHaveBeenCalledWith(PLIST_PATH);
    });

    it('should not remove plist if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      cmdUninstall();
      expect(mockRmSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // main (CLI entry point)
  // -----------------------------------------------------------------------

  describe('main', () => {
    it('should exit with usage when no command provided', () => {
      expect(() => main(['node', 'launchd.mjs'])).toThrow('process.exit(1)');
    });

    it('should exit with usage for unknown command', () => {
      expect(() => main(['node', 'launchd.mjs', 'unknown'])).toThrow(
        'process.exit(1)',
      );
    });

    it('should call cmdGenerate for "generate" command', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') throw new Error('not found');
        return '';
      });
      // Should not throw — generate only writes file
      main(['node', 'launchd.mjs', 'generate']);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });
});
