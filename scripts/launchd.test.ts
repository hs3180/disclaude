/**
 * Tests for scripts/launchd.mjs — macOS launchd management.
 *
 * Issue #2894: smoke tests to verify plist generation output format
 * and unit tests for core functions.
 *
 * @module scripts/launchd.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before vi.mock calls)
// ---------------------------------------------------------------------------

const mockHomedir = vi.hoisted(() => vi.fn(() => '/home/testuser'));
const mockExecSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockRmSync = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock('node:os', () => ({
  homedir: mockHomedir,
}));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  rmSync: mockRmSync,
}));

// ---------------------------------------------------------------------------
// Import SUT (after mocks are in place)
// ---------------------------------------------------------------------------

const launchd = await import('./launchd.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip XML preamble and parse key/string pairs from a plist <dict>. */
function parsePlistDict(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match <key>...</key> followed by <string>...</string>
  const re = /<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** Extract all <string> elements inside <array>...</array>. */
function parsePlistArray(xml: string): string[] {
  const arrayMatch = xml.match(/<array>([\s\S]*?)<\/array>/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  const re = /<string>([^<]*)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arrayMatch[1])) !== null) {
    items.push(m[1]);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scripts/launchd.mjs', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHomedir.mockReturnValue('/home/testuser');
    mockExecSync.mockReturnValue('/usr/local/bin/node\n');
    mockExistsSync.mockReturnValue(false);
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    mockExit.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('should have correct label', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('should have correct plist filename', () => {
      expect(launchd.PLIST_FILENAME).toBe('com.disclaude.primary.plist');
    });

    it('should resolve plist path under ~/Library/LaunchAgents', () => {
      expect(launchd.PLIST_PATH).toContain('Library/LaunchAgents');
      expect(launchd.PLIST_PATH).toContain('com.disclaude.primary.plist');
    });

    it('should resolve log directory under ~/Library/Logs/disclaude', () => {
      expect(launchd.LOG_DIR).toContain('Library/Logs/disclaude');
    });

    it('should have stderr and app log paths under log directory', () => {
      expect(launchd.STDERR_LOG).toContain('launchd-stderr.log');
      expect(launchd.APP_LOG).toContain('disclaude-combined.log');
    });

    it('should resolve CLI entry to primary-node dist', () => {
      expect(launchd.CLI_ENTRY).toContain('packages/primary-node/dist/cli.js');
    });
  });

  // -----------------------------------------------------------------------
  // getNodePath
  // -----------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return trimmed node path when found', () => {
      mockExecSync.mockReturnValue('  /usr/local/bin/node\n  ');
      expect(launchd.getNodePath()).toBe('/usr/local/bin/node');
    });

    it('should call process.exit when node is not found', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });
      expect(() => launchd.getNodePath()).toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: node not found in PATH');
    });
  });

  // -----------------------------------------------------------------------
  // getCaffeinatePath
  // -----------------------------------------------------------------------

  describe('getCaffeinatePath', () => {
    it('should return trimmed path when caffeinate is available', () => {
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

  // -----------------------------------------------------------------------
  // buildProgramArguments
  // -----------------------------------------------------------------------

  describe('buildProgramArguments', () => {
    it('should build args without caffeinate', () => {
      const args = launchd.buildProgramArguments('/usr/local/bin/node', null);
      expect(args).toEqual([
        '/usr/local/bin/node',
        expect.stringContaining('cli.js'),
        'start',
      ]);
      expect(args).toHaveLength(3);
    });

    it('should build args with caffeinate', () => {
      const args = launchd.buildProgramArguments(
        '/usr/local/bin/node',
        '/usr/bin/caffeinate',
      );
      expect(args).toEqual([
        '/usr/bin/caffeinate',
        '-s',
        '/usr/local/bin/node',
        expect.stringContaining('cli.js'),
        'start',
      ]);
      expect(args).toHaveLength(5);
    });

    it('should always end with "start" command', () => {
      const withCaffeinate = launchd.buildProgramArguments('/usr/bin/node', '/usr/bin/caffeinate');
      const withoutCaffeinate = launchd.buildProgramArguments('/usr/bin/node', null);
      expect(withCaffeinate[withCaffeinate.length - 1]).toBe('start');
      expect(withoutCaffeinate[withoutCaffeinate.length - 1]).toBe('start');
    });
  });

  // -----------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -----------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should create directory when it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/LaunchAgents'),
        { recursive: true },
      );
    });

    it('should not create directory when it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // ensureLogDir
  // -----------------------------------------------------------------------

  describe('ensureLogDir', () => {
    it('should create log directory with restrictive permissions when it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.ensureLogDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('Library/Logs/disclaude'),
        { recursive: true, mode: 0o700 },
      );
    });

    it('should not create directory when it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.ensureLogDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // generatePlist — the core function the issue asks to test
  // -----------------------------------------------------------------------

  describe('generatePlist', () => {
    function setupMocks(opts: { caffeinate?: boolean } = {}) {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === 'which node') return '/usr/local/bin/node\n';
        if (cmd === 'which caffeinate') {
          if (opts.caffeinate === false) throw new Error('not found');
          return '/usr/bin/caffeinate\n';
        }
        return '';
      });
      mockExistsSync.mockReturnValue(false);
    }

    it('should write plist file to correct path', () => {
      setupMocks();
      launchd.generatePlist();
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [path] = mockWriteFileSync.mock.calls[0];
      expect(path).toContain('com.disclaude.primary.plist');
      expect(path).toContain('Library/LaunchAgents');
    });

    it('should produce valid XML plist with correct DOCTYPE', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(content).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(content).toContain('<plist version="1.0">');
    });

    it('should include correct Label', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const dict = parsePlistDict(content);
      expect(dict.get('Label')).toBe('com.disclaude.primary');
    });

    it('should include ProgramArguments with caffeinate when available', () => {
      setupMocks({ caffeinate: true });
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const args = parsePlistArray(content);
      expect(args).toContain('/usr/bin/caffeinate');
      expect(args).toContain('-s');
      expect(args).toContain('/usr/local/bin/node');
      expect(args).toContain('start');
    });

    it('should include ProgramArguments without caffeinate when not available', () => {
      setupMocks({ caffeinate: false });
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const args = parsePlistArray(content);
      expect(args).not.toContain('/usr/bin/caffeinate');
      expect(args).toContain('/usr/local/bin/node');
      expect(args).toContain('start');
      expect(args).toHaveLength(3);
    });

    it('should include RunAtLoad set to true', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('<key>RunAtLoad</key>');
      expect(content).toContain('<true/>');
    });

    it('should include KeepAlive set to true', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('<key>KeepAlive</key>');
      expect(content).toContain('<true/>');
    });

    it('should include StandardErrorPath pointing to stderr log', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const dict = parsePlistDict(content);
      expect(dict.get('StandardErrorPath')).toContain('launchd-stderr.log');
    });

    it('should include WorkingDirectory pointing to project root', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      const dict = parsePlistDict(content);
      expect(dict.get('WorkingDirectory')).toBeTruthy();
    });

    it('should include correct EnvironmentVariables', () => {
      setupMocks();
      launchd.generatePlist();
      const [, content] = mockWriteFileSync.mock.calls[0];
      expect(content).toContain('<key>EnvironmentVariables</key>');
      expect(content).toContain('<key>HOME</key>');
      expect(content).toContain('/home/testuser');
      expect(content).toContain('<key>NODE_ENV</key>');
      expect(content).toContain('production');
      expect(content).toContain('<key>LOG_TO_FILE</key>');
      expect(content).toContain('<key>LOG_DIR</key>');
    });

    it('should ensure LaunchAgents and log directories exist', () => {
      setupMocks();
      launchd.generatePlist();
      // Both directories should be checked
      expect(mockExistsSync).toHaveBeenCalled();
      expect(mockMkdirSync).toHaveBeenCalled();
    });

    it('should print generation info to console', () => {
      setupMocks({ caffeinate: true });
      launchd.generatePlist();
      const logOutput = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(logOutput).toContain('Plist generated');
      expect(logOutput).toContain('Node: /usr/local/bin/node');
      expect(logOutput).toContain('Caffeinate: enabled');
    });

    it('should report caffeinate not available when absent', () => {
      setupMocks({ caffeinate: false });
      launchd.generatePlist();
      const logOutput = consoleLogSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(logOutput).toContain('not available');
    });
  });

  // -----------------------------------------------------------------------
  // loadPlist
  // -----------------------------------------------------------------------

  describe('loadPlist', () => {
    it('should call launchctl load when plist exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.loadPlist();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl load'),
        expect.anything(),
      );
    });

    it('should exit with error when plist does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => launchd.loadPlist()).toThrow('process.exit');
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  // -----------------------------------------------------------------------
  // unloadPlist
  // -----------------------------------------------------------------------

  describe('unloadPlist', () => {
    it('should call launchctl unload when plist exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.unloadPlist();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('launchctl unload'),
        expect.anything(),
      );
    });

    it('should do nothing when plist does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.unloadPlist();
      // execSync should NOT be called (no launchctl command)
      // (it may be called for other reasons, but not with 'launchctl unload')
      const unloadCalls = mockExecSync.mock.calls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('launchctl unload'),
      );
      expect(unloadCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // build
  // -----------------------------------------------------------------------

  describe('build', () => {
    it('should run npm run build', () => {
      mockExecSync.mockReturnValue('');
      launchd.build();
      expect(mockExecSync).toHaveBeenCalledWith(
        'npm run build',
        expect.objectContaining({ cwd: expect.any(String) }),
      );
    });
  });
});
