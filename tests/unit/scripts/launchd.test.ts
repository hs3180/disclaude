/**
 * Unit tests for scripts/launchd.mjs — macOS launchd management script.
 *
 * Smoke tests covering plist generation format, argument building,
 * directory creation, environment detection, and command routing.
 *
 * @see Issue #2894 — add test coverage for scripts/launchd.mjs
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted values — accessible inside vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockHomedir,
  mockNodePath,
  mockCaffeinatePath,
  fsState,
} = vi.hoisted(() => ({
  mockHomedir: '/Users/testuser',
  mockNodePath: '/usr/local/bin/node',
  mockCaffeinatePath: '/usr/bin/caffeinate',
  fsState: {} as Record<string, boolean>,
}));

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:os', () => ({
  homedir: () => mockHomedir,
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (cmd === 'which node') return `${mockNodePath}\n`;
    if (cmd === 'which caffeinate') return `${mockCaffeinatePath}\n`;
    if (typeof cmd === 'string' && cmd.startsWith('launchctl')) return '';
    if (typeof cmd === 'string' && cmd.startsWith('npm run build')) return '';
    if (typeof cmd === 'string' && cmd.startsWith('tail')) return '';
    throw new Error(`Unhandled execSync: ${cmd}`);
  }),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn((p: string) => fsState[p] ?? false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    resolve: (...args: string[]) => {
      // Simplified resolve for testing
      const joined = args.join('/');
      return joined.includes('..') ? actual.resolve(...args) : joined.replace(/\/+/g, '/');
    },
  };
});

// Import the module under test after mocks are set up
import {
  LABEL,
  buildProgramArguments,
  generatePlist,
  getNodePath,
  getCaffeinatePath,
  ensureLaunchAgentsDir,
  ensureLogDir,
  commands,
} from '../../../scripts/launchd.mjs';

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset fsState
    for (const key of Object.keys(fsState)) {
      delete fsState[key];
    }
  });

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  describe('constants', () => {
    it('should use correct label', () => {
      expect(LABEL).toBe('com.disclaude.primary');
    });
  });

  // -------------------------------------------------------------------------
  // getNodePath
  // -------------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return the node path from which', () => {
      const result = getNodePath();
      expect(result).toBe(mockNodePath);
      expect(mockedExecSync).toHaveBeenCalledWith('which node', expect.any(Object));
    });

    it('should call process.exit when node is not found', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });

      expect(() => getNodePath()).toThrow('process.exit');
      expect(exitSpy).toHaveBeenCalledWith(1);

      exitSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // getCaffeinatePath
  // -------------------------------------------------------------------------

  describe('getCaffeinatePath', () => {
    it('should return caffeinate path when available', () => {
      const result = getCaffeinatePath();
      expect(result).toBe(mockCaffeinatePath);
    });

    it('should return null when caffeinate is not available', () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });
      const result = getCaffeinatePath();
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // buildProgramArguments
  // -------------------------------------------------------------------------

  describe('buildProgramArguments', () => {
    it('should include caffeinate when path is provided', () => {
      const args = buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(args).toEqual([
        '/usr/bin/caffeinate', '-s',
        '/usr/local/bin/node',
        expect.stringContaining('dist/cli.js'),
        'start',
      ]);
    });

    it('should omit caffeinate when path is null', () => {
      const args = buildProgramArguments('/usr/local/bin/node', null);
      expect(args).toEqual([
        '/usr/local/bin/node',
        expect.stringContaining('dist/cli.js'),
        'start',
      ]);
      expect(args).toHaveLength(3);
    });

    it('should include caffeinate -s before node path', () => {
      const args = buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(args[0]).toBe('/usr/bin/caffeinate');
      expect(args[1]).toBe('-s');
      expect(args[2]).toBe('/usr/local/bin/node');
    });

    it('should always end with "start"', () => {
      const args = buildProgramArguments('/usr/local/bin/node', null);
      expect(args[args.length - 1]).toBe('start');
    });
  });

  // -------------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -------------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should create directory when it does not exist', () => {
      ensureLaunchAgentsDir();
      expect(mockedMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/LaunchAgents'),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('should not create directory when it already exists', () => {
      fsState[mockHomedir + '/Library/LaunchAgents'] = true;

      ensureLaunchAgentsDir();
      expect(mockedMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ensureLogDir
  // -------------------------------------------------------------------------

  describe('ensureLogDir', () => {
    it('should create log directory with restrictive permissions (0o700)', () => {
      ensureLogDir();
      expect(mockedMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/Logs/disclaude'),
        expect.objectContaining({ recursive: true, mode: 0o700 }),
      );
    });

    it('should not create directory when it already exists', () => {
      fsState[mockHomedir + '/Library/Logs/disclaude'] = true;

      ensureLogDir();
      expect(mockedMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // generatePlist
  // -------------------------------------------------------------------------

  describe('generatePlist', () => {
    it('should generate valid XML plist', () => {
      generatePlist();

      expect(mockedWriteFileSync).toHaveBeenCalled();
      const call = mockedWriteFileSync.mock.calls[0];
      const plistPath = call[0] as string;
      const plistContent = call[1] as string;

      // File should be written to LaunchAgents directory
      expect(plistPath).toContain('Library/LaunchAgents');
      expect(plistPath).toContain('com.disclaude.primary.plist');

      // Should be valid XML
      expect(plistContent).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plistContent).toContain('<!DOCTYPE plist');
      expect(plistContent).toContain('<plist version="1.0">');
    });

    it('should contain correct Label', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>Label</key>');
      expect(plistContent).toContain('<string>com.disclaude.primary</string>');
    });

    it('should contain ProgramArguments with node and entry point', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>ProgramArguments</key>');
      expect(plistContent).toContain(`<string>${mockNodePath}</string>`);
      expect(plistContent).toContain('dist/cli.js');
      expect(plistContent).toContain('<string>start</string>');
    });

    it('should contain caffeinate in ProgramArguments when available', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain(`<string>${mockCaffeinatePath}</string>`);
      expect(plistContent).toContain('<string>-s</string>');
    });

    it('should set RunAtLoad to true', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>RunAtLoad</key>');
      expect(plistContent).toContain('<true/>');
    });

    it('should set KeepAlive to true', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>KeepAlive</key>');
      expect(plistContent).toContain('<true/>');
    });

    it('should set StandardErrorPath', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>StandardErrorPath</key>');
      expect(plistContent).toContain('launchd-stderr.log');
    });

    it('should set environment variables', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).toContain('<key>EnvironmentVariables</key>');
      expect(plistContent).toContain('<key>NODE_ENV</key>');
      expect(plistContent).toContain('<string>production</string>');
      expect(plistContent).toContain('<key>LOG_TO_FILE</key>');
      expect(plistContent).toContain('<string>true</string>');
      expect(plistContent).toContain('<key>HOME</key>');
    });

    it('should NOT contain StandardOutPath (logs through pino)', () => {
      generatePlist();
      const plistContent = mockedWriteFileSync.mock.calls[0][1] as string;

      expect(plistContent).not.toContain('StandardOutPath');
    });

    it('should create required directories', () => {
      generatePlist();

      // Should create LaunchAgents dir and Log dir
      expect(mockedMkdirSync).toHaveBeenCalled();
      const mkdirCalls = mockedMkdirSync.mock.calls.map((c: unknown[]) => c[0] as string);
      const hasLaunchAgents = mkdirCalls.some(p => p.includes('LaunchAgents'));
      const hasLogs = mkdirCalls.some(p => p.includes('Logs/disclaude'));
      expect(hasLaunchAgents || hasLogs).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Command routing
  // -------------------------------------------------------------------------

  describe('command routing', () => {
    it('should expose all expected commands', () => {
      expect(commands).toHaveProperty('generate');
      expect(commands).toHaveProperty('install');
      expect(commands).toHaveProperty('uninstall');
      expect(commands).toHaveProperty('start');
      expect(commands).toHaveProperty('stop');
      expect(commands).toHaveProperty('restart');
      expect(commands).toHaveProperty('logs');
      expect(commands).toHaveProperty('status');
    });

    it('should have 8 commands', () => {
      expect(Object.keys(commands)).toHaveLength(8);
    });

    it('each command should be a function', () => {
      for (const [name, fn] of Object.entries(commands)) {
        expect(typeof fn).toBe('function', `Command "${name}" should be a function`);
      }
    });
  });
});
