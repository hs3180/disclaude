/**
 * Tests for WeChat DevTools CLI wrapper.
 *
 * Tests CLI path discovery, command execution, and error handling.
 * Uses mock execFile to avoid needing actual WeChat DevTools installed.
 *
 * @module wechat-devtools/cli.test
 * @see Issue #3442 - WorkBuddy remote control for WeChat mini programs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Mock node:child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  discoverCliPath,
  WeChatDevToolsCli,
  isWeChatDevToolsAvailable,
} from './cli.js';
import {
  WeChatDevToolsNotFoundError,
  WeChatDevToolsCliError,
} from './types.js';

const mockExecFile = vi.mocked(execFile);

// Helper to create a successful execFile result
function mockSuccess(stdout = '', stderr = '') {
  return { stdout, stderr };
}

// Helper to create a failed execFile result
function mockError(code: number | string, stderr = '', stdout = '') {
  const err = new Error(`Command failed: cli ${code}`);
  (err as any).code = typeof code === 'number' ? code : undefined;
  (err as any).killed = false;
  (err as any).stdout = stdout;
  (err as any).stderr = stderr;
  return err;
}

describe('discoverCliPath', () => {
  let tmpDir: string;
  let fakeCliPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-devtools-test-'));
    fakeCliPath = path.join(tmpDir, 'cli');
    // Create a fake CLI binary
    fs.writeFileSync(fakeCliPath, '#!/bin/bash\necho "mock"', { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.WECHAT_DEVTOOLS_PATH;
  });

  it('should use explicit config.cliPath when file exists', () => {
    const result = discoverCliPath({ cliPath: fakeCliPath });
    expect(result).toBe(path.resolve(fakeCliPath));
  });

  it('should throw WeChatDevToolsNotFoundError when config.cliPath does not exist', () => {
    expect(() => discoverCliPath({ cliPath: '/nonexistent/cli' }))
      .toThrow(WeChatDevToolsNotFoundError);
  });

  it('should fall back to WECHAT_DEVTOOLS_PATH env var', () => {
    process.env.WECHAT_DEVTOOLS_PATH = fakeCliPath;
    const result = discoverCliPath();
    expect(result).toBe(path.resolve(fakeCliPath));
  });

  it('should prefer config.cliPath over env var', () => {
    process.env.WECHAT_DEVTOOLS_PATH = '/nonexistent/env/cli';
    const result = discoverCliPath({ cliPath: fakeCliPath });
    expect(result).toBe(path.resolve(fakeCliPath));
  });

  it('should throw when CLI not found anywhere', () => {
    // No config, no env, and platform defaults won't exist on CI
    delete process.env.WECHAT_DEVTOOLS_PATH;
    expect(() => discoverCliPath()).toThrow(WeChatDevToolsNotFoundError);
  });
});

describe('isWeChatDevToolsAvailable', () => {
  afterEach(() => {
    delete process.env.WECHAT_DEVTOOLS_PATH;
  });

  it('should return false when CLI is not found', () => {
    delete process.env.WECHAT_DEVTOOLS_PATH;
    expect(isWeChatDevToolsAvailable()).toBe(false);
  });

  it('should return true when CLI exists at env path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-test-'));
    const cliPath = path.join(tmpDir, 'cli');
    fs.writeFileSync(cliPath, 'mock');
    process.env.WECHAT_DEVTOOLS_PATH = cliPath;

    expect(isWeChatDevToolsAvailable()).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('WeChatDevToolsCli', () => {
  let tmpDir: string;
  let fakeCliPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cli-test-'));
    fakeCliPath = path.join(tmpDir, 'cli');
    fs.writeFileSync(fakeCliPath, 'mock', { mode: 0o755 });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createCli(config?: { projectPath?: string }) {
    return new WeChatDevToolsCli({
      cliPath: fakeCliPath,
      projectPath: config?.projectPath,
    });
  }

  describe('constructor', () => {
    it('should resolve CLI path from config', () => {
      const cli = createCli();
      expect(cli.getCliPath()).toBe(path.resolve(fakeCliPath));
    });

    it('should throw when CLI not found', () => {
      expect(() => new WeChatDevToolsCli({ cliPath: '/nonexistent' }))
        .toThrow(WeChatDevToolsNotFoundError);
    });
  });

  describe('preview', () => {
    it('should execute preview command with project path', async () => {
      const projectPath = '/tmp/my-miniprogram';
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('preview');
        expect(args).toContain('--project');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli({ projectPath });
      const result = await cli.preview();

      expect(result.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalledOnce();
    });

    it('should include QR output path when specified', async () => {
      const qrOutput = '/tmp/qr.png';
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args).toContain('--qr-output');
        const idx = args.indexOf('--qr-output');
        expect(args[idx + 1]).toBe(path.resolve(qrOutput));
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.preview({ qrOutput });

      expect(result.qrImagePath).toBe(path.resolve(qrOutput));
    });

    it('should include compile condition when specified', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args).toContain('--compile-condition');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      await cli.preview({ compileCondition: '{"pathName":"pages/index"}' });

      expect(mockExecFile).toHaveBeenCalledOnce();
    });

    it('should handle CLI failure gracefully', async () => {
      mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(mockError(1, 'project not found'));
      }) as any);

      const cli = createCli();
      const result = await cli.preview();

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.error).toContain('project not found');
    });

    it('should handle timeout', async () => {
      mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: any) => {
        const err = new Error('Timed out');
        (err as any).killed = true;
        cb(err);
      }) as any);

      const cli = createCli();
      const result = await cli.preview();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });

  describe('upload', () => {
    it('should execute upload with version and desc', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('upload');
        expect(args).toContain('-v');
        const vIdx = args.indexOf('-v');
        expect(args[vIdx + 1]).toBe('1.0.0');
        expect(args).toContain('-d');
        const dIdx = args.indexOf('-d');
        expect(args[dIdx + 1]).toBe('Test upload');
        cb(null, mockSuccess('upload success'));
      }) as any);

      const cli = createCli();
      const result = await cli.upload({ version: '1.0.0', desc: 'Test upload' });

      expect(result.success).toBe(true);
      expect(result.version).toBe('1.0.0');
    });

    it('should work without version and desc', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args).not.toContain('-v');
        expect(args).not.toContain('-d');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.upload();

      expect(result.success).toBe(true);
    });
  });

  describe('open', () => {
    it('should execute open command', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('open');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.open();

      expect(result.success).toBe(true);
    });

    it('should pass --enable-debug flag when requested', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args).toContain('--enable-debug');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      await cli.open({ enableDebug: true });

      expect(mockExecFile).toHaveBeenCalledOnce();
    });
  });

  describe('close', () => {
    it('should execute close command', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('close');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.close();

      expect(result.success).toBe(true);
    });
  });

  describe('buildNpm', () => {
    it('should execute build-npm command', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('build-npm');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.buildNpm();

      expect(result.success).toBe(true);
    });
  });

  describe('cache', () => {
    it('should execute cache clean command', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args[0]).toBe('cache');
        expect(args).toContain('--operation');
        expect(args).toContain('clean');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      const result = await cli.cache({ operation: 'clean' });

      expect(result.success).toBe(true);
    });
  });

  describe('extraArgs', () => {
    it('should pass extra arguments to all commands', async () => {
      mockExecFile.mockImplementation(((_cmd: string, args: string[], _opts: any, cb: any) => {
        expect(args).toContain('--test-flag');
        cb(null, mockSuccess());
      }) as any);

      const cli = createCli();
      await cli.preview({ extraArgs: ['--test-flag'] });

      expect(mockExecFile).toHaveBeenCalledOnce();
    });
  });
});

describe('WeChatDevToolsNotFoundError', () => {
  it('should have correct name property', () => {
    const err = new WeChatDevToolsNotFoundError('not found');
    expect(err.name).toBe('WeChatDevToolsNotFoundError');
    expect(err.message).toContain('not found');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('WeChatDevToolsCliError', () => {
  it('should have correct properties', () => {
    const err = new WeChatDevToolsCliError('preview', 1, 'error output');
    expect(err.name).toBe('WeChatDevToolsCliError');
    expect(err.command).toBe('preview');
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe('error output');
    expect(err).toBeInstanceOf(Error);
  });
});
