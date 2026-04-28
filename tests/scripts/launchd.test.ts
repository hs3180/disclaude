/**
 * Tests for scripts/launchd.mjs
 *
 * Smoke tests to verify plist generation output format and core functions.
 *
 * @see Issue #2894 — scripts/launchd.mjs had 262 lines and zero test coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock setup — vi.hoisted ensures variables are available in hoisted vi.mock
// ---------------------------------------------------------------------------

const { mockExecSync, mockWriteFileSync, mockExistsSync, mockMkdirSync, mockHomedir } =
  vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockHomedir: vi.fn(() => '/home/testuser'),
  }));

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

vi.mock('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  rmSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: mockHomedir,
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

const launchd = await import('../../scripts/launchd.mjs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('launchd.mjs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset console spies
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock setup
    mockExecSync.mockReturnValue('/usr/local/bin/node\n');
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------

  describe('constants', () => {
    it('should export LABEL as com.disclaude.primary', () => {
      expect(launchd.LABEL).toBe('com.disclaude.primary');
    });

    it('should derive PLIST_FILENAME from LABEL', () => {
      expect(launchd.PLIST_FILENAME).toBe('com.disclaude.primary.plist');
    });

    it('should set STDOUT_LOG to /tmp/disclaude-stdout.log', () => {
      expect(launchd.STDOUT_LOG).toBe('/tmp/disclaude-stdout.log');
    });

    it('should set STDERR_LOG to /tmp/disclaude-stderr.log', () => {
      expect(launchd.STDERR_LOG).toBe('/tmp/disclaude-stderr.log');
    });

    it('should derive PLIST_PATH from homedir', () => {
      // homedir is mocked to /home/testuser
      expect(launchd.PLIST_PATH).toBe(
        '/home/testuser/Library/LaunchAgents/com.disclaude.primary.plist',
      );
    });

    it('should derive CLI_ENTRY relative to PROJECT_ROOT', () => {
      expect(launchd.CLI_ENTRY).toMatch(/packages\/primary-node\/dist\/cli\.js$/);
    });
  });

  // -----------------------------------------------------------------------
  // getNodePath
  // -----------------------------------------------------------------------

  describe('getNodePath', () => {
    it('should return trimmed node path', () => {
      mockExecSync.mockReturnValue('  /usr/bin/node\n  ');
      expect(launchd.getNodePath()).toBe('/usr/bin/node');
      expect(mockExecSync).toHaveBeenCalledWith('which node', { encoding: 'utf-8' });
    });

    it('should call process.exit(1) when node is not found', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      expect(() => launchd.getNodePath()).toThrow('process.exit');
      expect(console.error).toHaveBeenCalledWith('Error: node not found in PATH');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // -----------------------------------------------------------------------
  // run
  // -----------------------------------------------------------------------

  describe('run', () => {
    it('should execute command and return output', () => {
      mockExecSync.mockReturnValue('output');
      const result = launchd.run('echo hello', { silent: true });
      expect(result).toBe('output');
    });

    it('should throw on failure by default', () => {
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

  // -----------------------------------------------------------------------
  // ensureLaunchAgentsDir
  // -----------------------------------------------------------------------

  describe('ensureLaunchAgentsDir', () => {
    it('should not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('should create directory with recursive flag if it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.ensureLaunchAgentsDir();
      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/home/testuser/Library/LaunchAgents',
        { recursive: true },
      );
    });
  });

  // -----------------------------------------------------------------------
  // generatePlist — the core function (Issue #2894 primary target)
  // -----------------------------------------------------------------------

  describe('generatePlist', () => {
    it('should write a valid XML plist file', () => {
      launchd.generatePlist();

      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const [filePath, content, encoding] = mockWriteFileSync.mock.calls[0];
      expect(filePath).toBe(launchd.PLIST_PATH);
      expect(encoding).toBe('utf-8');

      // Verify XML structure
      expect(content).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      expect(content).toContain('<!DOCTYPE plist');
      expect(content).toContain('<plist version="1.0">');
      expect(content).toContain('</plist>');
    });

    it('should contain the correct Label', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>Label</key>');
      expect(content).toContain('<string>com.disclaude.primary</string>');
    });

    it('should contain ProgramArguments with node, CLI entry, and start command', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>ProgramArguments</key>');
      expect(content).toContain('<array>');
      expect(content).toContain('<string>/usr/local/bin/node</string>');
      expect(content).toContain('<string>start</string>');
      // CLI entry path should be present
      expect(content).toContain(launchd.CLI_ENTRY);
    });

    it('should set RunAtLoad to true', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>RunAtLoad</key>');
      expect(content).toContain('<true/>');
    });

    it('should set KeepAlive to true', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>KeepAlive</key>');
      expect(content).toContain('<true/>');
    });

    it('should set WorkingDirectory to project root', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>WorkingDirectory</key>');
      expect(content).toContain(`<string>${launchd.PROJECT_ROOT}</string>`);
    });

    it('should set StandardOutPath and StandardErrorPath', () => {
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>StandardOutPath</key>');
      expect(content).toContain('<string>/tmp/disclaude-stdout.log</string>');
      expect(content).toContain('<key>StandardErrorPath</key>');
      expect(content).toContain('<string>/tmp/disclaude-stderr.log</string>');
    });

    it('should include environment variables (PATH, HOME, NODE_ENV)', () => {
      const originalPath = process.env.PATH;
      process.env.PATH = '/usr/bin:/usr/local/bin';
      try {
        launchd.generatePlist();
      } finally {
        process.env.PATH = originalPath;
      }
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<key>EnvironmentVariables</key>');
      expect(content).toContain('<key>PATH</key>');
      expect(content).toContain('<string>/usr/bin:/usr/local/bin</string>');
      expect(content).toContain('<key>HOME</key>');
      expect(content).toContain('<string>/home/testuser</string>');
      expect(content).toContain('<key>NODE_ENV</key>');
      expect(content).toContain('<string>production</string>');
    });

    it('should call ensureLaunchAgentsDir before writing', () => {
      mockExistsSync.mockReturnValue(false);
      launchd.generatePlist();

      // Directory was checked and created
      expect(mockExistsSync).toHaveBeenCalledWith(
        '/home/testuser/Library/LaunchAgents',
      );
      expect(mockMkdirSync).toHaveBeenCalledWith(
        '/home/testuser/Library/LaunchAgents',
        { recursive: true },
      );
    });

    it('should log generation details to console', () => {
      launchd.generatePlist();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Plist generated'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Node:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Entry:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('CWD:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Stdout:'),
      );
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Stderr:'),
      );
    });

    it('should use the node path from getNodePath', () => {
      mockExecSync.mockReturnValue('/custom/node/path\n');
      launchd.generatePlist();
      const content = mockWriteFileSync.mock.calls[0][1];

      expect(content).toContain('<string>/custom/node/path</string>');
    });
  });
});
