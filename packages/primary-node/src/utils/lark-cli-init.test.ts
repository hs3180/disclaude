import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock fs before importing the module under test
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { initLarkCliAuth } from './lark-cli-init.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

const configDir = path.join(os.homedir(), '.lark-cli');
const configFile = path.join(configDir, 'config.json');

describe('initLarkCliAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip when appId is empty', () => {
    initLarkCliAuth('', 'secret', mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Feishu appId/appSecret not configured — skipping lark-cli auth init',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('should skip when appSecret is empty', () => {
    initLarkCliAuth('app123', '', mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Feishu appId/appSecret not configured — skipping lark-cli auth init',
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('should skip when lark-cli binary is not found', () => {
    (execFileSync as any).mockImplementation(() => {
      throw new Error('not found');
    });

    initLarkCliAuth('app123', 'secret', mockLogger);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'lark-cli binary not found — skipping auth init',
    );
  });

  it('should skip when already configured with matching appId', () => {
    (execFileSync as any).mockImplementation((_bin: string, args: string[]) => {
      if (args?.[0] === '--version') {return '1.0.0';}
      return '';
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({ appId: 'app123' }));

    initLarkCliAuth('app123', 'secret', mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      { configPath: configFile },
      'lark-cli already configured with matching appId — skipping',
    );
  });

  it('should run config init when appId differs', () => {
    (execFileSync as any).mockImplementation((_bin: string, args: string[]) => {
      if (args?.[0] === '--version') {return '1.0.0';}
      if (args?.[0] === 'config') {return '';}
      return '';
    });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(JSON.stringify({ appId: 'different-app' }));

    initLarkCliAuth('app123', 'secret', mockLogger);

    expect(mockLogger.info).toHaveBeenCalledWith(
      { appId: 'app123' },
      'lark-cli auth configured successfully',
    );

    // Verify config init was called with correct args
    const initCall = (execFileSync as any).mock.calls.find(
      (c: any[]) => Array.isArray(c[1]) && c[1][0] === 'config',
    );
    expect(initCall).toBeDefined();
    expect(initCall[1]).toEqual(['config', 'init', '--app-id', 'app123', '--app-secret-stdin']);
    expect(initCall[2].input).toBe('secret');
  });

  it('should handle config init failure gracefully', () => {
    (execFileSync as any).mockImplementation((_bin: string, args: string[]) => {
      if (args?.[0] === '--version') {return '1.0.0';}
      if (args?.[0] === 'config') {
        const err = new Error('init failed');
        (err as any).stderr = 'config error';
        throw err;
      }
      return '';
    });
    (fs.existsSync as any).mockReturnValue(false);

    initLarkCliAuth('app123', 'secret', mockLogger);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stderr: 'config error' }),
      'lark-cli config init failed — skills using lark-cli may not work',
    );
  });
});
