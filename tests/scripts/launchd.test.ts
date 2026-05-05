/**
 * Smoke tests for scripts/launchd.mjs — plist generation & process management.
 *
 * Issue #2894: scripts/launchd.mjs had zero test coverage.
 * These tests verify plist generation output format and core helper functions.
 *
 * The module uses macOS-specific commands (launchctl, caffeinate) and paths
 * (~/Library/LaunchAgents), so we mock child_process and fs where needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock modules before importing the module under test
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

// Import after mocks are set up — vitest hoists vi.mock calls
const launchd = await import('../../scripts/launchd.mjs');

describe('scripts/launchd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: simulate node binary found
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd === 'which node') return '/usr/local/bin/node';
      if (cmd === 'which caffeinate') return '/usr/bin/caffeinate';
      return '';
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe('constants', () => {
    it('defines correct service label', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('plist path is under ~/Library/LaunchAgents', () => {
      expect(launchd.PLIST_PATH).toMatch(/Library\/LaunchAgents\/com\.disclaude\.primary\.plist$/);
    });

    it('log directory is under ~/Library/Logs/disclaude', () => {
      expect(launchd.LOG_DIR).toMatch(/Library\/Logs\/disclaude$/);
    });

    it('stderr log path ends with launchd-stderr.log', () => {
      expect(launchd.STDERR_LOG).toMatch(/launchd-stderr\.log$/);
    });

    it('cli entry points to primary-node dist', () => {
      expect(launchd.CLI_ENTRY).toContain('packages/primary-node/dist/cli.js');
    });
  });

  // ---------------------------------------------------------------------------
  // buildProgramArguments
  // ---------------------------------------------------------------------------

  describe('buildProgramArguments', () => {
    it('returns args with caffeinate when path provided', () => {
      const result = launchd.buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(result).toEqual([
        '/usr/bin/caffeinate', '-s',
        '/usr/local/bin/node',
        expect.stringContaining('cli.js'),
        'start',
      ]);
    });

    it('returns args without caffeinate when null', () => {
      const result = launchd.buildProgramArguments('/usr/local/bin/node', null);
      expect(result).toEqual([
        '/usr/local/bin/node',
        expect.stringContaining('cli.js'),
        'start',
      ]);
    });

    it('places caffeinate before node in the argument list', () => {
      const result = launchd.buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      const caffeinateIdx = result.indexOf('/usr/bin/caffeinate');
      const nodeIdx = result.indexOf('/usr/local/bin/node');
      expect(caffeinateIdx).toBeLessThan(nodeIdx);
    });

    it('includes caffeinate -s flag', () => {
      const result = launchd.buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(result).toContain('-s');
    });

    it('always ends with "start" command', () => {
      const result = launchd.buildProgramArguments('/usr/local/bin/node', '/usr/bin/caffeinate');
      expect(result[result.length - 1]).toBe('start');
    });
  });

  // ---------------------------------------------------------------------------
  // getCaffeinatePath
  // ---------------------------------------------------------------------------

  describe('getCaffeinatePath', () => {
    it('returns path when caffeinate is available', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which caffeinate') return '/usr/bin/caffeinate\n';
        return '';
      });
      expect(launchd.getCaffeinatePath()).toBe('/usr/bin/caffeinate');
    });

    it('returns null when caffeinate is not available', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which caffeinate') throw new Error('not found');
        return '';
      });
      expect(launchd.getCaffeinatePath()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getNodePath
  // ---------------------------------------------------------------------------

  describe('getNodePath', () => {
    it('returns node path when found', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        return '';
      });
      expect(launchd.getNodePath()).toBe('/usr/local/bin/node');
    });

    it('exits with code 1 when node is not found', () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which node') throw new Error('not found');
        return '';
      });
      expect(() => launchd.getNodePath()).toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(1);
      mockExit.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureLogDir
  // ---------------------------------------------------------------------------

  describe('ensureLogDir', () => {
    it('creates log directory with restrictive permissions when missing', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      launchd.ensureLogDir();
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Logs/disclaude'),
        { recursive: true, mode: 0o700 },
      );
    });

    it('skips creation when directory already exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      launchd.ensureLogDir();
      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // ---------------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('creates LaunchAgents directory when missing', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      launchd.ensureLaunchAgentsDir();
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('LaunchAgents'),
        { recursive: true },
      );
    });

    it('skips creation when directory already exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      launchd.ensureLaunchAgentsDir();
      expect(mkdirSync).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // generatePlist
  // ---------------------------------------------------------------------------

  describe('generatePlist', () => {
    it('writes plist file to disk', () => {
      launchd.generatePlist();
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('com.disclaude.primary.plist'),
        expect.any(String),
        'utf-8',
      );
    });

    it('generates valid XML plist header', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plistContent).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(plistContent).toContain('<plist version="1.0">');
    });

    it('includes correct service label', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>Label</key>');
      expect(plistContent).toContain('<string>com.disclaude.primary</string>');
    });

    it('includes ProgramArguments key', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>ProgramArguments</key>');
    });

    it('includes node path in ProgramArguments', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<string>/usr/local/bin/node</string>');
    });

    it('includes caffeinate in ProgramArguments when available', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node';
        if (cmd === 'which caffeinate') return '/usr/bin/caffeinate';
        return '';
      });
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<string>/usr/bin/caffeinate</string>');
      expect(plistContent).toContain('<string>-s</string>');
    });

    it('omits caffeinate when not available', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node';
        if (cmd === 'which caffeinate') throw new Error('not found');
        return '';
      });
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).not.toContain('caffeinate');
    });

    it('includes RunAtLoad set to true', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>RunAtLoad</key>');
      expect(plistContent).toContain('<true/>');
    });

    it('includes KeepAlive set to true', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>KeepAlive</key>');
    });

    it('includes StandardErrorPath', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>StandardErrorPath</key>');
      expect(plistContent).toContain('launchd-stderr.log');
    });

    it('includes WorkingDirectory pointing to project root', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>WorkingDirectory</key>');
    });

    it('includes EnvironmentVariables with PATH, HOME, NODE_ENV', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>EnvironmentVariables</key>');
      expect(plistContent).toContain('<key>PATH</key>');
      expect(plistContent).toContain('<key>HOME</key>');
      expect(plistContent).toContain('<key>NODE_ENV</key>');
    });

    it('sets NODE_ENV to production', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<string>production</string>');
    });

    it('sets LOG_TO_FILE to true', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>LOG_TO_FILE</key>');
      expect(plistContent).toContain('<string>true</string>');
    });

    it('includes LOG_DIR environment variable', () => {
      launchd.generatePlist();
      const plistContent = vi.mocked(writeFileSync).mock.calls[0][1] as string;
      expect(plistContent).toContain('<key>LOG_DIR</key>');
      expect(plistContent).toContain('Logs/disclaude');
    });

    it('calls ensureLaunchAgentsDir and ensureLogDir', () => {
      launchd.generatePlist();
      // existsSync is called for both LaunchAgents dir and Log dir
      expect(existsSync).toHaveBeenCalled();
      expect(mkdirSync).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // run helper
  // ---------------------------------------------------------------------------

  describe('run', () => {
    it('executes command and returns output', () => {
      vi.mocked(execSync).mockReturnValue('output\n');
      const result = launchd.run('echo hello', { silent: true });
      expect(result).toBe('output\n');
    });

    it('throws on failure when allowFail is false', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed');
      });
      expect(() => launchd.run('bad-command')).toThrow('Command failed');
    });

    it('returns null on failure when allowFail is true', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed');
      });
      const result = launchd.run('bad-command', { allowFail: true });
      expect(result).toBeNull();
    });
  });
});
