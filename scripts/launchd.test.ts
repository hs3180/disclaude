/**
 * Unit tests for scripts/launchd.mjs — macOS launchd management.
 *
 * Tests plist generation, command building, and helper functions
 * using mocked child_process and fs modules.
 *
 * @see scripts/launchd.mjs
 * @see Issue #2894
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockWriteFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();
vi.mock('node:fs', () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  rmSync: (...args: unknown[]) => mockRmSync(...args),
}));

// Import after mock setup
const launchd = await import('./launchd.mjs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockWriteFileSync.mockReset();
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockRmSync.mockReset();
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('should define LABEL as com.disclaude.primary', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('should define PLIST_FILENAME based on LABEL', () => {
      expect(launchd.PLIST_FILENAME).toBe(`${launchd.LABEL}.plist`);
    });

    it('should define paths under home directory', () => {
      expect(launchd.PLIST_PATH).toContain('Library/LaunchAgents');
      expect(launchd.PLIST_PATH).toContain(launchd.PLIST_FILENAME);
      expect(launchd.LOG_DIR).toContain('Library/Logs/disclaude');
    });

    it('should define CLI_ENTRY pointing to dist/cli.js', () => {
      expect(launchd.CLI_ENTRY).toContain('dist/cli.js');
    });
  });

  // -----------------------------------------------------------------------
  // getNodePath
  // -----------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return trimmed node path on success', () => {
      mockExecSync.mockReturnValue('/usr/local/bin/node\n');

      const result = launchd.getNodePath();

      expect(result).toBe('/usr/local/bin/node');
      expect(mockExecSync).toHaveBeenCalledWith('which node', { encoding: 'utf-8' });
    });

    it('should call process.exit(1) when node is not found', () => {
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      expect(() => launchd.getNodePath()).toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(1);

      mockExit.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // getCaffeinatePath
  // -----------------------------------------------------------------------

  describe('getCaffeinatePath', () => {
    it('should return trimmed path when caffeinate is available', () => {
      mockExecSync.mockReturnValue('/usr/bin/caffeinate\n');

      const result = launchd.getCaffeinatePath();

      expect(result).toBe('/usr/bin/caffeinate');
      expect(mockExecSync).toHaveBeenCalledWith('which caffeinate', { encoding: 'utf-8' });
    });

    it('should return null when caffeinate is not available', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = launchd.getCaffeinatePath();

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // buildProgramArguments
  // -----------------------------------------------------------------------

  describe('buildProgramArguments', () => {
    it('should build args with caffeinate when available', () => {
      const result = launchd.buildProgramArguments(
        '/usr/local/bin/node',
        '/usr/bin/caffeinate',
      );

      expect(result).toEqual([
        '/usr/bin/caffeinate',
        '-s',
        '/usr/local/bin/node',
        launchd.CLI_ENTRY,
        'start',
      ]);
    });

    it('should build args without caffeinate when not available', () => {
      const result = launchd.buildProgramArguments(
        '/usr/local/bin/node',
        null,
      );

      expect(result).toEqual([
        '/usr/local/bin/node',
        launchd.CLI_ENTRY,
        'start',
      ]);
    });

    it('should always end with node + entry + start', () => {
      const result = launchd.buildProgramArguments('/opt/node/bin/node', null);

      const len = result.length;
      expect(result[len - 3]).toBe('/opt/node/bin/node');
      expect(result[len - 2]).toBe(launchd.CLI_ENTRY);
      expect(result[len - 1]).toBe('start');
    });
  });

  // -----------------------------------------------------------------------
  // ensureLogDir
  // -----------------------------------------------------------------------

  describe('ensureLogDir', () => {
    it('should create log directory with restrictive permissions when not exists', () => {
      mockExistsSync.mockReturnValue(false);

      launchd.ensureLogDir();

      expect(mockMkdirSync).toHaveBeenCalledWith(launchd.LOG_DIR, {
        recursive: true,
        mode: 0o700,
      });
    });

    it('should not create directory when it already exists', () => {
      mockExistsSync.mockReturnValue(true);

      launchd.ensureLogDir();

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -----------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should create LaunchAgents directory when not exists', () => {
      mockExistsSync.mockReturnValue(false);

      launchd.ensureLaunchAgentsDir();

      expect(mockMkdirSync).toHaveBeenCalledWith(launchd.LAUNCHAGENTS_DIR, {
        recursive: true,
      });
    });

    it('should not create directory when it already exists', () => {
      mockExistsSync.mockReturnValue(true);

      launchd.ensureLaunchAgentsDir();

      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // generatePlist
  // -----------------------------------------------------------------------

  describe('generatePlist', () => {
    beforeEach(() => {
      // Default mocks for generatePlist
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') return '/usr/bin/caffeinate\n';
        return '';
      });
      mockExistsSync.mockReturnValue(true);
    });

    it('should write a valid XML plist file', () => {
      launchd.generatePlist();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [plistPath, plistContent] = mockWriteFileSync.mock.calls[0];
      expect(plistPath).toBe(launchd.PLIST_PATH);

      // Verify XML structure
      expect(plistContent).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(plistContent).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(plistContent).toContain('<plist version="1.0">');
    });

    it('should include the correct Label', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain(`<key>Label</key>`);
      expect(plistContent).toContain(`<string>${launchd.LABEL}</string>`);
    });

    it('should include ProgramArguments with caffeinate when available', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>ProgramArguments</key>');
      expect(plistContent).toContain('<string>/usr/bin/caffeinate</string>');
      expect(plistContent).toContain('<string>-s</string>');
      expect(plistContent).toContain('<string>/usr/local/bin/node</string>');
      expect(plistContent).toContain(`<string>${launchd.CLI_ENTRY}</string>`);
      expect(plistContent).toContain('<string>start</string>');
    });

    it('should include ProgramArguments without caffeinate when not available', () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') throw new Error('not found');
        return '';
      });

      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).not.toContain('<string>/usr/bin/caffeinate</string>');
      expect(plistContent).toContain('<string>/usr/local/bin/node</string>');
    });

    it('should include WorkingDirectory pointing to project root', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>WorkingDirectory</key>');
      expect(plistContent).toContain(`<string>${launchd.PROJECT_ROOT}</string>`);
    });

    it('should enable RunAtLoad and KeepAlive', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>RunAtLoad</key>');
      expect(plistContent).toContain('<true/>');
      expect(plistContent).toContain('<key>KeepAlive</key>');
    });

    it('should include StandardErrorPath', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>StandardErrorPath</key>');
      expect(plistContent).toContain(`<string>${launchd.STDERR_LOG}</string>`);
    });

    it('should include required EnvironmentVariables', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];
      expect(plistContent).toContain('<key>EnvironmentVariables</key>');
      expect(plistContent).toContain('<key>PATH</key>');
      expect(plistContent).toContain('<key>HOME</key>');
      expect(plistContent).toContain('<key>NODE_ENV</key>');
      expect(plistContent).toContain('<string>production</string>');
      expect(plistContent).toContain('<key>LOG_TO_FILE</key>');
      expect(plistContent).toContain('<string>true</string>');
      expect(plistContent).toContain('<key>LOG_DIR</key>');
    });

    it('should ensure directories are created before writing', () => {
      mockExistsSync.mockReturnValue(false);

      launchd.generatePlist();

      // Both LaunchAgents and Log directories should be ensured
      expect(mockMkdirSync).toHaveBeenCalled();
      // writeFileSync should still be called after directory creation
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
    });

    it('should produce well-formed plist XML that can be parsed', () => {
      launchd.generatePlist();

      const plistContent = mockWriteFileSync.mock.calls[0][1];

      // Extract the plist content and verify it has matching tags
      const openTags = (plistContent.match(/<dict>/g) || []).length;
      const closeTags = (plistContent.match(/<\/dict>/g) || []).length;
      expect(openTags).toBe(closeTags);

      const openArrays = (plistContent.match(/<array>/g) || []).length;
      const closeArrays = (plistContent.match(/<\/array>/g) || []).length;
      expect(openArrays).toBe(closeArrays);
    });
  });

  // -----------------------------------------------------------------------
  // run helper
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('should execute command and return output', () => {
      mockExecSync.mockReturnValue('output');

      const result = launchd.run('echo hello');

      expect(result).toBe('output');
      expect(mockExecSync).toHaveBeenCalledWith('echo hello', expect.objectContaining({
        encoding: 'utf-8',
      }));
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
});
